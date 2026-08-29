/**
 * php-parser type slots are `typereference` (a builtin keyword), `name` (a class), `uniontype` /
 * `intersectiontype` (members in `.types`), or null. `?T` arrives as `nullable: true` beside a bare
 * `T`, while `T|null` arrives as a union; both end up as `T | null`.
 */
export type TypeNode =
  | { kind?: string; name?: string | null; types?: TypeNode[]; [key: string]: unknown }
  | null
  | undefined;

// PHP's declarable type keywords — php-parser's own `typereference` list. Docblock spellings like
// `integer` or `scalar` never arrive here: docblock tags are not read, only declarations are.
const TS_TYPES: Record<string, string> = {
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
 * Dedupe and join as a union; `any` swallows every other member. Parts are compared by their own
 * depth-0 members, so `(string | null)[]` and `Record<string, a | b>` each stay one member.
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
 * The TypeScript type for a PHP type name, if it is one we map. `Object.hasOwn` so a name we do not
 * map can never find `Object.prototype` and hand a caller an object where a type string was due.
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
  // Own members only: a `null` nested inside brackets covers nothing.
  const covered = type === "any" || type === "void" || members(type).includes("null");
  return covered ? type : `${type} | null`;
}

/** Unions must be wrapped before `[]` binds. */
export function parenthesised(type: string): string {
  // Own members again, or a `|` nested inside brackets picks up parentheses it does not need.
  return members(type).length > 1 ? `(${type})` : type;
}
