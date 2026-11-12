import { createServer, type Server } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { emailLog } from "@/db/schema/system";
import { testEmail } from "@/features/integrations/checks";
import { queueEmail } from "@/features/notifications/email";
import { patchSettings } from "@/features/settings/mutations";
import { runDueJobs } from "@/jobs/runner";
import { resetEnvCache } from "@/lib/env";
import { testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

/** A tiny SMTP server: accepts one login, records what each session sent. */
type Session = { auth: string | null; from: string; to: string[]; data: string };
const sessions: Session[] = [];
let server: Server;
let port = 0;

function startServer(): Promise<void> {
  server = createServer((socket) => {
    const s: Session = { auth: null, from: "", to: [], data: "" };
    sessions.push(s);
    let inData = false;
    let buffer = "";
    socket.write("220 test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) return;
        s.data = buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;
        socket.write("250 queued as test-1\r\n");
      }
      let at: number;
      while (!inData && (at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (line.startsWith("EHLO")) socket.write("250-test\r\n250 AUTH PLAIN\r\n");
        else if (line.startsWith("AUTH PLAIN ")) {
          s.auth = Buffer.from(line.slice(11), "base64").toString("utf8");
          socket.write(
            s.auth === "\0agency@example.com\0app-pass"
              ? "235 ok\r\n"
              : "535 5.7.8 Username and Password not accepted\r\n",
          );
        } else if (line.startsWith("MAIL FROM:")) {
          s.from = line.slice(10);
          socket.write("250 ok\r\n");
        } else if (line.startsWith("RCPT TO:")) {
          s.to.push(line.slice(8));
          socket.write("250 ok\r\n");
        } else if (line === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (line === "QUIT") {
          socket.end("221 bye\r\n");
        } else socket.write("500 what\r\n");
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    }),
  );
}

function useServer(password = "app-pass") {
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(port);
  process.env.SMTP_USER = "agency@example.com";
  process.env.SMTP_PASSWORD = password;
  resetEnvCache();
}

const decode = (data: string, type: string) => {
  const part = data.split(`Content-Type: ${type}; charset=UTF-8`)[1]!;
  const body = part.split("\r\n\r\n")[1]!.split("\r\n--")[0]!;
  return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
};

describe("email over SMTP", () => {
  beforeAll(startServer);
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(async () => {
    sessions.length = 0;
    await truncate("email_log", "job_runs", "settings");
  });
  afterEach(() => {
    for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"]) delete process.env[k];
    resetEnvCache();
  });

  it("sends through the server with the agency name, reply-to and extra headers", async () => {
    useServer();
    const db = await getDb();
    await patchSettings(
      db,
      "integrations",
      { email: { fromName: "Haven & Dune", replyTo: "team@example.com" } },
      { type: "admin", id: testAdmin.id },
    );
    const id = await queueEmail(
      {
        to: "buyer@example.com",
        subject: "Price drop: Marina — 2 beds",
        template: "alerts.price_drop",
        html: "<p>Now <b>AED 1.9M</b></p>",
        text: "Now AED 1.9M",
        headers: { "List-Unsubscribe": "<https://example.com/u/1>" },
      },
      db,
    );
    await runDueJobs();

    const [row] = await db.select().from(emailLog).where(eq(emailLog.id, id));
    expect(row).toMatchObject({
      status: "sent",
      provider: "smtp",
      providerId: `<${id}@example.com>`,
    });
    const s = sessions[0]!;
    expect(s).toMatchObject({ from: "<agency@example.com>", to: ["<buyer@example.com>"] });
    expect(s.data).toContain('From: "Haven & Dune" <agency@example.com>');
    expect(s.data).toContain("Reply-To: team@example.com");
    expect(s.data).toContain("List-Unsubscribe: <https://example.com/u/1>");
    // Non-ASCII subjects are encoded (RFC 2047).
    expect(s.data).toContain(
      `Subject: =?UTF-8?B?${Buffer.from("Price drop: Marina — 2 beds").toString("base64")}?=`,
    );
    expect(decode(s.data, "text/plain")).toBe("Now AED 1.9M");
    expect(decode(s.data, "text/html")).toBe("<p>Now <b>AED 1.9M</b></p>");
  });

  it("keeps emails in the log when no server is set, and reports a refused login", async () => {
    const db = await getDb();
    const id = await queueEmail(
      { to: "a@example.com", subject: "Hi", template: "t", html: "<p>Hi</p>", text: "Hi" },
      db,
    );
    await runDueJobs();
    const [row] = await db.select().from(emailLog).where(eq(emailLog.id, id));
    expect(row).toMatchObject({ status: "mocked", provider: "mock" });
    expect(sessions).toHaveLength(0);
    expect(await testEmail()).toMatchObject({ ok: false });

    useServer();
    expect(await testEmail()).toEqual({
      ok: true,
      message: "Connected to 127.0.0.1 as agency@example.com",
    });
    useServer("wrong");
    expect(await testEmail()).toEqual({
      ok: false,
      message: "The mail server refused the user name or password.",
    });
  });
});
