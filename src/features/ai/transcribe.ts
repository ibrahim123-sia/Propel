import "server-only";
import type { DbOrTx } from "@/db/client";
import { env } from "@/lib/env";
import { aiKey, loadAiConfig } from "./config";
import { recordUsage } from "./usage";

/**
 * Voice notes to text (10 §2 WhatsApp agent: "voice notes transcribed"), so the assistant can
 * answer a visitor who speaks instead of typing. Groq's Whisper when a Groq key is there
 * (cheap and fast, priced by audio second), else Gemini, which listens to audio too. Null when
 * neither is available or the audio could not be understood: the team answers then.
 */

export type Transcript = { text: string; model: string };

/** Voice notes on WhatsApp are at most 16 MB. */
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const WHISPER_MODEL = "whisper-large-v3-turbo";

type Audio = { bytes: Uint8Array; mime: string };

const extensionOf = (mime: string) =>
  ({
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "m4a",
    "audio/amr": "amr",
    "audio/wav": "wav",
    "audio/webm": "webm",
  })[mime.split(";")[0]!.trim().toLowerCase()] ?? "ogg";

async function viaGroq(key: string, audio: Audio, fetchImpl: typeof fetch) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([audio.bytes as BlobPart], { type: audio.mime }),
    `voice.${extensionOf(audio.mime)}`,
  );
  form.append("model", WHISPER_MODEL);
  form.append("response_format", "verbose_json");
  const res = await fetchImpl("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Groq answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string; duration?: number };
  return { text: (json.text ?? "").trim(), seconds: Math.ceil(json.duration ?? 0) };
}

async function viaGemini(key: string, model: string, audio: Audio, fetchImpl: typeof fetch) {
  let binary = "";
  for (let i = 0; i < audio.bytes.length; i += 0x8000)
    binary += String.fromCharCode(...audio.bytes.subarray(i, i + 0x8000));
  const res = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: audio.mime.split(";")[0], data: btoa(binary) } },
              {
                text: "Transcribe this voice note word for word, in the language it is spoken in. Reply with the words only. If nothing can be understood, reply with nothing.",
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 2000 },
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!res.ok)
    throw new Error(`Gemini answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();
  return {
    text,
    usage: {
      inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

export async function transcribeAudio(
  db: DbOrTx,
  audio: Audio,
  options: { fetch?: typeof fetch; now?: Date } = {},
): Promise<Transcript | null> {
  if (audio.bytes.length === 0 || audio.bytes.length > MAX_AUDIO_BYTES) return null;
  const fetchImpl = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const config = await loadAiConfig(db);
  if (!config.enabled || config.provider === "mock") return null;
  const slots = [
    { slot: "ai_api_key" as const, provider: config.provider, fast: config.models.fast },
    ...(config.fallback
      ? [
          {
            slot: "ai_fallback_api_key" as const,
            provider: config.fallback.provider,
            fast: config.fallback.models.fast,
          },
        ]
      : []),
  ];
  // Groq first (Whisper), then Gemini; a key in the environment counts too.
  const groq = slots.find((s) => s.provider === "groq");
  const groqKey = groq ? await aiKey(groq.slot, "groq", db) : (env().GROQ_API_KEY ?? null);
  if (groqKey) {
    try {
      const r = await viaGroq(groqKey, audio, fetchImpl);
      await recordUsage(
        {
          feature: "whatsapp",
          model: WHISPER_MODEL,
          // Priced per audio second (see pricing.ts).
          usage: {
            inputTokens: r.seconds,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
        { db, now: options.now },
      );
      if (r.text) return { text: r.text, model: WHISPER_MODEL };
    } catch (err) {
      console.error("[ai] voice note transcription (Groq) failed", (err as Error).message);
    }
  }
  const gemini = slots.find((s) => s.provider === "gemini");
  const geminiKey = gemini ? await aiKey(gemini.slot, "gemini", db) : null;
  if (gemini && geminiKey) {
    try {
      const r = await viaGemini(geminiKey, gemini.fast, audio, fetchImpl);
      await recordUsage(
        {
          feature: "whatsapp",
          model: gemini.fast,
          usage: { ...r.usage, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
        { db, now: options.now },
      );
      if (r.text) return { text: r.text, model: gemini.fast };
    } catch (err) {
      console.error("[ai] voice note transcription (Gemini) failed", (err as Error).message);
    }
  }
  return null;
}
