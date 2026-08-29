/**
 * php-parser type slots are `typereference` (a builtin keyword), `name` (a class), `uniontype` /
 * `intersectiontype` (members in `.types`), or null. `?T` arrives as `nullable: true` beside a bare
 * `T`, while `T|null` arrives as a union; both end up as `T | null`.
 */
export type TypeNode =
  | { kind?: string; name?: string | null; types?: TypeNode[]; [key: string]: unknown }
  | null
  | undefined;

// PHP's declared keywords plus the docblock-only spellings (`integer`, `double`, `boolean`, `scalar`).
const TS_TYPES: Record<string, string> = {
  int: "number",
  integer: "number",
  float: "number",
  double: "number",
  string: "string",
  bool: "boolean",
  boolean: "boolean",
  true: "true",
  false: "false",
  void: "void",
  null: "null",
  never: "never",
  mixed: "any",
  scalar: "string | number | boolean",
  array: "PhpArray",
  object: "Record<string, unknown>",
  callable: "unknown",
  iterable: "unknown",
  static: "Record<string, unknown>",
  self: "Record<string, unknown>",
};

/** Split a converted type on its own ` | ` joiner, at bracket depth 0 only. */
function members(type: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < type.length; i++) {
    const ch = type[i]!;
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && type.startsWith(" | ", i)) {
      out.push(type.slice(start, i));
      start = i + 3;
      i += 2;
    }
  }
  out.push(type.slice(start));
  return out;
}

/**
 * Dedupe and join as a union; `any` swallows every other member. A part is split into its own
 * members first, because one part can already be a union — one PHP alias expanding to several
 * (`scalar|string` is three, not four), or `?int[]` having converted to `number[] | null`, which
 * compared whole would keep both nulls in `?int[]|null`. Depth 0 only, so `(string | null)[]` and
 * `Record<string, a | b>` stay one member.
 */
function union(parts: string[]): string {
  const unique = [
    ...new Set(
      parts
        .flatMap(members)
        .map((atom) => atom.trim())
        .filter(Boolean),
    ),
  ];
  if (unique.length === 0 || unique.includes("any")) return "any";
  return unique.join(" | ");
}

/**
 * The TypeScript type for a PHP type name, if it is one we map. `Object.hasOwn` because a PHP name
 * of `__proto__` or `toString` otherwise finds `Object.prototype` and is returned instead of a type.
 */
function tsType(name: string): string | undefined {
  const key = name.toLowerCase();
  return Object.hasOwn(TS_TYPES, key) ? TS_TYPES[key] : undefined;
}

/** Convert a php-parser type node into a TypeScript type. */
export function phpTypeToTs(node: TypeNode): string {
  if (!node) return "any";
  switch (node.kind) {
    case "uniontype":
      return union((node.types ?? []).map(phpTypeToTs));
    // Always class types, which cannot be modelled.
    case "intersectiontype":
      return "unknown";
    case "typereference":
      return tsType(node.name ?? "") ?? "any";
    // `json_encode` turns an object into its public properties.
    case "name":
      return "Record<string, unknown>";
    default:
      return "any";
  }
}

/** `T | null`, unless `T` already covers it. */
export function nullable(type: string): string {
  const covered = type === "any" || type === "void" || type.split(" | ").includes("null");
  return covered ? type : `${type} | null`;
}

/** Unions must be wrapped before `[]` binds. */
export function parenthesised(type: string): string {
  return type.includes(" | ") ? `(${type})` : type;
}

/**
 * How deep a docblock type may nest before it degrades to `any`. `docTypeToTs` and `convertDocPart`
 * recurse into each other, and without a cap a pathological `@param` overflows the stack — a
 * `RangeError` out of `parsePhp`, which promises to throw only `PhpParseError`.
 */
const MAX_DOC_DEPTH = 32;

/** A docblock type (`int|null`, `?string`, `int[]`, `array<string, int>`) as a TypeScript type. */
export function docTypeToTs(raw: string, depth = 0): string {
  if (depth > MAX_DOC_DEPTH) return "any";
  // Split on top-level `|` only: `array<int|string>` is one part.
  return union(
    splitTopLevel(raw.trim(), "|")
      .filter(Boolean)
      .map((part) => convertDocPart(part, depth + 1)),
  );
}

function convertDocPart(part: string, depth = 0): string {
  if (depth > MAX_DOC_DEPTH) return "any";
  let text = part.trim();

  if (text.startsWith("?")) return union([convertDocPart(text.slice(1), depth + 1), "null"]);

  let arrayDepth = 0;
  while (text.endsWith("[]")) {
    text = text.slice(0, -2);
    arrayDepth++;
  }
  if (arrayDepth > 0) {
    return parenthesised(convertDocPart(text, depth + 1)) + "[]".repeat(arrayDepth);
  }

  if (text.startsWith("(") && text.endsWith(")")) return docTypeToTs(text.slice(1, -1), depth + 1);

  const generic = /^(array|list|iterable)\s*<(.+)>$/i.exec(text);
  if (generic) {
    const args = splitTopLevel(generic[2] ?? "", ",").filter(Boolean);
    const value = args.length > 1 ? args[1] : args[0];
    const inner = value ? docTypeToTs(value, depth + 1) : "PhpValue";
    // Integer keys describe a list; anything else is a string-keyed record.
    const keyed = args.length > 1 && !/^(int|integer)$/i.test(args[0] ?? "");
    return keyed ? `Record<string, ${inner}>` : `${parenthesised(inner)}[]`;
  }

  // Anything unknown is a class name.
  return tsType(text) ?? "Record<string, unknown>";
}

/** Split on `separator` at depth 0 only, honouring `<>`, `()` and `{}`. */
function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if ("<({".includes(ch)) depth++;
    else if (">)}".includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out;
}
