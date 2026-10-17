// OpenAI-compatible chat providers used by some sellers: NVIDIA NIM (Nemotron models) and OpenRouter.
// Both speak POST {base}/chat/completions. Each provider has an ordered model list: when a model is
// overloaded, rate-limited, missing or slow, the next one is tried within the same deadline. Every
// failure becomes an LlmError (same kinds as the Gemini helper), so a seller can map it to a 5xx that is
// never settled. API keys stay server-side; they are never logged or put in an error message.

import { LlmError } from "./gemini.ts";
import { env } from "./env.ts";

export type ChatProvider = "nvidia" | "openrouter";

interface ProviderInfo {
  label: string;
  base: string;
  keyEnv: string;
  modelsEnv: string;
  defaultModels: string[];
  extraBody?: (model: string) => Record<string, unknown>;
  headers?: Record<string, string>;
}

const PROVIDERS: Record<ChatProvider, ProviderInfo> = {
  nvidia: {
    label: "NVIDIA NIM",
    base: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    modelsEnv: "NVIDIA_MODELS",
    // Ultra first (the strongest); Super is the fast fallback when Ultra is overloaded.
    defaultModels: ["nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3-super-120b-a12b"],
    // Nemotron 3 "thinking" adds tens of seconds; a seller has to answer inside the payment window.
    extraBody: (model) => (/nemotron-3/.test(model) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  },
  openrouter: {
    label: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    modelsEnv: "OPENROUTER_MODELS",
    defaultModels: ["deepseek/deepseek-v4-flash", "mistralai/mistral-small-3.2-24b-instruct"],
    headers: { "X-Title": "Dronacharya agent marketplace" },
  },
};

export function chatConfigured(provider: ChatProvider): boolean {
  return Boolean(env(PROVIDERS[provider].keyEnv));
}

export function chatModels(provider: ChatProvider): string[] {
  const configured = env(PROVIDERS[provider].modelsEnv);
  const list = configured ? configured.split(",").map((m) => m.trim()).filter(Boolean) : [];
  return list.length ? list : PROVIDERS[provider].defaultModels;
}

export interface ChatRequest {
  provider: ChatProvider;
  system: string;
  prompt: string;
  signal?: AbortSignal;
  /** Overall deadline across every model tried. Default 35 s. */
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  /** Test hook. */
  fetchImpl?: typeof fetch;
}

type Attempt = { ok: true; text: string; model: string } | { ok: false; error: LlmError; tryNext: boolean };

async function attempt(info: ProviderInfo, key: string, model: string, req: ChatRequest, timeoutMs: number): Promise<Attempt> {
  const signals = [AbortSignal.timeout(timeoutMs), ...(req.signal ? [req.signal] : [])];
  let res: Response;
  try {
    res = await (req.fetchImpl ?? fetch)(`${info.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}`, ...info.headers },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
        temperature: req.temperature ?? 0.3,
        max_tokens: req.maxTokens ?? 2048,
        stream: false,
        ...info.extraBody?.(model),
      }),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (req.signal?.aborted) throw err;
    const timedOut = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
    return { ok: false, error: new LlmError(timedOut ? "busy" : "unreachable", `${info.label} ${model} ${timedOut ? "timed out" : "unreachable"}`), tryNext: true };
  }
  if (!res.ok) {
    const s = res.status;
    if (s === 401 || s === 403) return { ok: false, error: new LlmError("unavailable", `${info.label} rejected the API key`), tryNext: false };
    if (s === 402) return { ok: false, error: new LlmError("unavailable", `${info.label} account has no credits left`), tryNext: false };
    if (s === 429) return { ok: false, error: new LlmError("busy", `${info.label} rate limit reached`), tryNext: true };
    if (s === 400 || s === 404 || s === 422) return { ok: false, error: new LlmError("rejected", `${info.label} rejected the request for ${model} (HTTP ${s})`), tryNext: true };
    return { ok: false, error: new LlmError(s === 503 ? "busy" : "error", `${info.label} ${model} answered HTTP ${s}`), tryNext: true };
  }
  let body: { model?: string; choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, error: new LlmError("bad_output", `${info.label} returned invalid JSON`), tryNext: true };
  }
  const choice = body.choices?.[0];
  if (choice?.finish_reason === "content_filter") return { ok: false, error: new LlmError("blocked", `${info.label} filtered the answer`), tryNext: false };
  if (choice?.finish_reason === "length") return { ok: false, error: new LlmError("truncated", `${info.label} ran out of output tokens`), tryNext: true };
  const text = choice?.message?.content?.trim();
  if (!text) return { ok: false, error: new LlmError("bad_output", `${info.label} ${model} returned no text`), tryNext: true };
  return { ok: true, text, model: body.model ?? model };
}

/** Plain text completion with model fallback. */
export async function chatText(req: ChatRequest): Promise<{ text: string; model: string }> {
  const info = PROVIDERS[req.provider];
  const key = env(info.keyEnv);
  if (!key) throw new LlmError("unavailable", `${info.keyEnv} is not set`);
  const models = chatModels(req.provider);
  const deadline = Date.now() + (req.timeoutMs ?? 35_000);
  let last: LlmError = new LlmError("error", `${info.label}: no model answered`);
  for (let i = 0; i < models.length; i++) {
    const left = deadline - Date.now();
    if (left < 1500) break;
    // Leave the later models some time: the first of several gets at most 60% of what is left.
    const budget = i < models.length - 1 ? Math.max(4000, Math.floor(left * 0.6)) : left;
    const out = await attempt(info, key, models[i]!, req, Math.min(budget, left));
    if (out.ok) return { text: out.text, model: out.model };
    last = out.error;
    if (!out.tryNext) break;
  }
  throw last;
}

/** JSON completion: asks for JSON, tolerates code fences or prose around one JSON object, and parses it. */
export async function chatJson<T>(req: ChatRequest): Promise<{ value: T; model: string }> {
  const { text, model } = await chatText({ ...req, system: `${req.system}\nAnswer with one JSON object only: no prose, no code fences.` });
  const value = extractJson(text);
  if (value === undefined) throw new LlmError("bad_output", "the model did not return valid JSON");
  return { value: value as T, model };
}

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const candidate of [fenced, text, sliceObject(text)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

function sliceObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}
