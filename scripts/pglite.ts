import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { vector } from "@electric-sql/pglite-pgvector";
import { postgis } from "@electric-sql/pglite-postgis";

/**
 * Local PostgreSQL 18 (PGlite, WASM) with the same extensions as production on Neon,
 * exposed over the Postgres wire protocol so the app uses the normal `pg` driver.
 *
 * Why not @electric-sql/pglite-socket: PGlite's single-user backend answers an error in an
 * extended-protocol message (Parse/Bind/Execute) with an extra ReadyForQuery. The socket
 * server forwards it, the client then attributes every later response to the wrong query
 * (silently wrong results after e.g. a unique violation). This bridge implements the
 * protocol rules itself:
 *   - client messages are buffered until Sync / Query / Flush and run as one batch;
 *   - after an ErrorResponse the rest of the batch is skipped until Sync ("ignore till sync");
 *   - ReadyForQuery is only forwarded for Sync and simple Query, never mid-batch;
 *   - the session is handed to one connection while it is inside a transaction
 *     (tracked from the ReadyForQuery status byte), other connections wait.
 */

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;

const MSG_SYNC = 0x53; // 'S'
const MSG_QUERY = 0x51; // 'Q'
const MSG_FLUSH = 0x48; // 'H'
const MSG_TERMINATE = 0x58; // 'X'
const BE_READY = 0x5a; // 'Z'
const BE_ERROR = 0x45; // 'E'

type Conn = {
  id: number;
  socket: Socket;
  buf: Buffer;
  started: boolean;
  pending: Buffer[];
  closed: boolean;
};

type Batch = { conn: Conn; messages: Buffer[]; startup: boolean };

export const pgliteExtensions = { postgis, vector, pg_trgm, unaccent };

export async function createPglite(
  options: { dataDir?: string; loadDataDir?: Blob } = {},
): Promise<PGlite> {
  return PGlite.create({
    dataDir: options.dataDir,
    loadDataDir: options.loadDataDir,
    extensions: pgliteExtensions,
  });
}

export class PgliteWireServer {
  private server: Server | null = null;
  private queue: Batch[] = [];
  private owner: Conn | null = null;
  private running = false;
  private nextId = 1;
  private conns = new Set<Conn>();

  constructor(private readonly db: PGlite) {}

