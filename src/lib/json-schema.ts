/**
 * Minimal JSON Schema helpers for the strict-mode subset OpenRouter providers accept:
 * type (string or [type, "null"]), properties, required (every key), additionalProperties: false,
 * enum, items, description, plus anyOf for nullable fields. Length/size/range limits are NOT part of
 * the subset: zod enforces them (IMPLEMENTATION_PLAN.md section 5, "Verified API notes").
 *
 * Used by types.ts to self-check INVOICE_JSON_SCHEMA against the zod schema. Not a general validator.
 * Pure module (no Node APIs). Owner: contracts step (docs/CONTRACTS.md).
 */

export type JsonType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

export interface JsonSchemaNode {
  type?: JsonType | readonly JsonType[];
  description?: string;
  enum?: readonly (string | number | boolean | null)[];
  properties?: Readonly<Record<string, JsonSchemaNode>>;
  required?: readonly string[];
  additionalProperties?: false;
  items?: JsonSchemaNode;
  anyOf?: readonly JsonSchemaNode[];
}

/** Structural summary used to compare two schemas (ignores descriptions and length/range keywords). */
export type CanonShape =
  | { kind: "object"; nullable: boolean; props: Record<string, CanonShape>; required: string[] }
  | { kind: "array"; nullable: boolean; items: CanonShape | null }
  | {
      kind: "string" | "number" | "integer" | "boolean";
      nullable: boolean;
      enum: (string | number | boolean)[] | null;
    };

const SUBSET_KEYWORDS = new Set([
  "type",
  "description",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
]);

function typesOf(node: JsonSchemaNode): JsonType[] {
  if (node.type === undefined) return [];
  return typeof node.type === "string" ? [node.type] : [...node.type];
}

function matchesType(value: unknown, t: JsonType): boolean {
  switch (t) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Validates `value` against a strict-subset schema. Returns readable errors; [] means valid. */
export function validateJsonSubset(schema: JsonSchemaNode, value: unknown, at = "$"): string[] {
  if (schema.anyOf) {
    const branches = schema.anyOf.map((b) => validateJsonSubset(b, value, at));
    if (branches.some((e) => e.length === 0)) return [];
    return [`${at}: matches no anyOf branch (${branches.map((e) => e[0]).join(" | ")})`];
  }
  const types = typesOf(schema);
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    return [`${at}: expected ${types.join(" | ")}, got ${describe(value)}`];
  }
  const errors: string[] = [];
  if (schema.enum && !(schema.enum as readonly unknown[]).includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (matchesType(value, "object") && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${at}.${key}: required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in schema.properties)) errors.push(`${at}.${key}: not allowed (additionalProperties: false)`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in obj) errors.push(...validateJsonSubset(sub, obj[key], `${at}.${key}`));
    }
  }
  const items = schema.items;
  if (Array.isArray(value) && items) {
    value.forEach((item, i) => errors.push(...validateJsonSubset(items, item, `${at}[${i}]`)));
  }
  return errors;
}

/**
 * Lints a schema for the strict-mode common subset: only subset keywords, every object has
 * additionalProperties: false and lists every property in `required`, every array has `items`.
 */
export function lintStrictSubset(schema: JsonSchemaNode, at = "$"): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!SUBSET_KEYWORDS.has(key)) errors.push(`${at}: keyword "${key}" is outside the strict subset`);
  }
  if (schema.anyOf) {
    if (schema.type !== undefined) errors.push(`${at}: use either type or anyOf, not both`);
    schema.anyOf.forEach((b, i) => errors.push(...lintStrictSubset(b, `${at}.anyOf[${i}]`)));
    return errors;
  }
  const types = typesOf(schema);
  if (types.length === 0) errors.push(`${at}: missing type`);
  if (types.includes("object")) {
    const props = Object.keys(schema.properties ?? {});
    if (!schema.properties) errors.push(`${at}: object without properties`);
    if (schema.additionalProperties !== false) errors.push(`${at}: object must set additionalProperties: false`);
    const required = [...(schema.required ?? [])].sort();
    if (JSON.stringify(required) !== JSON.stringify([...props].sort())) {
      errors.push(`${at}: required must list every property (strict mode)`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      errors.push(...lintStrictSubset(sub, `${at}.${key}`));
    }
  }
  if (types.includes("array")) {
    if (!schema.items) errors.push(`${at}: array without items`);
    else errors.push(...lintStrictSubset(schema.items, `${at}[]`));
  }
  return errors;
}

