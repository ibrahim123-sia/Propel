import type { NextConfig } from "next";
import { API_CSP, PREVIEW_FRAME_OPTIONS, baseSecurityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Off for the public site: on, every page's HTML also carried a second copy of its RSC data
  // (the embedded runtime prefetch), about a third of the property page. Admin opts in through
  // `prefetch = "partial"` in its layout. PROGRESS decision 99.
  partialPrefetching: false,
  poweredByHeader: false,
  // Security headers on every response (14 §2); pages get their CSP from middleware.ts so the
  // report-only switch works at runtime. A later rule wins for the same header.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: baseSecurityHeaders({ production: process.env.NODE_ENV === "production" }),
      },
      { source: "/preview/:path*", headers: [PREVIEW_FRAME_OPTIONS] },
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: API_CSP }] },
    ];
  },
  // Separate build folder for the e2e server, so it can run next to `pnpm dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    // The e2e dev server always starts cold: a restored dev cache next to files edited since
    // (e.g. by the formatter) sent the browser into an endless reload loop.
    turbopackFileSystemCacheForDev: process.env.NEXT_DIST_DIR !== ".next-e2e",
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // `pg` loads `pg-cloudflare` only under the `workerd` export condition, which Node's file
  // tracing never resolves; include its files so the Workers bundle (OpenNext) can find them.
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/.pnpm/pg-cloudflare@*/node_modules/pg-cloudflare/dist/**/*",
      "./node_modules/.pnpm/pg-cloudflare@*/node_modules/pg-cloudflare/esm/**/*",
    ],
  },
  images: {
    // Media is served by our own /media route (R2 in production, local disk in development).
    localPatterns: [{ pathname: "/media/**" }, { pathname: "/images/**" }],
    qualities: [60, 75, 90],
    formats: ["image/avif", "image/webp"],
  },
};

export default nextConfig;
