import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { HttpError, LlmError, geminiGenerate, geminiJson, setGeminiClient, type GeminiClient } from "@dron/shared";
import { summarise } from "../../apps/sellers/inference/src/summarise.ts";

type Reply = Record<string, unknown> | Error;
function fake(reply: Reply | ((params: Record<string, unknown>) => Reply)): GeminiClient & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    models: {
      async generateContent(params) {
        calls.push(params);
        const r = typeof reply === "function" ? reply(params) : reply;
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}
const statusError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const req = { model: "gemini-test", system: "sys", prompt: "hi" };

afterEach(() => setGeminiClient(undefined));

describe("Gemini helper", () => {
  it("sends system instruction, JSON schema and abort signal; parses JSON (fenced or not)", async () => {
    const client = fake({ text: '```json\n{"ok":true}\n```', modelVersion: "gemini-test-001", candidates: [{ finishReason: "STOP" }] });
    setGeminiClient(client);
    const ac = new AbortController();
    const out = await geminiJson<{ ok: boolean }>({ ...req, jsonSchema: { type: "object" }, signal: ac.signal });
    assert.deepEqual(out, { value: { ok: true }, model: "gemini-test-001" });
    const config = client.calls[0]!.config as Record<string, unknown>;
    assert.equal(config.systemInstruction, "sys");
    assert.equal(config.responseMimeType, "application/json");
    assert.deepEqual(config.responseJsonSchema, { type: "object" });
    assert.equal(config.abortSignal, ac.signal);
  });

  const failures: [string, Reply, string][] = [
    ["a blocked prompt", { promptFeedback: { blockReason: "SAFETY" } }, "blocked"],
    ["a safety stop", { text: "x", candidates: [{ finishReason: "SAFETY" }] }, "blocked"],
    ["running out of tokens", { text: '{"a"', candidates: [{ finishReason: "MAX_TOKENS" }] }, "truncated"],
    ["an empty answer", { text: "", candidates: [{ finishReason: "STOP" }] }, "bad_output"],
    ["a bad API key", statusError(403), "unavailable"],
    ["quota exhausted", statusError(429), "busy"],
    ["an unknown model", statusError(404), "rejected"],
    ["a server error", statusError(500), "error"],
    ["a network failure", new TypeError("fetch failed"), "unreachable"],
  ];
  for (const [label, reply, kind] of failures) {
    it(`maps ${label} to LlmError(${kind})`, async () => {
      setGeminiClient(fake(reply));
      await assert.rejects(geminiGenerate(req), (err: unknown) => err instanceof LlmError && err.kind === kind);
    });
  }

  it("rejects invalid JSON", async () => {
    setGeminiClient(fake({ text: "not json", candidates: [{ finishReason: "STOP" }] }));
    await assert.rejects(geminiJson({ ...req, jsonSchema: {} }), (err: unknown) => err instanceof LlmError && err.kind === "bad_output");
  });

  it("without GEMINI_API_KEY the call fails as unavailable (and a seller answers 503)", async () => {
    const saved = { g: process.env.GEMINI_API_KEY, k: process.env.GOOGLE_API_KEY };
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      await assert.rejects(geminiGenerate(req), (err: unknown) => err instanceof LlmError && err.kind === "unavailable");
    } finally {
      if (saved.g !== undefined) process.env.GEMINI_API_KEY = saved.g;
      if (saved.k !== undefined) process.env.GOOGLE_API_KEY = saved.k;
    }
  });
});

describe("inference seller on Gemini: nothing unusable is ever sold", () => {
  const input = { texts: ["Title: A\n\nA story.", "Title: B\n\nAnother."], style: "summary" as const, maxSentences: 2 };
  const signal = new AbortController().signal;

  it("returns validated Hindi results in order", async () => {
    setGeminiClient(fake({ text: JSON.stringify({ results: [{ index: 1, text: "दूसरी कहानी।" }, { index: 0, text: "पहली कहानी।" }] }), modelVersion: "g", candidates: [{ finishReason: "STOP" }] }));
    const out = await summarise(input, signal);
    assert.deepEqual(out.results.map((r) => r.text), ["पहली कहानी।", "दूसरी कहानी।"]);
    assert.equal(out.language, "hi");
  });

  const refusals: [string, Reply, number, string][] = [
    ["English instead of Hindi", { text: JSON.stringify({ results: [{ index: 0, text: "A story." }, { index: 1, text: "Another." }] }), candidates: [{ finishReason: "STOP" }] }, 502, "model_output_not_hindi"],
    ["a missing result", { text: JSON.stringify({ results: [{ index: 0, text: "कहानी" }] }), candidates: [{ finishReason: "STOP" }] }, 502, "model_incomplete"],
    ["a safety block", { promptFeedback: { blockReason: "OTHER" } }, 502, "model_refused"],
    ["quota exhausted", statusError(429), 503, "inference_busy"],
  ];
  for (const [label, reply, status, code] of refusals) {
    it(`${label} -> HTTP ${status} ${code} (never settled)`, async () => {
      setGeminiClient(fake(reply));
      await assert.rejects(summarise(input, signal), (err: unknown) => err instanceof HttpError && err.status === status && err.code === code);
    });
  }
});
