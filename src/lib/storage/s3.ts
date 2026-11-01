import type { R2Bucket } from "./r2";

/**
 * The media bucket through R2's S3-compatible API, for code that runs outside the Worker but
 * must write the same files: the nightly demo reset in GitHub Actions (16 §3), a seed from a
 * laptop. It mimics the parts of the R2 binding the storage driver uses, so `r2Storage` works
 * on top of it unchanged. Plain `fetch` and Web Crypto (AWS Signature Version 4), no SDK.
 */

export type S3Config = {
  /** https://<account id>.r2.cloudflarestorage.com, or any S3-compatible endpoint. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 uses "auto". */
  region?: string;
  fetch?: typeof fetch;
  /** Tests fix the clock. */
  now?: () => Date;
};

const encoder = new TextEncoder();
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, encoder.encode(data));
}

/** RFC 3986 encoding as S3 wants it (slashes kept in paths). */
const encode = (s: string, keepSlash = false) =>
  encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(keepSlash ? /%2F/g : /$^/, "/");

export type SignInput = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  date: Date;
};

/** Adds x-amz-date, x-amz-content-sha256 and Authorization (SigV4) to the headers. */
export async function signV4(input: SignInput): Promise<Record<string, string>> {
  const service = input.service ?? "s3";
  const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v])),
    host: input.url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": input.payloadHash,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    input.method,
    input.url.pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");
  let key = await hmac(encoder.encode(`AWS4${input.secretAccessKey}`), day);
  for (const part of [input.region, service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

type S3Object = {
  key: string;
  size: number;
  httpEtag: string;
  uploaded: Date;
  httpMetadata: { contentType: string };
  range?: { offset: number; length: number };
};

const tagValues = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) =>
    m[1]!
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&"),
  );

export function s3Bucket(config: S3Config): R2Bucket {
  const doFetch = config.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const base = config.endpoint.replace(/\/$/, "");
  const region = config.region ?? "auto";
  const now = config.now ?? (() => new Date());

  async function call(
    method: string,
    key: string | null,
    options: {
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: Uint8Array;
    } = {},
  ): Promise<Response> {
    const path = key === null ? "" : `/${encode(key, true)}`;
    const url = new URL(`${base}/${encode(config.bucket)}${path}`);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
    const headers = await signV4({
      method,
      url,
      headers: options.headers ?? {},
      payloadHash: options.body ? await sha256Hex(options.body) : EMPTY_SHA256,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region,
      date: now(),
    });
    delete headers.host;
    return doFetch(url, { method, headers, body: options.body as BodyInit | undefined });
  }

  const fail = async (res: Response, what: string) =>
    new Error(`R2 (S3 API) answered ${res.status} to ${what}: ${(await res.text()).slice(0, 200)}`);

  const objectOf = (key: string, res: Response, size?: number): S3Object => {
    const contentRange = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.headers.get("content-range") ?? "");
    const length = Number(res.headers.get("content-length") ?? size ?? 0);
    return {
      key,
      size: contentRange ? Number(contentRange[3]) : length,
      httpEtag: res.headers.get("etag") ?? '""',
      uploaded: new Date(res.headers.get("last-modified") ?? Date.now()),
      httpMetadata: {
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
      },
      ...(contentRange
        ? {
            range: {
              offset: Number(contentRange[1]),
              length: Number(contentRange[2]) - Number(contentRange[1]) + 1,
            },
          }
        : {}),
    };
  };

  return {
    async put(key, value, options) {
      const contentType = options?.httpMetadata?.contentType ?? "application/octet-stream";
      const res = await call("PUT", key, { body: value, headers: { "content-type": contentType } });
      if (!res.ok) throw await fail(res, `PUT ${key}`);
      return {
        key,
        size: value.byteLength,
        httpEtag: res.headers.get("etag") ?? '""',
        uploaded: now(),
        httpMetadata: { contentType },
      };
    },
    async get(key, options) {
      const range = options?.range;
      const res = await call("GET", key, {
        headers: range ? { range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {},
      });
      if (res.status === 404) return null;
      if (!res.ok) throw await fail(res, `GET ${key}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const meta = objectOf(key, res, bytes.byteLength);
      return {
        ...meta,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      };
    },
    async head(key) {
      const res = await call("HEAD", key);
      if (res.status === 404) return null;
      if (!res.ok) throw await fail(res, `HEAD ${key}`);
      return objectOf(key, res);
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const res = await call("DELETE", key);
        if (!res.ok && res.status !== 404) throw await fail(res, `DELETE ${key}`);
      }
    },
    async list({ prefix, cursor, limit }) {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (cursor) query["continuation-token"] = cursor;
      if (limit) query["max-keys"] = String(limit);
      const res = await call("GET", null, { query });
      if (!res.ok) throw await fail(res, `LIST ${prefix}`);
      const xml = await res.text();
      return {
        objects: tagValues(xml, "Key").map((key) => ({ key })),
        truncated: tagValues(xml, "IsTruncated")[0] === "true",
        cursor: tagValues(xml, "NextContinuationToken")[0],
      };
    },
  };
}
