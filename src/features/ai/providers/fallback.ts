import { log } from "@/lib/log";
import {
  AiProviderError,
  type AiProvider,
  type AiRequest,
  type AiResponse,
  type AiStreamEvent,
} from "../types";

/**
 * The primary provider, and a second one when the first fails (Settings -> Integrations ->
 * AI, "Backup provider"). A failed call (down, overloaded, rate limited, a bad key) is asked
 * again of the backup with its own model for the same tier; the response names the model that
 * answered, so spend is counted at the right price. A stream switches only before its first
 * word: once text has reached the visitor, the error is passed on as it is.
 */
export class FallbackProvider implements AiProvider {
  get name() {
    return this.primary.name;
  }

  constructor(
    private readonly primary: AiProvider,
    private readonly backup: AiProvider,
    /** Primary model -> the backup's model for the same tier; others use `defaultModel`. */
    private readonly models: Record<string, string>,
    private readonly defaultModel: string,
  ) {}

  private backupRequest(req: AiRequest): AiRequest {
    return { ...req, model: this.models[req.model] ?? this.defaultModel };
  }

  private shouldFallBack(err: unknown, req: AiRequest): boolean {
    if (req.signal?.aborted) return false;
    if (!(err instanceof AiProviderError)) return false;
    log("warn", "ai.fallback", {
      primary: this.primary.name,
      backup: this.backup.name,
      status: err.status,
      error: err.message.slice(0, 200),
    });
    return true;
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    try {
      return await this.primary.complete(req);
    } catch (err) {
      if (!this.shouldFallBack(err, req)) throw err;
      return this.backup.complete(this.backupRequest(req));
    }
  }

  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    let started = false;
    try {
      for await (const event of this.primary.stream(req)) {
        started = true;
        yield event;
      }
      return;
    } catch (err) {
      if (started || !this.shouldFallBack(err, req)) throw err;
    }
    yield* this.backup.stream(this.backupRequest(req));
  }
}
