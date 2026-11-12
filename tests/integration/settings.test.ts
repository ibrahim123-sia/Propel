import { beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditLog, secrets } from "@/db/schema/system";
import { saveSettings, patchSettings } from "@/features/settings/mutations";
import { loadSettings } from "@/features/settings/queries";
import { defaultsFor } from "@/features/settings/schema";
import { getSecret, listSecretStatus, setSecret } from "@/features/settings/secrets";
import { newId } from "@/lib/ids";
import { truncate } from "../helpers/db";

const admin = { type: "admin" as const, id: newId() };

describe("settings storage", () => {
  beforeEach(async () => {
    await truncate("settings", "secrets", "audit_log");
  });

  it("returns defaults before anything is saved", async () => {
    expect(await loadSettings("branding")).toEqual(defaultsFor("branding"));
  });

  it("saves a group and audits only the changed keys", async () => {
    const db = await getDb();
    const branding = defaultsFor("branding");
    await db.transaction(async (tx) => {
      await saveSettings(
        tx,
        "branding",
        { ...branding, colors: { ...branding.colors, accent: "#8A3F24" } },
        admin,
      );
    });

    const stored = await loadSettings("branding");
    expect(stored.colors.accent).toBe("#8A3F24");
    expect(stored.colors.bg).toBe(branding.colors.bg);

    const [entry] = await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(1);
    expect(entry).toMatchObject({
      actorType: "admin",
      actorId: admin.id,
      action: "settings.update",
      entityType: "settings",
      entityId: "branding",
      before: { colors: { accent: "#A9502F" } },
      after: { colors: { accent: "#8A3F24" } },
    });
  });

  it("does not write an audit entry when nothing changed", async () => {
    const db = await getDb();
    await patchSettings(db, "general", { agencyName: "Haven & Dune" }, admin);
    await patchSettings(db, "general", { agencyName: "Haven & Dune" }, admin);
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, "general"));
    expect(rows).toHaveLength(1);
  });

  it("rolls back the change and the audit entry together", async () => {
    const db = await getDb();
    await expect(
      db.transaction(async (tx) => {
        await patchSettings(tx, "general", { agencyName: "Will not stick" }, admin);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await loadSettings("general")).agencyName).toBe(defaultsFor("general").agencyName);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });
});

describe("encrypted secrets", () => {
  beforeEach(async () => {
    await truncate("secrets", "audit_log");
  });

  it("stores ciphertext, decrypts on read and masks for display", async () => {
    const db = await getDb();
    await setSecret(db, "whatsapp_access_token", "wa_test_1234567890abcd", { ...admin });
    const [row] = await db.select().from(secrets);
    expect(row!.encryptedValue).not.toContain("wa_test");
    expect(await getSecret("whatsapp_access_token")).toBe("wa_test_1234567890abcd");

    const status = await listSecretStatus();
    const token = status.find((s) => s.key === "whatsapp_access_token")!;
    expect(token).toMatchObject({ isSet: true, masked: "••••••••abcd" });
    expect(status.find((s) => s.key === "ai_api_key")!.isSet).toBe(false);

    const [entry] = await db.select().from(auditLog);
    expect(JSON.stringify(entry)).not.toContain("wa_test");
  });

  it("keeps the audit log append-only", async () => {
    const db = await getDb();
    await setSecret(db, "ai_api_key", "sk-ant-xxxxxxxxxxxxxxxx", admin);
    // Drizzle wraps driver errors ("Failed query: ..."); the database reason is in `cause`.
    const reason = (p: Promise<unknown>) =>
      p.then(
        () => "no error",
        (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
      );
    expect(await reason(db.delete(auditLog))).toMatch(/append-only \(DELETE blocked\)/);
    expect(await reason(db.update(auditLog).set({ action: "tampered" }))).toMatch(
      /append-only \(UPDATE blocked\)/,
    );
    // The connection is still healthy after those errors.
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });
});
