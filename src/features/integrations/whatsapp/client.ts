import "server-only";
import type { DbOrTx } from "@/db/client";
import { loadSettings } from "@/features/settings/queries";
import { getSecret } from "@/features/settings/secrets";
import { GRAPH_API_VERSION } from "../checks";

/**
 * WhatsApp Cloud API (13 §1) behind an interface, so tests and the demo use a fake. `to` is a
 * WhatsApp id (digits only).
 */
export type WaSent = { id: string };

export interface WhatsappClient {
  sendText(to: string, body: string): Promise<WaSent>;
  sendTemplate(
    to: string,
    template: { name: string; language: string; parameters: string[] },
  ): Promise<WaSent>;
  sendImage(to: string, image: { link: string; caption: string }): Promise<WaSent>;
  /** A received photo, file or voice note, by its media id (null when it is gone). */
  downloadMedia?(mediaId: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
}

/** A refused send. `permanent` errors (bad number, template not approved) are not retried. */
export class WhatsappApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly permanent: boolean,
  ) {
    super(message);
    this.name = "WhatsappApiError";
  }
}

let override: WhatsappClient | null | undefined;

/** Tests: a fake client, `null` for "not configured", `undefined` for the real one again. */
export function setWhatsappClient(client: WhatsappClient | null | undefined): void {
  override = client;
}

/** The configured client, or null when WhatsApp is off or its number or token is missing. */
export async function whatsappClient(db?: DbOrTx): Promise<WhatsappClient | null> {
  if (override !== undefined) return override;
  const { whatsapp } = await loadSettings("integrations", db);
  if (!whatsapp.enabled || !whatsapp.phoneNumberId) return null;
  const token = await getSecret("whatsapp_access_token", db);
  return token ? graphClient(whatsapp.phoneNumberId, token) : null;
}

export const NOT_CONFIGURED =
  "WhatsApp is not set up: turn it on and add the phone number ID and access token in Settings -> Integrations.";

function graphClient(phoneNumberId: string, token: string): WhatsappClient {
  const post = async (payload: Record<string, unknown>): Promise<WaSent> => {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          ...payload,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const body = (await res.json().catch(() => null)) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string };
    } | null;
    if (!res.ok) {
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw new WhatsappApiError(
        `WhatsApp answered ${res.status}: ${body?.error?.message ?? res.statusText}`.slice(0, 300),
        res.status,
        permanent,
      );
    }
    const id = body?.messages?.[0]?.id;
    if (!id) throw new WhatsappApiError("WhatsApp did not return a message id.", res.status, false);
    return { id };
  };
  return {
    sendText: (to, text) => post({ to, type: "text", text: { body: text, preview_url: true } }),
    sendTemplate: (to, t) =>
      post({
        to,
        type: "template",
        template: {
          name: t.name,
          language: { code: t.language },
          components: t.parameters.length
            ? [{ type: "body", parameters: t.parameters.map((text) => ({ type: "text", text })) }]
            : [],
        },
      }),
    sendImage: (to, image) => post({ to, type: "image", image: image }),
    // Two steps: the media id gives a short-lived URL, which needs the token too.
    async downloadMedia(mediaId) {
      const auth = { Authorization: `Bearer ${token}` };
      const meta = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(mediaId)}`,
        { headers: auth, signal: AbortSignal.timeout(15_000) },
      );
      if (meta.status === 404) return null;
      if (!meta.ok)
        throw new WhatsappApiError(`WhatsApp answered ${meta.status}`, meta.status, false);
      const info = (await meta.json()) as { url?: string; mime_type?: string };
      if (!info.url) return null;
      const file = await fetch(info.url, { headers: auth, signal: AbortSignal.timeout(30_000) });
      if (!file.ok)
        throw new WhatsappApiError(`WhatsApp answered ${file.status}`, file.status, false);
      return {
        bytes: new Uint8Array(await file.arrayBuffer()),
        mime: info.mime_type ?? file.headers.get("content-type") ?? "audio/ogg",
      };
    },
  };
}
