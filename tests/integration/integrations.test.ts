import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { auditLog, secrets } from "@/db/schema/system";
import {
  generateIntegrationKey,
  removeIntegrationKey,
  saveIntegrationKey,
  testIntegration,
} from "@/features/integrations/actions";
import { patchSettings } from "@/features/settings/mutations";
import { loadSettings } from "@/features/settings/queries";
import { getSecret } from "@/features/settings/secrets";
import { adminState, testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const actor = { type: "admin" as const, id: testAdmin.id };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("integration keys and connection tests", () => {
  beforeEach(async () => {
    adminState.user = testAdmin;
    adminState.signedInAt = undefined;
    await truncate("secrets", "settings", "audit_log");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("stores keys encrypted, shows them masked and never logs them", async () => {
    const res = await saveIntegrationKey({
      key: "resend_api_key",
      value: "re_live_abcdefgh12345678",
    });
    expect(res).toMatchObject({ ok: true, data: { key: "resend_api_key", isSet: true } });
    if (!res.ok) return;
    expect(res.data.masked).toBe("••••••••5678");
    const db = await getDb();
    const [row] = await db.select().from(secrets);
    expect(row!.encryptedValue).not.toContain("abcdefgh");
    expect(await getSecret("resend_api_key")).toBe("re_live_abcdefgh12345678");
    const audit = await db.select().from(auditLog);
    expect(JSON.stringify(audit)).not.toContain("abcdefgh");

    expect(await removeIntegrationKey({ key: "resend_api_key" })).toMatchObject({
      ok: true,
      data: { isSet: false },
    });
    expect(await getSecret("resend_api_key")).toBeNull();
  });

  it("changing keys needs a recent sign-in", async () => {
    adminState.signedInAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const res = await saveIntegrationKey({ key: "ai_api_key", value: "sk-test" });
    expect(res).toMatchObject({ ok: false, code: "REAUTH_REQUIRED" });
    expect(await getSecret("ai_api_key")).toBeNull();
  });

  it("generates webhook tokens and shows them once", async () => {
    const res = await generateIntegrationKey({ key: "whatsapp_verify_token" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.value).toMatch(/^[a-z0-9]{40}$/);
    expect(res.data.status.masked).toBe(`••••••••${res.data.value.slice(-4)}`);
    expect(await getSecret("whatsapp_verify_token")).toBe(res.data.value);
  });

  it("tests Resend: connected, sending-only key, and a failure kept as the last error", async () => {
    expect(await testIntegration({ name: "resend" })).toMatchObject({
      ok: true,
      data: { ok: false, message: "Add the key first." },
    });
    await saveIntegrationKey({ key: "resend_api_key", value: "re_test_key_0001" });

    const fetchMock = vi.fn().mockResolvedValue(json(200, { data: [{ name: "agency.example" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const ok = await testIntegration({ name: "resend" });
    expect(ok).toMatchObject({
      ok: true,
      data: { ok: true, message: "Connected (1 sending domain)" },
    });
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe("Bearer re_test_key_0001");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(401, {
          name: "restricted_api_key",
          message: "This API key is restricted to only send emails",
        }),
      ),
    );
    expect(await testIntegration({ name: "resend" })).toMatchObject({
      data: { ok: true, message: "Connected (sending-only key)" },
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(403, { message: "API key is invalid" })));
    const bad = await testIntegration({ name: "resend" });
    expect(bad).toMatchObject({
      ok: true,
      data: { ok: false, message: "Resend answered 403: API key is invalid" },
    });
    if (bad.ok) {
      const key = bad.data.status.find((s) => s.key === "resend_api_key")!;
      expect(key.lastError).toBe("Resend answered 403: API key is invalid");
      expect(key.lastTestedAt).not.toBeNull();
    }
  });

  it("tests WhatsApp against the configured phone number", async () => {
    const db = await getDb();
    const missing = await testIntegration({ name: "whatsapp" });
    expect(missing).toMatchObject({
      data: { ok: false, message: "Enter the phone number ID first." },
    });

    const integrations = await loadSettings("integrations", db);
    await patchSettings(
      db,
      "integrations",
      { whatsapp: { ...integrations.whatsapp, phoneNumberId: "1234567890" } },
      actor,
    );
    await saveIntegrationKey({ key: "whatsapp_access_token", value: "EAAG-token" });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        json(200, { display_phone_number: "+44 20 7946 0000", verified_name: "Haven & Dune" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const res = await testIntegration({ name: "whatsapp" });
    expect(res).toMatchObject({
      data: { ok: true, message: "Connected: +44 20 7946 0000 (Haven & Dune)" },
    });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/v23.0/1234567890?");
  });

  it("tests the AI provider: test provider needs no key, a missing model is reported", async () => {
    expect(await testIntegration({ name: "ai" })).toMatchObject({ data: { ok: true } });
    const db = await getDb();
    const integrations = await loadSettings("integrations", db);
    await patchSettings(
      db,
      "integrations",
      {
        ai: {
          ...integrations.ai,
          provider: "anthropic",
          chatModel: "claude-x",
          fastModel: "claude-y",
        },
      },
      actor,
    );
    await saveIntegrationKey({ key: "ai_api_key", value: "sk-ant-test" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(200, { data: [{ id: "claude-x" }] })));
    expect(await testIntegration({ name: "ai" })).toMatchObject({
      data: {
        ok: false,
        message: "Anthropic (Claude): connected, but these models are not available: claude-y",
      },
    });
  });

  it("tests Grok and the Gemini backup, each with its own key and model list", async () => {
    const db = await getDb();
    const integrations = await loadSettings("integrations", db);
    await patchSettings(
      db,
      "integrations",
      {
        ai: {
          ...integrations.ai,
          provider: "xai",
          chatModel: "grok-4.7",
          fastModel: "grok-4.20-0309-non-reasoning",
          fallbackProvider: "gemini",
          fallbackChatModel: "gemini-3.8-flash",
          fallbackFastModel: "gemini-3.5-flash-lite",
        },
      },
      actor,
    );
    await saveIntegrationKey({ key: "ai_api_key", value: "xai-test" });
    await saveIntegrationKey({ key: "ai_fallback_api_key", value: "gemini-test" });
    const fetchMock = vi.fn(async (url: string) =>
      String(url).startsWith("https://api.x.ai/")
        ? json(200, { data: [{ id: "grok-4.7" }, { id: "grok-4.20-0309-non-reasoning" }] })
        : json(200, {
            models: [{ name: "models/gemini-3.8-flash" }, { name: "models/gemini-2.5-pro" }],
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await testIntegration({ name: "ai" })).toMatchObject({
      data: {
        ok: false,
        message:
          "xAI (Grok): connected. Backup: Google (Gemini): connected, but these models are not available: gemini-3.5-flash-lite",
      },
    });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe("https://api.x.ai/v1/models");
    expect((calls[0]![1].headers as Record<string, string>).authorization).toBe("Bearer xai-test");
    expect(calls[1]![0]).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models/);
    expect((calls[1]![1].headers as Record<string, string>)["x-goog-api-key"]).toBe("gemini-test");
  });
});
