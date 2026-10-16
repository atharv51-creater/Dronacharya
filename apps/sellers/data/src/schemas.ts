import type { JsonSchema } from "@dron/shared";

const currency = { type: "string", pattern: "^[A-Za-z]{3}$", description: "ISO 4217 code, e.g. GBP" };

export const inputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to"],
  properties: { from: currency, to: currency },
};

export const outputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to", "rate", "date", "source", "fetchedAt"],
  properties: {
    from: { type: "string", pattern: "^[A-Z]{3}$" },
    to: { type: "string", pattern: "^[A-Z]{3}$" },
    rate: { type: "number", exclusiveMinimum: 0 },
    date: { type: "string", format: "date" },
    source: { type: "string" },
    fetchedAt: { type: "string", format: "date-time" },
  },
};
