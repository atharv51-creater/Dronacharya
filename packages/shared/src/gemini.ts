// One Gemini call path for the whole project (the inference seller's Hindi text, the buyer's task parser
// and narrative). Uses Google's official Gen AI SDK. Every failure becomes an LlmError with a kind, so
// callers can map it consistently (a seller turns any of them into a 5xx, which is never settled).

import { ApiError, GoogleGenAI, ThinkingLevel } from "@google/genai";
import { env } from "./env.ts";

/** Stable, fast Gemini model as of Oct 2026 (gemini-3.5-flash-lite is the cheaper choice). Override per use in .env. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

export type LlmErrorKind = "unavailable" | "busy" | "rejected" | "blocked" | "truncated" | "bad_output" | "unreachable" | "error";

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface GeminiRequest {
  model: string;
  system: string;
  prompt: string;
  /** Ask for JSON that follows this JSON Schema (structured output). */
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface GeminiResult {
  text: string;
  model: string;
}

/** The slice of the SDK we use, so tests can substitute a fake. */
export interface GeminiClient {
  models: { generateContent(params: Record<string, unknown>): Promise<GeminiResponse> };
}
interface GeminiResponse {
  text?: string;
  modelVersion?: string;
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  candidates?: { finishReason?: string }[];
}

let client: GeminiClient | undefined;

export function geminiConfigured(): boolean {
  return Boolean(env("GEMINI_API_KEY") || env("GOOGLE_API_KEY"));
}

/** Test hook: route calls to a fake client (pass undefined to restore the real one). */
export function setGeminiClient(fake: GeminiClient | undefined): void {
  client = fake;
}

function getClient(): GeminiClient {
  if (client) return client;
  const apiKey = env("GEMINI_API_KEY") ?? env("GOOGLE_API_KEY");
  if (!apiKey) throw new LlmError("unavailable", "GEMINI_API_KEY is not set");
  client = new GoogleGenAI({ apiKey }) as unknown as GeminiClient;
  return client;
}

const BLOCKING_FINISH = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);
const LEVELS: Record<string, ThinkingLevel> = { minimal: ThinkingLevel.MINIMAL, low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH };

export async function geminiGenerate(req: GeminiRequest): Promise<GeminiResult> {
  const thinking = env("GEMINI_THINKING")?.toLowerCase();
  const config: Record<string, unknown> = {
    systemInstruction: req.system,
    maxOutputTokens: req.maxOutputTokens ?? 8192,
    httpOptions: { timeout: req.timeoutMs ?? 30_000 },
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.signal ? { abortSignal: req.signal } : {}),
    ...(req.jsonSchema ? { responseMimeType: "application/json", responseJsonSchema: req.jsonSchema } : {}),
    ...(thinking && LEVELS[thinking] ? { thinkingConfig: { thinkingLevel: LEVELS[thinking] } } : {}),
  };

  let response: GeminiResponse;
  try {
    response = await getClient().models.generateContent({ model: req.model, contents: req.prompt, config });
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (req.signal?.aborted) throw err;
    if (err instanceof ApiError || typeof (err as { status?: unknown }).status === "number") {
      const status = (err as { status: number }).status;
      if (status === 401 || status === 403) throw new LlmError("unavailable", "Gemini rejected the API key");
      if (status === 429) throw new LlmError("busy", "Gemini rate limit or quota reached");
      if (status === 400 || status === 404) throw new LlmError("rejected", `Gemini rejected the request: ${(err as Error).message.slice(0, 200)}`);
      throw new LlmError("error", `Gemini API error ${status}`);
    }
    throw new LlmError("unreachable", `could not reach Gemini: ${(err as Error).message.slice(0, 200)}`);
  }

  if (response.promptFeedback?.blockReason) {
    throw new LlmError("blocked", `Gemini blocked the prompt (${response.promptFeedback.blockReason})`);
  }
  const finish = response.candidates?.[0]?.finishReason;
  if (finish && BLOCKING_FINISH.has(finish)) throw new LlmError("blocked", `Gemini stopped for ${finish}`);
  if (finish === "MAX_TOKENS") throw new LlmError("truncated", "Gemini ran out of output tokens");
  const text = response.text?.trim();
  if (!text) throw new LlmError("bad_output", "Gemini returned no text");
  return { text, model: response.modelVersion ?? req.model };
}

/** Structured output: generates and parses JSON (still validate it; the schema is a request, not a guarantee). */
export async function geminiJson<T>(req: GeminiRequest & { jsonSchema: Record<string, unknown> }): Promise<{ value: T; model: string }> {
  const { text, model } = await geminiGenerate(req);
  try {
    return { value: JSON.parse(stripFence(text)) as T, model };
  } catch {
    throw new LlmError("bad_output", "Gemini did not return valid JSON");
  }
}

function stripFence(text: string): string {
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return m ? m[1]! : text;
}
