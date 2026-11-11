import "server-only";
import { bytesToBase64Url, hmacSha256, sha256Hex } from "@/lib/crypto";
import { signToken, verifyToken } from "@/lib/signed-token";

function secret(): string {
  const s = process.env.BETTER_AUTH_SECRET || process.env.SECRETS_ENCRYPTION_KEY;
  if (!s) throw new Error("BETTER_AUTH_SECRET is not set");
  return s;
}

/**
 * The one-click unsubscribe token of a saved search (12 §3): derived from its id, so every
 * alert can carry it without storing it; the search keeps only its hash to be found by it.
 */
export async function searchUnsubscribeToken(searchId: string): Promise<string> {
  return bytesToBase64Url(await hmacSha256(secret(), `alerts-unsubscribe.${searchId}`)).slice(
    0,
    32,
  );
}

export const unsubscribeTokenHash = (token: string) => sha256Hex(token);

export type PreferenceKind = "newMatch" | "priceDrop" | "statusChange";
const preferenceKinds: readonly string[] = ["newMatch", "priceDrop", "statusChange"];

/** Unsubscribe from one kind of saved-home alert (no search to switch off): a signed token. */
export function preferenceUnsubscribeToken(userId: string, kind: PreferenceKind) {
  return signToken("alerts-preference", { u: userId, k: kind }, 2 * 365 * 86_400);
}

export async function readPreferenceToken(
  token: string,
): Promise<{ userId: string; kind: PreferenceKind } | null> {
  const payload = await verifyToken<{ u: string; k: string }>("alerts-preference", token);
  if (!payload || !preferenceKinds.includes(payload.k)) return null;
  return { userId: payload.u, kind: payload.k as PreferenceKind };
}
