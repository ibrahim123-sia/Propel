import type { Instrumentation } from "next";
import { log, REQUEST_ID_HEADER } from "@/lib/log";

/**
 * Error tracking (14 §5 "Sentry or Cloudflare logs, with release tags"): every error Next
 * catches on the server (rendering, route handlers, server actions, middleware) becomes one
 * structured log line with the release tag, the route and the request id, so Cloudflare's
 * Workers logs can be searched and alerted on. The query string is left out (it can hold an
 * email or a token); the message and stack are trimmed by `log`.
 */
export const onRequestError: Instrumentation.onRequestError = (err, request, context) => {
  const header = request.headers[REQUEST_ID_HEADER];
  log("error", "request.error", {
    method: request.method,
    path: request.path.split("?")[0],
    route: context.routePath,
    routeType: context.routeType,
    requestId: Array.isArray(header) ? header[0] : (header ?? null),
    digest:
      typeof err === "object" && err !== null && "digest" in err ? String(err.digest) : undefined,
    error: err instanceof Error ? err : String(err),
  });
};
