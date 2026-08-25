/**
 * Maps PHP type declarations (and docblock type strings) onto TypeScript types.
 *
 * php-parser represents a type slot as one of:
 *   - `typereference` — a builtin keyword (`int`, `string`, `array`, `void`, ...)
 *   - `name`          — a class/interface reference, with a `resolution` field
 *   - `uniontype` / `intersectiontype` — with the members in `.types`
 * ...or `null` when the declaration has no type hint at all.
 *
 * Nullability has two spellings that produce structurally different ASTs:
 * `?T` sets the sibling boolean `nullable: true` and leaves `type` as bare `T`,
 * while `T|null` is a `uniontype` holding a `null` typereference. Both are
 * normalised to `T | null` here.
 */

export type TypeNode =
  | {
      kind?: string;
      name?: string | null;
      types?: TypeNode[];
      [key: string]: unknown;
    }
  | null
  | undefined;

const BUILTIN_TS: Record<string, string> = {
  int: "number",
  float: "number",
  string: "string",
  bool: "boolean",
  true: "true",
  false: "false",
  void: "void",
  null: "null",
  never: "never",
  mixed: "any",
  array: "PhpArray",
  object: "Record<string, unknown>",
  callable: "unknown",
  iterable: "unknown",
  static: "Record<string, unknown>",
  self: "Record<string, unknown>",
};

/** Deduplicate while preserving order, then join as a union. */
function union(parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  if (out.length === 0) return "any";
  // `any` swallows every other member.
  if (out.includes("any")) return "any";
  return out.join(" | ");
}

/** Convert a php-parser type node into a TypeScript type expression. */
export function phpTypeToTs(node: TypeNode, nullable = false): string {
  const base = convert(node);
  if (!nullable) return base;
  if (base === "any" || base === "void" || base.split(" | ").includes("null")) {
    return base;
  }
  return union([base, "null"]);
}

function convert(node: TypeNode): string {
  if (!node) return "any";

  switch (node.kind) {
    case "uniontype":
      return union((node.types ?? []).map((t) => convert(t)));

    // An intersection is always of class types, which we cannot model.
    case "intersectiontype":
      return "unknown";

    case "typereference": {
      const name = (node.name ?? "").toLowerCase();
      return BUILTIN_TS[name] ?? "any";
    }

    case "name":
      // A class reference. `json_encode` turns objects into their public
      // properties, so an object shape is the honest mapping.
      return "Record<string, unknown>";

    default:
      return "any";
  }
}

/**
 * Convert a docblock type string (`int|null`, `?string`, `int[]`, `array<int>`)
 * into a TypeScript type. Used only where a real type declaration is absent.
 */
export function docTypeToTs(raw: string): string {
  const text = raw.trim();
  if (!text) return "any";

  // Split on top-level `|` only — `array<int|string>` is one part, not two.
  const parts = splitTopLevel(text, "|").filter(Boolean);
  if (parts.length === 0) return "any";

  return union(parts.map(convertDocPart));
}

function convertDocPart(part: string): string {
  let text = part.trim();

  // `?T` is shorthand for `T|null`.
  if (text.startsWith("?")) {
    return union([convertDocPart(text.slice(1)), "null"]);
  }

  // `T[]` — possibly repeated, e.g. `int[][]`.
  let suffixDepth = 0;
  while (text.endsWith("[]")) {
    text = text.slice(0, -2);
    suffixDepth++;
  }
  if (suffixDepth > 0) {
    const inner = convertDocPart(text);
    // Unions must be parenthesised before `[]` binds.
    const safe = inner.includes(" | ") ? `(${inner})` : inner;
    return safe + "[]".repeat(suffixDepth);
  }

  // A parenthesised group, e.g. the element of `(int|string)[]`.
  if (text.startsWith("(") && text.endsWith(")")) {
    return docTypeToTs(text.slice(1, -1));
  }

  // `array<int>` / `array<string, int>` / `array<int, T>` / `list<int>`.
  const generic = /^(array|list|iterable)\s*<(.+)>$/i.exec(text);
  if (generic) {
    const args = splitTopLevel(generic[2] ?? "", ",").filter(Boolean);
    const value = args.length > 1 ? args[1] : args[0];
    // Recurse through docTypeToTs so a union value type survives intact.
    const inner = value ? docTypeToTs(value) : "PhpValue";
    // Integer keys describe a list, so `array<int, T>` is `T[]` rather than a
    // string-keyed record.
    const keyed = args.length > 1 && !/^(int|integer)$/i.test((args[0] ?? "").trim());
    if (!keyed) {
      const safe = inner.includes(" | ") ? `(${inner})` : inner;
      return `${safe}[]`;
    }
    return `Record<string, ${inner}>`;
  }

  const lower = text.toLowerCase();
  if (lower in BUILTIN_TS) return BUILTIN_TS[lower] as string;
  if (lower === "integer") return "number";
  if (lower === "double") return "number";
  if (lower === "boolean") return "boolean";
  if (lower === "scalar") return "string | number | boolean";

  // Anything else is a class name.
  return "Record<string, unknown>";
}

/** Split on a separator at depth 0 only, honouring `<>`, `()` and `{}`. */
function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "<" || ch === "(" || ch === "{") depth++;
    else if (ch === ">" || ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out;
}
