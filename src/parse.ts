import { Engine } from "php-parser";
import { bindingNameFor } from "./codegen";
import { PhpParseError } from "./errors";
import { docTypeToTs, nullable, phpTypeToTs, type TypeNode } from "./php-types";
import type { PhpFunctionMeta, PhpModuleMeta, PhpParamMeta, PhpValue } from "./types";

type Node = Record<string, any>;
type Kind = "function" | "constant";

/** Wrap the rest of the file rather than declaring anything. */
const CONTAINER_KINDS = new Set(["namespace", "declare", "block"]);

/** Marks an expression that needs PHP to evaluate. */
const NOT_LITERAL = Symbol("not-literal");

/** What the generated module needs from a file: its top-level functions and literal constants. */
export function parsePhp(source: string, filePath: string): PhpModuleMeta {
  // The Engine constructor mutates its options object, so build a fresh one each time.
  const engine = new Engine({
    parser: { extractDoc: true, suppressErrors: false, version: 805 },
    ast: { withPositions: true },
  });

  let ast: Node;
  try {
    ast = engine.parseCode(source, filePath) as unknown as Node;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const line = /on line (\d+)/.exec(message)?.[1];
    throw new PhpParseError(message, filePath, line ? Number(line) : undefined);
  }

  const meta: PhpModuleMeta = { functions: [], constants: [], skipped: [] };
  // `default` is the module's own default export; the bindings are the generator's identifiers,
  // with `_default` being what the sidecar `.d.ts` binds its default export to.
  const exportNames = new Set(["default"]);
  const bindingNames = new Set(["__mod", "createPhpModule", "_default"]);

  // Both sets are checked because names like `A-B` and `A.B` sanitise to the same binding.
  const claim = (name: string, kind: Kind): boolean => {
    const binding = bindingNameFor(name, kind);
    if (exportNames.has(name) || bindingNames.has(binding)) return false;
    exportNames.add(name);
    bindingNames.add(binding);
    return true;
  };

  const addConstant = (name: string, value: PhpValue | typeof NOT_LITERAL, label: string) => {
    if (value === NOT_LITERAL) meta.skipped.push(`${label}: value is not a literal`);
    else if (!claim(name, "constant")) meta.skipped.push(`${label}: ${collision(name)}`);
    else meta.constants.push({ name, value });
  };

  walk(ast.children ?? [], "", (node, namespace) => {
    if (node.kind === "function") {
      const fn = readFunction(node, namespace);
      if (claim(fn.exportName, "function")) meta.functions.push(fn);
      else meta.skipped.push(`function ${fn.phpName}: ${collision(fn.exportName)}`);
    } else if (node.kind === "constantstatement") {
      for (const entry of node.constants ?? []) {
        const name = identifierName(entry?.name);
        if (name) addConstant(name, literalValue(entry.value), `const ${name}`);
      }
    } else if (isDefineCall(node)) {
      // `define('X', 1)` is a plain function call, not a constant node.
      const [nameNode, valueNode] = node.expression.arguments ?? [];
      if (nameNode?.kind === "string") {
        const name = String(nameNode.value);
        addConstant(name, literalValue(valueNode), `define('${name}')`);
      }
    }
  });

  return meta;
}

function collision(name: string): string {
  return `export name "${name}" collides with another export`;
}

function isDefineCall(node: Node): boolean {
  const call = node.kind === "expressionstatement" ? node.expression : null;
  return (
    call?.kind === "call" &&
    call.what?.kind === "name" &&
    String(call.what.name).toLowerCase() === "define"
  );
}

/** Visit top-level declarations, descending through namespace/declare/block wrappers. */
function walk(
  nodes: Node[],
  namespace: string,
  visit: (node: Node, namespace: string) => void,
): void {
  for (const node of nodes) {
    if (!CONTAINER_KINDS.has(node.kind)) {
      visit(node, namespace);
      continue;
    }
    let prefix = namespace;
    if (node.kind === "namespace") {
      // A bracketed global namespace yields `name: [""]` rather than a string.
      const raw = Array.isArray(node.name) ? node.name.join("") : node.name;
      prefix = raw ? `${raw}\\` : "";
    }
    walk(node.children ?? [], prefix, visit);
  }
}

