// Task text -> TaskSpec. Gemini first when configured, the rules parser otherwise (or when Gemini fails
// or returns something that does not validate). Whichever is used, the spec is normalised, and where the
// two readings disagree on numbers the buyer says so, so a misreading is visible before anything is bought.

import { compileSchema, formatErrors } from "@dron/shared";
import { TASK_SPEC_JSON_SCHEMA, normaliseSpec, type TaskSpec } from "../spec.ts";
import { llmAvailable, parseWithGemini } from "./llm.ts";
import { parseWithRules } from "./rules.ts";

export interface ParsedTask {
  spec: TaskSpec;
  parsedBy: string;
  notes: string[];
}

const validateSpec = compileSchema(TASK_SPEC_JSON_SCHEMA as unknown as Record<string, unknown>);

export type LlmParser = (task: string, signal?: AbortSignal) => Promise<{ spec: TaskSpec; model: string }>;

export async function parseTask(task: string, opts: { useLlm?: boolean; llm?: LlmParser; signal?: AbortSignal } = {}): Promise<ParsedTask> {
  const rules = parseWithRules(task);
  const fromRules = normaliseSpec(rules.spec);
  const notes = [...fromRules.notes];
  const llm = opts.llm ?? (opts.useLlm ?? llmAvailable() ? parseWithGemini : undefined);

  if (llm) {
    try {
      const { spec: raw, model } = await llm(task, opts.signal);
      if (!validateSpec(raw)) throw new Error(`spec failed validation: ${formatErrors(validateSpec.errors).join("; ")}`);
      const fromLlm = normaliseSpec(raw);
      const diffs = differences(fromLlm.spec, fromRules.spec);
      if (diffs.length && fromRules.spec.supported) notes.push(`the rules parser read this differently (${diffs.join("; ")}); using ${model}'s reading`);
      return { spec: fromLlm.spec, parsedBy: model, notes: [...fromLlm.notes, ...notes.filter((n) => !fromLlm.notes.includes(n))] };
    } catch (err) {
      notes.push(`LLM parser unavailable (${(err as Error).message}); used the rules parser`);
    }
  }
  return { spec: fromRules.spec, parsedBy: "rules", notes: [...notes, ...rules.recognised.filter((r) => r.startsWith("note:")).map((r) => r.slice(6))] };
}

function differences(a: TaskSpec, b: TaskSpec): string[] {
  const out: string[] = [];
  const cmp = (label: string, x: unknown, y: unknown) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${label}: ${JSON.stringify(y)} vs ${JSON.stringify(x)}`);
  };
  cmp("pages", a.pages, b.pages);
  cmp("rating", [a.filter.minRating, a.filter.maxRating], [b.filter.minRating, b.filter.maxRating]);
  cmp("selection", [a.select.mode, a.select.order, a.select.limit], [b.select.mode, b.select.order, b.select.limit]);
  cmp("categories", a.categories, b.categories);
  cmp("currencies", [...a.currencies].sort(), [...b.currencies].sort());
  return out;
}