/**
 * Reduces a schema (hand-written subset, or zod's z.toJSONSchema() output) to its structure:
 * kinds, nullability, property names, required lists and enums.
 */
export function canonicalShape(node: JsonSchemaNode): CanonShape {
  if (node.anyOf) {
    const nonNull = node.anyOf.filter((b) => !(typesOf(b).length === 1 && typesOf(b)[0] === "null"));
    const nullable = nonNull.length < node.anyOf.length;
    if (nonNull.length !== 1) throw new Error("canonicalShape: anyOf must be exactly one type plus optional null");
    const inner = canonicalShape(nonNull[0]);
    return { ...inner, nullable: inner.nullable || nullable };
  }
  const types = typesOf(node);
  const nullable = types.includes("null");
  const rest = types.filter((t) => t !== "null");
  if (rest.length !== 1) throw new Error(`canonicalShape: unsupported type ${JSON.stringify(node.type)}`);
  const kind = rest[0];
  if (kind === "object") {
    const props: Record<string, CanonShape> = {};
    for (const [key, sub] of Object.entries(node.properties ?? {})) props[key] = canonicalShape(sub);
    return { kind, nullable, props, required: [...(node.required ?? [])].sort() };
  }
  if (kind === "array") return { kind, nullable, items: node.items ? canonicalShape(node.items) : null };
  const values = node.enum ? node.enum.filter((v): v is string | number | boolean => v !== null) : null;
  return { kind, nullable, enum: values ? [...values].map(String).sort() : null };
}

/** Lists structural differences between two canonical shapes; [] means they agree. */
export function diffShapes(a: CanonShape, b: CanonShape, at = "$"): string[] {
  if (a.kind !== b.kind) return [`${at}: ${a.kind} vs ${b.kind}`];
  const out: string[] = [];
  if (a.nullable !== b.nullable) out.push(`${at}: nullable ${a.nullable} vs ${b.nullable}`);
  if (a.kind === "object" && b.kind === "object") {
    const keys = new Set([...Object.keys(a.props), ...Object.keys(b.props)]);
    for (const key of keys) {
      if (!(key in a.props)) out.push(`${at}.${key}: only in the second schema`);
      else if (!(key in b.props)) out.push(`${at}.${key}: only in the first schema`);
      else out.push(...diffShapes(a.props[key], b.props[key], `${at}.${key}`));
    }
    if (JSON.stringify(a.required) !== JSON.stringify(b.required)) out.push(`${at}: required lists differ`);
  } else if (a.kind === "array" && b.kind === "array") {
    if (a.items && b.items) out.push(...diffShapes(a.items, b.items, `${at}[]`));
    else if (a.items !== b.items) out.push(`${at}[]: items missing on one side`);
  } else if ("enum" in a && "enum" in b && JSON.stringify(a.enum) !== JSON.stringify(b.enum)) {
    out.push(`${at}: enum ${JSON.stringify(a.enum)} vs ${JSON.stringify(b.enum)}`);
  }
  return out;
}

/**
 * Rewrites nullable type arrays ({ type: ["string", "null"] }) as
 * { anyOf: [{ type: "string" }, { type: "null" }] }. Use it only if a provider's strict mode rejects
 * type arrays (unverified, see docs/CONTRACTS.md "Unverified"). Descriptions stay on the outer node.
 */
export function withAnyOfNulls(node: JsonSchemaNode): JsonSchemaNode {
  const { type, description, properties, items, anyOf, ...rest } = node;
  const mapped: JsonSchemaNode = { ...rest };
  if (properties) {
    mapped.properties = Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, withAnyOfNulls(v)]));
  }
  if (items) mapped.items = withAnyOfNulls(items);
  if (anyOf) mapped.anyOf = anyOf.map(withAnyOfNulls);
  const types = typesOf({ type });
  if (types.length === 2 && types.includes("null")) {
    const base = types.find((t) => t !== "null") as JsonType;
    return { ...(description ? { description } : {}), anyOf: [{ ...mapped, type: base }, { type: "null" }] };
  }
  return { ...(type !== undefined ? { type } : {}), ...(description ? { description } : {}), ...mapped };
}
