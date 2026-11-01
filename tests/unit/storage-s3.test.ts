import { describe, expect, it } from "vitest";
import { r2Storage } from "@/lib/storage/r2";
import { s3Bucket, signV4 } from "@/lib/storage/s3";

describe("R2 over the S3 API", () => {
  it("signs requests as AWS Signature Version 4 does (AWS's published GET example)", async () => {
    const headers = await signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      date: new Date("2013-05-24T00:00:00Z"),
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("puts, reads a range, lists and deletes through the storage driver", async () => {
    const store = new Map<string, { bytes: Uint8Array; type: string }>();
    const seen: Array<{ method: string; url: string; auth: string | null }> = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const h = new Headers(init?.headers);
      seen.push({
        method: init?.method ?? "GET",
        url: url.toString(),
        auth: h.get("authorization"),
      });
      const key = decodeURIComponent(url.pathname.replace(/^\/media\/?/, ""));
      const method = init?.method ?? "GET";
      if (method === "PUT") {
        store.set(key, { bytes: init!.body as Uint8Array, type: h.get("content-type")! });
        return new Response(null, { status: 200, headers: { etag: '"abc"' } });
      }
      if (method === "DELETE") {
        store.delete(key);
        return new Response(null, { status: 204 });
      }
      if (url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
        return new Response(
          `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`,
        );
      }
      const o = store.get(key);
      if (!o) return new Response(null, { status: 404 });
      const range = /bytes=(\d+)-(\d+)/.exec(h.get("range") ?? "");
      const body = range ? o.bytes.slice(Number(range[1]), Number(range[2]) + 1) : o.bytes;
      return new Response(method === "HEAD" ? null : (body as BodyInit), {
        status: range ? 206 : 200,
        headers: {
          "content-type": o.type,
          "content-length": String(body.byteLength),
          etag: '"abc"',
          ...(range
            ? { "content-range": `bytes ${range[1]}-${range[2]}/${o.bytes.byteLength}` }
            : {}),
        },
      });
    }) as typeof fetch;
    const storage = r2Storage(
      s3Bucket({
        endpoint: "https://acc.r2.cloudflarestorage.com",
        bucket: "media",
        accessKeyId: "id",
        secretAccessKey: "secret",
        fetch: fake,
      }),
    );
    const data = new TextEncoder().encode("hello world");
    await storage.put("2026/10/a-b.c/photo.jpg", data, "image/jpeg");
    expect(seen[0]!.url).toBe("https://acc.r2.cloudflarestorage.com/media/2026/10/a-b.c/photo.jpg");
    expect(seen[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=id\/\d{8}\/auto\/s3\/aws4_request/);

    const part = await storage.get("2026/10/a-b.c/photo.jpg", { offset: 6, length: 5 });
    expect(part).toMatchObject({
      size: 11,
      contentType: "image/jpeg",
      range: { offset: 6, length: 5 },
    });
    expect(new TextDecoder().decode(await new Response(part!.body).arrayBuffer())).toBe("world");
    expect(await storage.head("2026/10/a-b.c/photo.jpg")).toMatchObject({
      contentType: "image/jpeg",
    });
    expect(await storage.get("2026/10/missing.jpg")).toBeNull();

    await storage.put("2026/10/x/one.png", data, "image/png");
    await storage.deletePrefix("2026/10/");
    expect(store.size).toBe(0);
  });
});
