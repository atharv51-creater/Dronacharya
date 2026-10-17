// text-insights: deterministic text statistics, no model involved. Per text: words, sentences, reading time,
// Flesch reading ease (English), script, and the top keyphrases by RAKE (Rapid Automatic Keyword Extraction).

import type { PaidRoute } from "@dron/x402-kit";

const STOPWORDS = new Set(
  (
    "a about above after again against all am an and any are as at be because been before being below between both but by can could did do does " +
    "doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just " +
    "me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the " +
    "their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who " +
    "whom why will with would you your yours yourself yourselves also one two may might must shall upon yet still even ever every much many like"
  ).split(" "),
);

export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

export function rakeKeywords(text: string, limit = 8): { term: string; score: number }[] {
  const phrases: string[][] = [];
  for (const chunk of text.toLowerCase().split(/[.,;:!?()"“”‘’\[\]{}\n\r\t।|/\\]+|\s[-–—]+\s/)) {
    let current: string[] = [];
    for (const raw of chunk.split(/\s+/)) {
      const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (!word || STOPWORDS.has(word) || /^\d+$/.test(word)) {
        if (current.length) phrases.push(current);
        current = [];
      } else current.push(word);
    }
    if (current.length) phrases.push(current);
  }
  const freq = new Map<string, number>();
  const degree = new Map<string, number>();
  for (const p of phrases) {
    if (p.length > 4) continue;
    for (const w of p) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
      degree.set(w, (degree.get(w) ?? 0) + p.length - 1);
    }
  }
  const scores = new Map<string, number>();
  for (const p of phrases) {
    if (p.length > 4) continue;
    const term = p.join(" ");
    if (term.length < 3 || scores.has(term)) continue;
    scores.set(term, p.reduce((s, w) => s + ((degree.get(w) ?? 0) + (freq.get(w) ?? 0)) / (freq.get(w) ?? 1), 0));
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, score]) => ({ term, score: Math.round(score * 100) / 100 }));
}

export function analyseText(text: string, index: number) {
  const letters = text.match(/\p{L}/gu) ?? [];
  const latin = letters.filter((c) => /[A-Za-z]/.test(c)).length;
  const deva = letters.filter((c) => /[ऀ-ॿ]/u.test(c)).length;
  const script = letters.length === 0 ? "other" : latin / letters.length >= 0.6 ? "latin" : deva / letters.length >= 0.6 ? "devanagari" : "other";
  const words = text.match(/[\p{L}\p{M}\p{N}'’-]+/gu) ?? [];
  const sentences = Math.max(1, (text.match(/[.!?।]+(\s|$)/gu) ?? []).length);
  const wordCount = words.length;
  let flesch: number | null = null;
  if (script === "latin" && wordCount > 0) {
    const syl = words.reduce((s, w) => s + syllables(w), 0);
    flesch = Math.round((206.835 - 1.015 * (wordCount / sentences) - 84.6 * (syl / wordCount)) * 10) / 10;
  }
  return {
    index,
    characters: text.length,
    words: wordCount,
    sentences,
    avgWordsPerSentence: Math.round((wordCount / sentences) * 10) / 10,
    readingMinutes: Math.round((wordCount / 230) * 10) / 10,
    fleschReadingEase: flesch,
    readingLevel: flesch === null ? null : flesch >= 70 ? "easy" : flesch >= 50 ? "standard" : flesch >= 30 ? "difficult" : "very difficult",
    script,
    keywords: script === "latin" ? rakeKeywords(text) : [],
  };
}

export const textInsights: PaidRoute = {
  id: "text-insights",
  name: "text-insights",
  category: "inference",
  description:
    "Deterministic text analytics for up to 10 texts per call (no LLM, instant): word and sentence counts, reading time, " +
    "Flesch reading ease with a reading level, script detection, and the top keyphrases (RAKE) for English texts.",
  method: "POST",
  path: "/analyse",
  priceUnits: 1000n,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["texts"],
    properties: { texts: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 20000 } } },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "characters", "words", "sentences", "avgWordsPerSentence", "readingMinutes", "fleschReadingEase", "readingLevel", "script", "keywords"],
          properties: {
            index: { type: "integer", minimum: 0 },
            characters: { type: "integer", minimum: 0 },
            words: { type: "integer", minimum: 0 },
            sentences: { type: "integer", minimum: 1 },
            avgWordsPerSentence: { type: "number" },
            readingMinutes: { type: "number", minimum: 0 },
            fleschReadingEase: { type: ["number", "null"] },
            readingLevel: { type: ["string", "null"] },
            script: { type: "string", enum: ["latin", "devanagari", "other"] },
            keywords: {
              type: "array",
              maxItems: 8,
              items: { type: "object", additionalProperties: false, required: ["term", "score"], properties: { term: { type: "string" }, score: { type: "number" } } },
            },
          },
        },
      },
    },
  },
  timeoutMs: 5_000,
  handler: async (input: { texts: string[] }) => ({ results: input.texts.map((t, i) => analyseText(t, i)) }),
};
