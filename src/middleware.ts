import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import {
  VISITOR_COOKIE,
  VISITOR_MAX_AGE,
  visitorCookieUpdate,
  visitorCookieValue,
} from "@/features/attribution/visitor-cookie";
import { edgeRedirect } from "@/features/seo/edge-redirects";
import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE,
  LEGACY_CONSENT_COOKIE,
  parseConsent,
} from "@/lib/consent";
import { CURRENCY_COOKIE, LEGACY_CURRENCY_COOKIE } from "@/features/site/currency-cookie";
import { REQUEST_ID_HEADER } from "@/lib/log";
import { pageCsp } from "@/lib/security/headers";

const onWorkers = () =>
  typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

/**
 * Edge middleware: small and Edge-safe on purpose (OpenNext does not run Node middleware).
 * - Optimistic redirect to sign-in when there is no session cookie at all. This is only a
 *   convenience: every admin/account page, action and route handler checks the session itself.
 * - Passes the current path to server components (for "back to where you were" after sign-in).
 * - Gives site visitors their first-party visitor id (09 §2), only when it is new or consent
 *   changed, so cached pages are not sent with a cookie every time.
 * - Serves the redirects manager's rules with their real 301/302 (08 §6) before pages stream.
 * - Tags the request with an id for the structured logs, and sends the page
 *   Content-Security-Policy (14 §2, lib/security/headers.ts); the other
 *   security headers come from next.config.ts for every response.
 */
const PUBLIC_ADMIN_PATHS = ["/admin/sign-in", "/admin/two-factor"];

/** Longest sign-in (customers, 30 days): the moved session cookie lasts at least as long. */
const LEGACY_SESSION_MAX_AGE = 30 * 24 * 60 * 60;
/** Better Auth cookies worth moving (the session cache is rebuilt on its own). */
const MOVED_AUTH_COOKIES = ["session_token", "dont_remember", "two_factor"];

/**
 * Better Auth cookies named before the product was renamed (Keyline -> Propel, 2026-10-27):
 * `keyline.session_token` (or `__Secure-keyline.…`) becomes `propel.…` when there is no
 * new one yet. The value is signed independently of its name, so it stays valid. Remove this
 * once the longest session from before the rename has expired (2026-11-27).
 */
function legacyAuthCookies(request: NextRequest) {
  const moved: Array<{
    name: string;
    oldName: string;
    value: string;
    secure: boolean;
    persistent: boolean;
  }> = [];
  for (const secure of [false, true]) {
    const prefix = secure ? "__Secure-" : "";
    // "Remember me" off: the session cookie ended with the browser, and still does.
    const remembered = !request.cookies.has(`${prefix}keyline.dont_remember`);
    for (const kind of MOVED_AUTH_COOKIES) {
      const oldName = `${prefix}keyline.${kind}`;
      const name = `${prefix}propel.${kind}`;
      const value = request.cookies.get(oldName)?.value;
      if (value && !request.cookies.has(name))
        moved.push({
          name,
          oldName,
          value,
          secure,
          persistent: kind === "session_token" && remembered,
        });
    }
  }
  return moved;
}

export async function middleware(request: NextRequest, event: NextFetchEvent) {
  const { pathname, search } = request.nextUrl;
  const isAdmin = pathname === "/admin" || pathname.startsWith("/admin/");
  const isAccount = pathname === "/account" || pathname.startsWith("/account/");
  const isPublicAdmin = PUBLIC_ADMIN_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  // Sign-in cookies from before the rename (keyline.*) move to propel.* so nobody is signed out.
  const legacy = legacyAuthCookies(request);

  if ((isAdmin && !isPublicAdmin) || isAccount) {
    const hasSession =
      Boolean(getSessionCookie(request, { cookiePrefix: "propel" })) || legacy.length > 0;
    if (!hasSession) {
      const url = request.nextUrl.clone();
      url.pathname = isAdmin ? "/admin/sign-in" : "/sign-in";
      url.search = `?next=${encodeURIComponent(pathname + search)}`;
      return NextResponse.redirect(url);
    }
  }

  // On Cloudflare the Worker answers redirects before Next.js runs (src/worker/edge-redirects.ts):
  // a request from the Worker to itself here hung fresh isolates (Error 1101).
  if (
    !isAdmin &&
    !isAccount &&
    !onWorkers() &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    const moved = await edgeRedirect(request.nextUrl, (p) => event.waitUntil(p));
    if (moved) return NextResponse.redirect(moved.location, moved.status);
  }

  const headers = new Headers(request.headers);
  headers.set("x-propel-path", pathname + search);
  if (legacy.length)
    headers.set(
      "cookie",
      [request.headers.get("cookie"), ...legacy.map((c) => `${c.name}=${c.value}`)]
        .filter(Boolean)
        .join("; "),
    );
  // One id per request for the structured logs (lib/log.ts): Cloudflare's ray id when present.
  const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
  headers.set(REQUEST_ID_HEADER, requestId);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  const csp = pageCsp(pathname, process.env);
  response.headers.set(csp.name, csp.value);
  for (const c of legacy) {
    response.cookies.set({
      name: c.name,
      value: c.value,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: c.secure,
      // The session row decides how long a sign-in lasts; the cookie only has to outlive it.
      ...(c.persistent ? { maxAge: LEGACY_SESSION_MAX_AGE } : {}),
    });
    response.cookies.set({ name: c.oldName, value: "", path: "/", maxAge: 0, secure: c.secure });
  }
  // The consent and currency choices move to their new names too (read by the browser and
  // the server alike).
  for (const c of [
    { old: LEGACY_CONSENT_COOKIE, name: CONSENT_COOKIE, maxAge: CONSENT_MAX_AGE, httpOnly: false },
    {
      old: LEGACY_CURRENCY_COOKIE,
      name: CURRENCY_COOKIE,
      maxAge: 60 * 60 * 24 * 365,
      httpOnly: true,
    },
  ]) {
    const value = request.cookies.get(c.old)?.value;
    if (!value || request.cookies.has(c.name)) continue;
    const secure = request.nextUrl.protocol === "https:";
    response.cookies.set({
      name: c.name,
      value,
      path: "/",
      sameSite: "lax",
      secure,
      maxAge: c.maxAge,
      httpOnly: c.httpOnly,
    });
    response.cookies.set({ name: c.old, value: "", path: "/", maxAge: 0 });
  }
  if (!isAdmin) {
    const consent = parseConsent(
      (request.cookies.get(CONSENT_COOKIE) ?? request.cookies.get(LEGACY_CONSENT_COOKIE))?.value,
    );
    const update = visitorCookieUpdate(
      request.cookies.get(VISITOR_COOKIE)?.value,
      consent ? !consent.analytics : false,
      () => crypto.randomUUID(),
    );
    if (update)
      response.cookies.set({
        name: VISITOR_COOKIE,
        value: visitorCookieValue(update),
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: request.nextUrl.protocol === "https:",
        ...(update.sessionOnly ? {} : { maxAge: VISITOR_MAX_AGE }),
      });
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|api/|media/|og/|favicon.ico|robots.txt|sitemap.*\\.xml|.*\\.(?:png|jpg|jpeg|gif|svg|webp|avif|ico|css|js|txt|xml|woff2?)$).*)",
  ],
};