function readFunction(node: Node, namespace: string): PhpFunctionMeta {
  const name = identifierName(node.name) ?? "anonymous";
  const doc = readDocblock(node);

  const params: PhpParamMeta[] = (node.arguments ?? []).map((param: Node) => {
    const paramName = identifierName(param.name) ?? "arg";
    return {
      name: paramName,
      tsType: chooseType(
        param.type,
        Boolean(param.nullable),
        elementType(doc?.params.get(paramName), Boolean(param.variadic)),
      ),
      optional: param.value != null,
      variadic: Boolean(param.variadic),
      byref: Boolean(param.byref),
    };
  });

  return {
    exportName: name,
    phpName: `${namespace}${name}`,
    params,
    returnTsType: chooseType(node.type, Boolean(node.nullable), doc?.returns),
    doc: doc?.summary ?? null,
  };
}

/**
 * A variadic collects its arguments into an array, so `@param string[] $args` describes the whole
 * array while PSR-5's `@param string ...$args` describes one element. Both mean `...args: string[]`,
 * and `renderParams` appends the `[]`, so the array spelling gives up one level here.
 */
function elementType(documented: string | null | undefined, variadic: boolean): string | null {
  if (!documented || !variadic) return documented ?? null;
  return documented.endsWith("[]") ? documented.slice(0, -2) || null : documented;
}

/** A declared type wins over the docblock, except bare `array`/`mixed`, which say less than `@param float[]`. */
function chooseType(typeNode: TypeNode, isNullable: boolean, documented?: string | null): string {
  const declared = phpTypeToTs(typeNode);
  const fromDoc = documented ? docTypeToTs(documented) : "any";
  const vague = declared === "any" || declared === "PhpArray";
  const type = vague && fromDoc !== "any" ? fromDoc : declared;
  return isNullable ? nullable(type) : type;
}

interface Docblock {
  summary: string | null;
  params: Map<string, string>;
  returns: string | null;
}

// php-parser never fills `trailingComments`, so a previous statement's trailing `//` lands in this
// node's `leadingComments`; the docblock is therefore the last `/**` block, not the first comment.
function readDocblock(node: Node): Docblock | null {
  const comments: Node[] = node.leadingComments ?? [];
  const block = comments.findLast(
    (c) => c.kind === "commentblock" && String(c.value).startsWith("/**"),
  );
  if (!block) return null;

  const lines = String(block.value)
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*/, "").trim());

  const summary: string[] = [];
  const params = new Map<string, string>();
  let returns: string | null = null;
  let tagged = false;

  for (const line of lines) {
    const tag = /^@(\w+)\s+(.*)$/.exec(line);
    if (!tag) {
      // Any tag ends the summary, even one nobody reads: what follows is that tag's continuation.
      if (!tagged) summary.push(line);
      continue;
    }
    tagged = true;
    const [, name, body = ""] = tag;
    if (name === "param") {
      const { type, rest } = readType(body);
      // PSR-5 writes a variadic as `...$args`, which a bare `$name` pattern would drop silently.
      const varName = /^(?:\.\.\.)?\$(\w+)/.exec(rest.trim())?.[1];
      if (type && varName) params.set(varName, type);
    } else if (name === "return" && returns === null) {
      returns = readType(body).type || null;
    }
  }

  const text = summary.join("\n").trim();
  return { summary: text || null, params, returns };
}

/** The type at the front of a tag body, keeping whitespace inside generics: `array<string, int> $x`. */
function readType(text: string): { type: string; rest: string } {
  const trimmed = text.trimStart();
  let depth = 0;
  let end = trimmed.length;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if ("<{(".includes(ch)) depth++;
    else if (">})".includes(ch)) depth--;
    else if (/\s/.test(ch) && depth <= 0) {
      end = i;
      break;
    }
  }
  return { type: trimmed.slice(0, end), rest: trimmed.slice(end) };
}

