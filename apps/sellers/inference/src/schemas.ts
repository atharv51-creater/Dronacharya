import type { JsonSchema } from "@dron/shared";

export const inputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["texts"],
  properties: {
    texts: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: { type: "string", minLength: 1, maxLength: 6000 },
      description: "One or two source texts (for example book descriptions)",
    },
    style: { type: "string", enum: ["summary", "pitch", "guide"], default: "summary" },
    maxSentences: { type: "integer", minimum: 1, maximum: 5, default: 2 },
  },
};

export const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["language", "style", "model", "results"],
  properties: {
    language: { const: "hi" },
    style: { type: "string", enum: ["summary", "pitch", "guide"] },
    model: { type: "string" },
    results: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "text"],
        properties: {
          index: { type: "integer", minimum: 0, maximum: 1 },
          // must contain Devanagari: an English or empty "summary" breaks the schema
          text: { type: "string", minLength: 1, pattern: "[\\u0900-\\u097F]" },
        },
      },
    },
  },
};