  /** Starts listening; port 0 picks a free port. Returns the bound port. */
  async listen(port: number, host = "127.0.0.1"): Promise<number> {
    await this.db.waitReady;
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => resolve());
    });
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const conn of this.conns) conn.socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(socket: Socket) {
    socket.setNoDelay(true);
    const conn: Conn = {
      id: this.nextId++,
      socket,
      buf: Buffer.alloc(0),
      started: false,
      pending: [],
      closed: false,
    };
    this.conns.add(conn);
    // No encoding is set on the socket, so data always arrives as a Buffer.
    socket.on("data", (chunk) => this.onData(conn, chunk as Buffer));
    socket.on("error", () => this.onClose(conn));
    socket.on("close", () => this.onClose(conn));
  }

  private onData(conn: Conn, chunk: Buffer) {
    conn.buf = conn.buf.length ? Buffer.concat([conn.buf, chunk]) : chunk;
    for (;;) {
      if (!conn.started) {
        if (conn.buf.length < 8) return;
        const len = conn.buf.readInt32BE(0);
        if (conn.buf.length < len) return;
        const code = conn.buf.readInt32BE(4);
        const msg = Buffer.from(conn.buf.subarray(0, len));
        conn.buf = conn.buf.subarray(len);
        if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
          conn.socket.write("N");
          continue;
        }
        if (code === CANCEL_REQUEST) {
          conn.socket.end();
          return;
        }
        conn.started = true;
        this.enqueue({ conn, messages: [msg], startup: true });
        continue;
      }
      if (conn.buf.length < 5) return;
      const type = conn.buf[0]!;
      const len = conn.buf.readInt32BE(1);
      if (conn.buf.length < len + 1) return;
      const msg = Buffer.from(conn.buf.subarray(0, len + 1));
      conn.buf = conn.buf.subarray(len + 1);
      if (type === MSG_TERMINATE) {
        conn.socket.end();
        this.onClose(conn);
        return;
      }
      conn.pending.push(msg);
      if (type === MSG_SYNC || type === MSG_QUERY || type === MSG_FLUSH) {
        const messages = conn.pending;
        conn.pending = [];
        this.enqueue({ conn, messages, startup: false });
      }
    }
  }

  private onClose(conn: Conn) {
    if (conn.closed) return;
    conn.closed = true;
    this.conns.delete(conn);
    this.queue = this.queue.filter((b) => b.conn !== conn);
    if (this.owner === conn) {
      // The client went away inside a transaction: roll it back and free the session.
      this.owner = null;
      void this.db
        .runExclusive(() => this.runMessage(Buffer.from(simpleQuery("ROLLBACK"))))
        .catch(() => undefined)
        .finally(() => void this.pump());
    }
  }

  private enqueue(batch: Batch) {
    this.queue.push(batch);
    void this.pump();
    if (this.owner && batch.conn !== this.owner) this.watchForDeadlock(batch);
  }

  /**
   * One connection holds a transaction and another waits: fine for a moment, but if it lasts,
   * the code probably queries through a second connection inside a transaction (use the
   * transaction handle instead). Real Postgres would not block here, so say it loudly.
   */
  private watchForDeadlock(batch: Batch) {
    setTimeout(() => {
      if (this.queue.includes(batch) && this.owner && this.owner !== batch.conn) {
        console.warn(
          "[db] a query has waited 5 s for another connection's open transaction. " +
            "Is code inside db.transaction() using getDb() instead of `tx`?",
        );
      }
    }, 5000).unref();
  }

  /** Index of the next batch allowed to run: the transaction owner's, or the oldest one. */
  private nextRunnable(): number {
    if (this.owner) return this.queue.findIndex((b) => b.conn === this.owner);
    return this.queue.length > 0 ? 0 : -1;
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      let ran = false;
      for (;;) {
        const idx = this.nextRunnable();
        if (idx < 0) break;
        const batch = this.queue.splice(idx, 1)[0]!;
        if (batch.conn.closed) continue;
        const { output, status } = await this.db.runExclusive(() => this.runBatch(batch));
        ran = true;
        if (status !== null) this.owner = status === "I" ? null : batch.conn;
        if (!batch.conn.closed && output.length > 0) batch.conn.socket.write(output);
      }
      if (ran) await this.db.syncToFs();
    } catch (err) {
      console.error("[db] wire bridge error:", err);
    } finally {
      this.running = false;
      // A batch may have arrived during the final syncToFs. Only re-run when something can
      // actually run: re-pumping while blocked on a transaction owner would spin forever.
      if (this.nextRunnable() >= 0) void this.pump();
    }
  }

  private async runBatch(batch: Batch): Promise<{ output: Buffer; status: string | null }> {
    const out: Buffer[] = [];
    let status: string | null = null;
    let failed = false;

    for (const msg of batch.messages) {
      if (batch.startup) {
        const res = await this.runMessage(msg);
        status = lastReadyStatus(res) ?? status;
        out.push(res);
        continue;
      }
      const type = msg[0];
      if (type === MSG_SYNC || type === MSG_QUERY) {
        const res = await this.runMessage(msg);
        status = lastReadyStatus(res) ?? status;
        out.push(res);
        failed = false;
        continue;
      }
      if (failed) continue; // ignore till sync
      const res = await this.runMessage(msg);
      const { filtered, hadError } = stripReadyForQuery(res);
      out.push(filtered);
      if (hadError) failed = true;
    }
    return { output: Buffer.concat(out), status };
  }

  private async runMessage(message: Buffer): Promise<Buffer> {
    const chunks: Buffer[] = [];
    await this.db.execProtocolRawStream(new Uint8Array(message), {
      syncToFs: false,
      onRawData: (data: Uint8Array) => {
        chunks.push(Buffer.from(data));
      },
    });
    return Buffer.concat(chunks);
  }
}

function* backendMessages(buf: Buffer): Generator<{ type: number; start: number; end: number }> {
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const type = buf[offset]!;
    const len = buf.readInt32BE(offset + 1);
    const end = offset + 1 + len;
    if (end > buf.length) break;
    yield { type, start: offset, end };
    offset = end;
  }
}

function stripReadyForQuery(buf: Buffer): { filtered: Buffer; hadError: boolean } {
  const keep: Buffer[] = [];
  let hadError = false;
  for (const m of backendMessages(buf)) {
    if (m.type === BE_ERROR) hadError = true;
    if (m.type !== BE_READY) keep.push(buf.subarray(m.start, m.end));
  }
  return { filtered: Buffer.concat(keep), hadError };
}

function lastReadyStatus(buf: Buffer): string | null {
  let status: string | null = null;
  for (const m of backendMessages(buf)) {
    if (m.type === BE_READY) status = String.fromCharCode(buf[m.start + 5]!);
  }
  return status;
}

function simpleQuery(sql: string): Uint8Array {
  const body = Buffer.from(`${sql}\0`, "utf8");
  const msg = Buffer.alloc(1 + 4 + body.length);
  msg[0] = MSG_QUERY;
  msg.writeInt32BE(4 + body.length, 1);
  body.copy(msg, 5);
  return msg;
}

export async function startPgliteServer(options: {
  dataDir?: string;
  loadDataDir?: Blob;
  port: number;
  host?: string;
}): Promise<{ url: string; port: number; db: PGlite; stop: () => Promise<void> }> {
  const db = await createPglite({ dataDir: options.dataDir, loadDataDir: options.loadDataDir });
  const host = options.host ?? "127.0.0.1";
  const server = new PgliteWireServer(db);
  const port = await server.listen(options.port, host);
  return {
    url: `postgres://postgres:postgres@${host}:${port}/postgres`,
    port,
    db,
    stop: async () => {
      await server.close();
      await db.close();
    },
  };
}
