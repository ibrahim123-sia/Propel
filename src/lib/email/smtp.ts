import { connect as plainConnect, type Socket } from "node:net";
import { connect } from "node:tls";

/**
 * A small SMTP client over implicit TLS (port 465, as Gmail offers it). `node:tls` exists in
 * Node and in Workers (nodejs_compat), so one client serves the dev server, tests and
 * production. It sends one message per connection: the email job runs one email at a time.
 * A server on this machine (a local mail catcher, the tests) is reached without TLS.
 */

export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
};

export type SmtpMessage = {
  /** `Name <address>`; the envelope sender is `fromAddress`. */
  from: string;
  fromAddress: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  headers?: Record<string, string> | null;
  /** Stable id (the email log id), so a retried send keeps the same Message-ID. */
  id: string;
};

const TIMEOUT_MS = 20_000;

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

/** One SMTP session: write a command, read the (possibly multi-line) reply. */
async function session<T>(
  config: SmtpConfig,
  run: (cmd: (line: string | null, expect: number[]) => Promise<string>) => Promise<T>,
): Promise<T> {
  const local = config.host === "localhost" || config.host === "127.0.0.1";
  const socket: Socket = local
    ? plainConnect({ host: config.host, port: config.port })
    : connect({ host: config.host, port: config.port, servername: config.host });
  socket.setEncoding("utf8");
  let buffer = "";
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    notify();
  });
  socket.on("error", (err) => {
    failure = err;
    notify();
  });
  socket.on("close", () => {
    failure ??= new SmtpError("The mail server closed the connection.");
    notify();
  });
  socket.setTimeout(TIMEOUT_MS, () => {
    failure = new SmtpError(`No answer from ${config.host} within ${TIMEOUT_MS / 1000} seconds.`);
    socket.destroy();
    notify();
  });

  /** A reply is complete when its last line reads "NNN text" (not "NNN-text"). */
  async function reply(): Promise<{ code: number; text: string }> {
    for (;;) {
      const lines = buffer.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]!) || /^\d{3}$/.test(lines[i]!)) {
          const text = lines.slice(0, i + 1).join("\n");
          buffer = lines.slice(i + 1).join("\r\n");
          return { code: Number(lines[i]!.slice(0, 3)), text };
        }
      }
      if (failure) throw failure;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  const cmd = async (line: string | null, expect: number[]) => {
    if (line !== null) socket.write(`${line}\r\n`);
    const { code, text } = await reply();
    if (!expect.includes(code)) {
      // Never echo the password: AUTH lines are not part of the message.
      throw new SmtpError(
        `The mail server answered ${text.replace(/\n/g, " ").slice(0, 300)}`,
        code,
      );
    }
    return text;
  };

  try {
    await cmd(null, [220]);
    await cmd("EHLO propel", [250]);
    const auth = Buffer.from(`\0${config.user}\0${config.password}`).toString("base64");
    await cmd(`AUTH PLAIN ${auth}`, [235]).catch((err: unknown) => {
      if (err instanceof SmtpError && err.code === 535)
        throw new SmtpError("The mail server refused the user name or password.", 535);
      throw err;
    });
    const out = await run(cmd);
    await cmd("QUIT", [221]).catch(() => undefined);
    return out;
  } finally {
    socket.destroy();
  }
}

/** Checks that the server answers and accepts the login, without sending anything. */
export async function verifySmtp(config: SmtpConfig): Promise<void> {
  await session(config, async () => undefined);
}

/** Sends one message. Returns its Message-ID. */
export async function sendSmtp(config: SmtpConfig, message: SmtpMessage): Promise<string> {
  const domain = message.fromAddress.split("@")[1] ?? "propel";
  const messageId = `<${message.id}@${domain}>`;
  const body = buildMessage(message, messageId);
  await session(config, async (cmd) => {
    await cmd(`MAIL FROM:<${message.fromAddress}>`, [250]);
    await cmd(`RCPT TO:<${message.to}>`, [250, 251]);
    await cmd("DATA", [354]);
    await cmd(`${body}\r\n.`, [250]);
  });
  return messageId;
}

/* MIME ------------------------------------------------------------------ */

const noBreaks = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

/** RFC 2047 for header text that is not plain ASCII. */
function encodeWord(value: string): string {
  const clean = noBreaks(value);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean).toString("base64")}?=`;
}

/** `Name <address>` with the name encoded or quoted as needed. */
function encodeAddress(value: string): string {
  const match = /^(.*)<([^>]+)>\s*$/.exec(noBreaks(value));
  if (!match) return noBreaks(value);
  const name = match[1]!.trim().replace(/^"|"$/g, "");
  if (!name) return `<${match[2]}>`;
  const word = encodeWord(name);
  return `${word === name ? `"${name.replace(/["\\]/g, "")}"` : word} <${match[2]}>`;
}

const base64Lines = (text: string) =>
  Buffer.from(text)
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n")
    .trimEnd();

export function buildMessage(message: SmtpMessage, messageId: string): string {
  const boundary = `propel-${message.id}`;
  const headers: string[] = [
    `From: ${encodeAddress(message.from)}`,
    `To: ${noBreaks(message.to)}`,
    `Subject: ${encodeWord(message.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
  ];
  if (message.replyTo) headers.push(`Reply-To: ${encodeAddress(message.replyTo)}`);
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (/^[A-Za-z0-9-]+$/.test(name)) headers.push(`${name}: ${noBreaks(value)}`);
  }
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const part = (type: string, content: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset=UTF-8`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(content),
    ].join("\r\n");
  // Base64 lines never start with ".", so the body needs no dot-stuffing.
  return [
    ...headers,
    "",
    part("text/plain", message.text),
    part("text/html", message.html),
    `--${boundary}--`,
  ].join("\r\n");
}
