// JSON Schema compilation that accepts what other teams will actually send: draft-07 (Ajv's default)
// and draft 2020-12 / 2019-09 (common in newer tooling). Unknown keywords are tolerated.

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import Ajv2019 from "ajv/dist/2019.js";
import addFormats from "ajv-formats";
import type { JsonSchema } from "./types.ts";

type AnyAjv = InstanceType<typeof Ajv>;

function make<T extends new (opts: object) => AnyAjv>(Ctor: T, coerce: boolean): AnyAjv {
  const ajv = new Ctor({ allErrors: true, strict: false, coerceTypes: coerce, useDefaults: coerce });
  addFormats(ajv);
  return ajv;
}

const instances = {
  plain: { d7: make(Ajv, false), d2019: make(Ajv2019, false), d2020: make(Ajv2020, false) },
  coerce: { d7: make(Ajv, true), d2019: make(Ajv2019, true), d2020: make(Ajv2020, true) },
};

function pick(schema: JsonSchema, coerce: boolean): AnyAjv {
  const set = coerce ? instances.coerce : instances.plain;
  const uri = typeof schema.$schema === "string" ? schema.$schema : "";
  if (uri.includes("2020-12")) return set.d2020;
  if (uri.includes("2019-09")) return set.d2019;
  return set.d7;
}

/**
 * Compiles a schema. `coerce` turns "3" into 3 and fills defaults, which is what query-string input needs;
 * output validation never coerces, so a seller cannot pass by returning the wrong types.
 */
export function compileSchema(schema: JsonSchema, opts: { coerce?: boolean } = {}): ValidateFunction {
  const { $id: _ignored, ...rest } = schema; // $id collisions across listings would make Ajv throw
  return pick(schema, opts.coerce ?? false).compile(rest);
}

export function formatErrors(errors: ErrorObject[] | null | undefined, limit = 5): string[] {
  return (errors ?? []).slice(0, limit).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`);
}

export type { ValidateFunction };
