import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestError } from "@/instrumentation";

describe("server error tracking (14 §5)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("logs each server error once, with the release, route and request id, without the query", async () => {
    vi.stubEnv("PROPEL_RELEASE", "v1.4.2");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const err = Object.assign(new Error("Database is down"), { digest: "123456" });
    await onRequestError(
      err,
      {
        path: "/property/two-bed?email=sam@example.com",
        method: "GET",
        headers: { "x-request-id": "req-1" },
      },
      {
        routerKind: "App Router",
        routePath: "/property/[slug]",
        routeType: "render",
        renderSource: "server-rendering",
        revalidateReason: undefined,
      },
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(spy.mock.calls[0]![0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: "error",
      event: "request.error",
      release: "v1.4.2",
      method: "GET",
      path: "/property/two-bed",
      route: "/property/[slug]",
      routeType: "render",
      requestId: "req-1",
      digest: "123456",
      error: { name: "Error", message: "Database is down" },
    });
    expect(JSON.stringify(line)).not.toContain("sam@example.com");
  });
});