function identifierName(node: unknown): string | null {
  if (typeof node === "string") return node;
  if (node && typeof node === "object" && "name" in node) {
    const inner = (node as Node).name;
    return typeof inner === "string" ? inner : null;
  }
  return null;
}

/** Evaluate a literal at build time, so constants are plain JS values that need no PHP boot. */
function literalValue(node: Node | null | undefined): PhpValue | typeof NOT_LITERAL {
  if (!node) return NOT_LITERAL;

  switch (node.kind) {
    case "string":
      return String(node.value);

    case "number": {
      const value = parsePhpNumber(String(node.value));
      // An overflowing literal is INF in PHP, which JSON would silently turn into null.
      return Number.isFinite(value) ? value : NOT_LITERAL;
    }

    case "boolean":
      return Boolean(node.value);

    case "nullkeyword":
      return null;

    case "unary": {
      const inner = literalValue(node.what);
      if (inner === NOT_LITERAL) return NOT_LITERAL;
      if (node.type === "!") return !phpTruthy(inner);
      if (typeof inner !== "number") return NOT_LITERAL;
      return node.type === "-" ? -inner : node.type === "+" ? inner : NOT_LITERAL;
    }

    case "array":
      return arrayValue(node.items ?? []);

    default:
      return NOT_LITERAL;
  }
}

// PHP's key rules: bools, floats and canonical integer strings become int keys, later entries
// overwrite earlier ones, and an implicit key is the highest int key so far plus one.
function arrayValue(items: Node[]): PhpValue | typeof NOT_LITERAL {
  const entries = new Map<string | number, PhpValue>();
  let maxIntKey: number | null = null;

  for (const item of items) {
    if (!item || item.unpack) return NOT_LITERAL;
    const value = literalValue(item.value);
    if (value === NOT_LITERAL) return NOT_LITERAL;

    let key: string | number = maxIntKey === null ? 0 : maxIntKey + 1;
    // Past 2^53 the increment stops moving, so two entries would collide on one key.
    if (typeof key === "number" && !Number.isSafeInteger(key)) return NOT_LITERAL;
    if (item.key != null) {
      const raw = literalValue(item.key);
      if (raw === NOT_LITERAL) return NOT_LITERAL;
      const normalised = phpArrayKey(raw);
      if (normalised === NOT_LITERAL) return NOT_LITERAL;
      key = normalised;
    }
    if (typeof key === "number") maxIntKey = maxIntKey === null ? key : Math.max(maxIntKey, key);
    entries.set(key, value);
  }

  // Keys 0..n-1 in order make a PHP list, i.e. a JS array.
  const keys = [...entries.keys()];
  if (keys.every((key, index) => key === index)) return [...entries.values()];
  return Object.fromEntries([...entries].map(([key, value]) => [String(key), value]));
}

/** PHP truthiness: false, 0, 0.0, "", "0", [] and null are falsy. */
function phpTruthy(value: PhpValue): boolean {
  if (value === null || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * Normalise an array key the way PHP does; an array as a key is a PHP TypeError. PHP int-ifies any
 * canonical decimal string that fits its 64-bit int, but JS cannot hold every one of those exactly,
 * and a key off by one silently reshapes the whole constant — so an inexact one is not a literal.
 */
function phpArrayKey(raw: PhpValue): string | number | typeof NOT_LITERAL {
  if (raw === null) return "";
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "number") {
    return Number.isFinite(raw) && Number.isSafeInteger(Math.trunc(raw))
      ? Math.trunc(raw)
      : NOT_LITERAL;
  }
  if (typeof raw === "string") {
    if (!/^(0|-?[1-9]\d*)$/.test(raw)) return raw;
    return Number.isSafeInteger(Number(raw)) ? Number(raw) : NOT_LITERAL;
  }
  return NOT_LITERAL;
}

/** PHP numeric literals. `Number()` already reads `0x`/`0b`/`0o`; underscores and legacy `017` octal it does not. */
function parsePhpNumber(raw: string): number {
  const text = raw.replace(/_/g, "");
  return /^0[0-7]+$/.test(text) ? parseInt(text, 8) : Number(text);
}
