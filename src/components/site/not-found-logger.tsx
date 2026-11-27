"use client";

import { useEffect } from "react";

/** The address already reported from this page load (Strict Mode runs effects twice). */
let reported: string | null = null;

/**
 * 404 monitor (08 §6): reports the address to /api/not-found once the not-found page is on
 * screen. Not on the server: Next renders this page into every page's payload (to show it
 * without a round trip), so a server-side report counted every page, and Next's `after()`
 * never runs on Cloudflare Workers (it left every request hanging, Error 1101).
 */
export function NotFoundLogger() {
  useEffect(() => {
    const path = `${window.location.pathname}${window.location.search}`.slice(0, 500);
    if (reported === path) return;
    reported = path;
    const body = JSON.stringify({ path, referrer: document.referrer || null });
    if (!navigator.sendBeacon?.("/api/not-found", body))
      void fetch("/api/not-found", { method: "POST", body, keepalive: true }).catch(() => {});
  }, []);
  return null;
}
