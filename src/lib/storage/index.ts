import { env, isWorkersRuntime } from "@/lib/env";

/**
 * File storage behind one interface (01 §3: Cloudflare R2 in staging/production; the local
 * disk in development; memory in tests). Keys are plain paths such as "2026/10/abc/photo.jpg".
 */

export type ObjectMeta = {
  size: number;
  contentType: string;
  /** Quoted HTTP entity tag. */
  etag: string;
  uploaded: Date;
};

export type ByteRange = { offset: number; length: number };

export type StoredObject = ObjectMeta & {
  body: ReadableStream<Uint8Array>;
  /** Present when a range was requested and served. */
  range?: ByteRange;
};

export interface StorageDriver {
  readonly name: "fs" | "r2" | "memory";
  put(key: string, data: Uint8Array, contentType: string): Promise<ObjectMeta>;
  get(key: string, range?: ByteRange): Promise<StoredObject | null>;
  getBytes(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<ObjectMeta | null>;
  delete(keys: string[]): Promise<void>;
  /** Deletes every key under `prefix` (which must end with "/"). */
  deletePrefix(prefix: string): Promise<void>;
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** Keys never contain "..", empty segments, backslashes or a leading slash. */
export function assertKey(key: string): void {
  if (
    key.length > 512 ||
    !KEY_RE.test(key) ||
    key.split("/").some((s) => s === "." || s === "..")
  ) {
    throw new Error(`Invalid storage key: ${JSON.stringify(key.slice(0, 80))}`);
  }
}

export function assertPrefix(prefix: string): void {
  if (!prefix.endsWith("/")) throw new Error("A storage prefix must end with /");
  assertKey(prefix.slice(0, -1));
}

let override: StorageDriver | null = null;

/** Tests: use an in-memory (or any) driver. Pass null to go back to the configured one. */
export function setStorage(driver: StorageDriver | null): void {
  override = driver;
}

export async function getStorage(): Promise<StorageDriver> {
  if (override) return override;
  if (isWorkersRuntime() || env().STORAGE_DRIVER === "r2") {
    const { r2Storage, mediaBucket } = await import("./r2");
    const e = env();
    // Outside the Worker there is no binding: the same bucket through R2's S3 API.
    if (!isWorkersRuntime() && e.R2_ACCOUNT_ID && e.R2_ACCESS_KEY_ID && e.R2_SECRET_ACCESS_KEY) {
      const { s3Bucket } = await import("./s3");
      return r2Storage(
        s3Bucket({
          endpoint: `https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
          bucket: e.R2_BUCKET,
          accessKeyId: e.R2_ACCESS_KEY_ID,
          secretAccessKey: e.R2_SECRET_ACCESS_KEY,
        }),
      );
    }
    return r2Storage(await mediaBucket());
  }
  const { fsStorage } = await import("./fs");
  return fsStorage(env().STORAGE_FS_DIR);
}

/** Simple in-memory driver for tests. */
export function memoryStorage(): StorageDriver & { keys: () => string[] } {
  const items = new Map<string, { data: Uint8Array; meta: ObjectMeta }>();
  let version = 0;
  const toStream = (data: Uint8Array) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  return {
    name: "memory",
    keys: () => [...items.keys()].sort(),
    async put(key, data, contentType) {
      assertKey(key);
      const meta = {
        size: data.length,
        contentType,
        etag: `"m${++version}"`,
        uploaded: new Date(),
      };
      items.set(key, { data: data.slice(), meta });
      return meta;
    },
    async get(key, range) {
      const item = items.get(key);
      if (!item) return null;
      if (!range) return { ...item.meta, body: toStream(item.data) };
      const slice = item.data.subarray(range.offset, range.offset + range.length);
      return {
        ...item.meta,
        body: toStream(slice),
        range: { offset: range.offset, length: slice.length },
      };
    },
    async getBytes(key) {
      return items.get(key)?.data.slice() ?? null;
    },
    async head(key) {
      return items.get(key)?.meta ?? null;
    },
    async delete(keys) {
      for (const k of keys) items.delete(k);
    },
    async deletePrefix(prefix) {
      assertPrefix(prefix);
      for (const k of [...items.keys()]) if (k.startsWith(prefix)) items.delete(k);
    },
  };
}
