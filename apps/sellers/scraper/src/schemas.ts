import type { JsonSchema } from "@dron/shared";

export const scrapeInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    page: { type: "integer", minimum: 1, maximum: 1000, default: 1, description: "Catalogue page number (20 books per page)" },
    category: {
      type: "string",
      minLength: 1,
      maxLength: 60,
      pattern: "^[A-Za-z0-9 _'&,-]+$",
      description: 'Optional category name or slug, e.g. "Travel" or "historical-fiction"',
    },
  },
};

export const scrapeOutputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source", "page", "totalPages", "hasNext", "category", "books"],
  properties: {
    source: { type: "string", format: "uri" },
    page: { type: "integer", minimum: 1 },
    totalPages: { type: "integer", minimum: 1 },
    hasNext: { type: "boolean" },
    category: { type: ["string", "null"] },
    books: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "priceGbp", "rating", "inStock", "availability", "url", "upc", "description"],
        properties: {
          title: { type: "string", minLength: 1 },
          priceGbp: { type: "number", minimum: 0 },
          rating: { type: "integer", minimum: 1, maximum: 5 },
          inStock: { type: "boolean" },
          availability: { type: "string" },
          url: { type: "string", format: "uri" },
          upc: { type: "string" },
          description: { type: "string" },
        },
      },
    },
  },
};
