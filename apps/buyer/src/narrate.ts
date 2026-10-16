// Optional plain-English narrative of what was bought, written by Gemini. The deterministic explanation
// (report.ts) is the record; this is a readable retelling generated only from that record's JSON.

import { DEFAULT_GEMINI_MODEL, env, geminiGenerate } from "@dron/shared";

const SYSTEM = `You explain to a user what their buyer agent did. You receive a JSON record of the task, the answer it produced and every paid call (seller, status, amounts in USDC, reasons).
Write 4-8 plain English sentences: what was bought, from whom, why those sellers, what went wrong if anything (refusals, rejected output, fallbacks, budget), and the total cost against the budget.
Use only facts present in the JSON. Every amount, count and seller name you mention must appear in it; do not round amounts. No headings, no lists, no markdown.`;

export type Narrator = (facts: unknown, signal?: AbortSignal) => Promise<string>;

export const narrateWithGemini: Narrator = async (facts, signal) => {
  const { text } = await geminiGenerate({
    model: env("BUYER_MODEL", DEFAULT_GEMINI_MODEL)!,
    system: SYSTEM,
    prompt: `<record>\n${JSON.stringify(facts)}\n</record>`,
    signal,
    timeoutMs: 30_000,
    temperature: 0.2,
  });
  return text;
};
