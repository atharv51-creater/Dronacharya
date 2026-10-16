import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileSchema } from "@dron/shared";
import { devanagariShare } from "../../apps/sellers/inference/src/summarise.ts";

describe("Hindi output self-check", () => {
  it("measures the share of Devanagari letters, ignoring digits and punctuation", () => {
    assert.equal(devanagariShare("यह पुस्तक बहुत अच्छी है।"), 1);
    assert.equal(devanagariShare("This book is great."), 0);
    assert.equal(devanagariShare("कीमत ₹6,555 है"), 1);
    assert.ok(devanagariShare("यह Sapiens नामक पुस्तक है") >= 0.5, "a Latin title inside Hindi text still passes");
    assert.ok(devanagariShare("Sapiens is a book, यह") < 0.5, "mostly-English output fails");
    assert.equal(devanagariShare("12345 !!"), 0);
  });

  it("the listed output schema rejects results without any Devanagari", () => {
    const validate = compileSchema({ type: "string", pattern: "[\\u0900-\\u097F]" });
    assert.equal(validate("यह अच्छा है"), true);
    assert.equal(validate("this is fine"), false);
  });
});

describe("Hindi output self-check on realistic summaries", () => {
  it("passes a summary that keeps an English book title", () => {
    const s = "\"A Light in the Attic\" शेल सिल्वरस्टीन की कविताओं और चित्रों का एक क्लासिक संग्रह है, जो बच्चों और बड़ों दोनों को हँसाता है।";
    assert.ok(devanagariShare(s) >= 0.5, String(devanagariShare(s)));
  });
});
