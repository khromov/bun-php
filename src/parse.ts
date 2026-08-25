import { Engine } from "php-parser";
import { bindingNameFor } from "./codegen";
import { PhpParseError } from "./errors";
import { docTypeToTs, phpTypeToTs, type TypeNode } from "./php-types";
import type {
  PhpConstantMeta,
  PhpFunctionMeta,
  PhpModuleMeta,
  PhpParamMeta,
  PhpValue,
} from "./types";

type Node = Record<string, any>;

/** Containers that wrap the rest of the file rather than declaring anything. */
const CONTAINER_KINDS = new Set(["namespace", "declare", "block"]);

/**
 * Parse a PHP source file into the metadata needed to generate a JS module.
 *
 * Only top-level declarations are considered: `kind === "function"` is a real
 * function, while `kind === "method"` is a class member and is ignored.
 */
export function parsePhp(source: string, filePath: string): PhpModuleMeta {
  // The Engine constructor mutates the options object, so build a fresh one.
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

  const functions: PhpFunctionMeta[] = [];
  const constants: PhpConstantMeta[] = [];
  const skipped: string[] = [];
  const seenExportNames = new Map<string, string>();

  // Every export must be unique in the generated module: as an export name
  // (where `default` is already taken by the default export) and as a local
  // binding (where the generator's own identifiers live, and where names like
  // `A-B` and `A.B` would otherwise sanitise into the same alias). `_default`
  // is what the sidecar `.d.ts` binds its default export to.
  const usedExportNames = new Set<string>(["default"]);
  const usedBindingNames = new Set<string>(["__mod", "createPhpModule", "_default"]);

  const claimJsNames = (name: string, kind: "function" | "constant"): boolean => {
    const binding = bindingNameFor(name, kind);
    if (usedExportNames.has(name) || usedBindingNames.has(binding)) return false;
    usedExportNames.add(name);
    usedBindingNames.add(binding);
    return true;
  };

  walk(ast.children ?? [], "", (node, namespacePrefix) => {
    if (node.kind === "function") {
      const fn = readFunction(node, namespacePrefix);
      const lowered = fn.exportName.toLowerCase();
      const previous = seenExportNames.get(lowered);
      if (previous !== undefined) {
        skipped.push(
          `function ${fn.phpName}: export name "${fn.exportName}" collides with "${previous}"`,
        );
        return;
      }
      if (!claimJsNames(fn.exportName, "function")) {
        skipped.push(
          `function ${fn.phpName}: export name "${fn.exportName}" collides with another export`,
        );
        return;
      }
      seenExportNames.set(lowered, fn.exportName);
      functions.push(fn);
      return;
    }

    if (node.kind === "constantstatement") {
      for (const entry of node.constants ?? []) {
        const name = identifierName(entry?.name);
        if (!name) continue;
        const value = staticEval(entry.value);
        if (value === NOT_STATIC) {
          skipped.push(`const ${name}: value is not a literal`);
          continue;
        }
        if (!claimJsNames(name, "constant")) {
          skipped.push(`const ${name}: export name "${name}" collides with another export`);
          continue;
        }
        constants.push({ name, value });
      }
      return;
    }

    // `define('X', 1)` is a plain function call, not a constant node.
    if (node.kind === "expressionstatement" && node.expression?.kind === "call") {
      const call = node.expression;
      if (call.what?.kind === "name" && String(call.what.name).toLowerCase() === "define") {
        const args = call.arguments ?? [];
        const nameNode = args[0];
        if (nameNode?.kind !== "string") return;
        const value = staticEval(args[1]);
        if (value === NOT_STATIC) {
          skipped.push(`define('${nameNode.value}'): value is not a literal`);
          return;
        }
        const name = String(nameNode.value);
        if (!claimJsNames(name, "constant")) {
          skipped.push(`define('${name}'): export name "${name}" collides with another export`);
          return;
        }
        constants.push({ name, value });
      }
    }
  });

  return { functions, constants, skipped };
}

/**
 * Visit top-level declarations, descending through `namespace` / `declare` /
 * `block` wrappers while tracking the active namespace prefix.
 */
function walk(
  nodes: Node[],
  namespacePrefix: string,
  visit: (node: Node, namespacePrefix: string) => void,
): void {
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;

    if (CONTAINER_KINDS.has(node.kind)) {
      let prefix = namespacePrefix;
      if (node.kind === "namespace") {
        // A bracketed global namespace yields `name: [""]` rather than a string.
        const raw = Array.isArray(node.name) ? node.name.join("") : node.name;
        prefix = raw ? `${String(raw)}\\` : "";
      }
      walk(node.children ?? [], prefix, visit);
      continue;
    }

    visit(node, namespacePrefix);
  }
}

function readFunction(node: Node, namespacePrefix: string): PhpFunctionMeta {
  const name = identifierName(node.name) ?? "anonymous";
  const doc = readDocblock(node);

  const params: PhpParamMeta[] = (node.arguments ?? []).map((param: Node) => {
    const paramName = identifierName(param.name) ?? "arg";
    return {
      name: paramName,
      tsType: chooseType(
        param.type,
        Boolean(param.nullable),
        doc?.params.get(paramName),
      ),
      optional: param.value != null,
      variadic: Boolean(param.variadic),
      byref: Boolean(param.byref),
    };
  });

  const returnTsType = chooseType(node.type, Boolean(node.nullable), doc?.returns);

  return {
    exportName: name,
    phpName: `${namespacePrefix}${name}`,
    params,
    returnTsType,
    doc: doc?.summary ?? null,
  };
}

/**
 * Pick the most informative type available.
 *
 * A real type declaration normally wins over the docblock, but PHP's bare
 * `array` and `mixed` carry less information than a `@param float[]` tag, so
 * the docblock takes over in those two cases.
 */
function chooseType(
  typeNode: TypeNode,
  nullable: boolean,
  documented: string | null | undefined,
): string {
  const declared = typeNode ? phpTypeToTs(typeNode, nullable) : null;
  const fromDoc = documented ? docTypeToTs(documented) : null;

  if (!declared) return fromDoc ?? "any";
  if (!fromDoc || fromDoc === "any") return declared;

  const bare = phpTypeToTs(typeNode, false);
  if (bare !== "PhpArray" && bare !== "any") return declared;

  return nullable && !fromDoc.split(" | ").includes("null")
    ? `${fromDoc} | null`
    : fromDoc;
}

interface Docblock {
  summary: string | null;
  params: Map<string, string>;
  returns: string | null;
}

/**
 * Read the docblock attached to a node.
 *
 * php-parser never populates `trailingComments`, so a preceding statement's
 * trailing `//` comment ends up in the *next* node's `leadingComments`. The
 * docblock is therefore the last `/**` block, not the first comment.
 */
function readDocblock(node: Node): Docblock | null {
  const comments: Node[] = node.leadingComments ?? [];
  const block = comments
    .filter((c) => c.kind === "commentblock" && String(c.value).startsWith("/**"))
    .pop();
  if (!block) return null;

  const lines = String(block.value)
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*/, "").trim());

  const summary: string[] = [];
  const params = new Map<string, string>();
  let returns: string | null = null;

  for (const line of lines) {
    const tag = /^@(\w+)\s+(.*)$/.exec(line);
    if (!tag) {
      if (params.size === 0 && returns === null) summary.push(line);
      continue;
    }
    const [, name, rest = ""] = tag;
    if (name === "param") {
      const { token, remainder } = takeTypeToken(rest);
      const varName = /^\$(\w+)/.exec(remainder.trim())?.[1];
      if (token && varName) params.set(varName, token);
    } else if (name === "return" && returns === null) {
      returns = takeTypeToken(rest).token || null;
    }
  }

  const text = summary.join("\n").trim();
  return { summary: text ? text : null, params, returns };
}

/**
 * Read one type expression off the front of a docblock tag body, allowing
 * whitespace inside generics: `array<string, int> $x` yields the full type
 * rather than stopping at the first space.
 */
function takeTypeToken(text: string): { token: string; remainder: string } {
  const trimmed = text.trimStart();
  let depth = 0;
  let end = trimmed.length;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i] as string;
    if (ch === "<" || ch === "{" || ch === "(") depth++;
    else if (ch === ">" || ch === "}" || ch === ")") depth--;
    else if (/\s/.test(ch) && depth <= 0) {
      end = i;
      break;
    }
  }
  return { token: trimmed.slice(0, end), remainder: trimmed.slice(end) };
}

function identifierName(node: unknown): string | null {
  if (typeof node === "string") return node;
  if (node && typeof node === "object" && "name" in node) {
    const inner = (node as Node).name;
    return typeof inner === "string" ? inner : null;
  }
  return null;
}

/** Sentinel for "this expression cannot be evaluated without running PHP". */
const NOT_STATIC = Symbol("not-static");

/**
 * Evaluate a literal expression at build time so constants can be emitted as
 * plain JS values, keeping module import free of any PHP boot cost.
 */
function staticEval(node: Node | null | undefined): PhpValue | typeof NOT_STATIC {
  if (!node) return NOT_STATIC;

  switch (node.kind) {
    case "string":
      // Only single-quoted / interpolation-free strings are safe to inline.
      return node.unicode === false || typeof node.value === "string"
        ? String(node.value)
        : NOT_STATIC;

    case "number": {
      const value = parsePhpNumber(String(node.value));
      // An overflowing literal (1e999) is INF in PHP, which JSON cannot
      // represent — skipping beats silently exporting `null`.
      return Number.isFinite(value) ? value : NOT_STATIC;
    }

    case "boolean":
      return Boolean(node.value);

    case "nullkeyword":
      return null;

    case "unary": {
      const inner = staticEval(node.what);
      if (inner === NOT_STATIC) return NOT_STATIC;
      if (node.type === "-" && typeof inner === "number") return -inner;
      if (node.type === "+" && typeof inner === "number") return inner;
      if (node.type === "!") return !phpTruthy(inner);
      return NOT_STATIC;
    }

    case "array": {
      const items: Node[] = node.items ?? [];
      if (items.some((item) => item?.unpack)) return NOT_STATIC;

      // Follow PHP's own key semantics: bools, floats and canonical integer
      // strings collapse into int keys, later entries overwrite earlier ones,
      // and an implicit key is the highest int key seen so far plus one.
      const entries = new Map<string | number, PhpValue>();
      let maxIntKey: number | null = null;
      for (const item of items) {
        const value = staticEval(item?.value);
        if (value === NOT_STATIC) return NOT_STATIC;
        let key: string | number;
        if (item.key == null) {
          key = maxIntKey === null ? 0 : maxIntKey + 1;
        } else {
          const raw = staticEval(item.key);
          if (raw === NOT_STATIC) return NOT_STATIC;
          const normalised = phpArrayKey(raw);
          if (normalised === NOT_STATIC) return NOT_STATIC;
          key = normalised;
        }
        if (typeof key === "number") {
          maxIntKey = maxIntKey === null ? key : Math.max(maxIntKey, key);
        }
        entries.set(key, value);
      }

      // Keys 0..n-1 in order make a PHP list, i.e. a JS array.
      const keys = [...entries.keys()];
      if (keys.every((key, index) => key === index)) return [...entries.values()];
      const out: Record<string, PhpValue> = {};
      for (const [key, value] of entries) out[String(key)] = value;
      return out;
    }

    default:
      return NOT_STATIC;
  }
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
 * Normalise a PHP array key the way PHP does: bools and floats cast to int,
 * canonical integer strings become ints, null becomes "". An array used as a
 * key is a PHP TypeError, so it comes back as NOT_STATIC.
 */
function phpArrayKey(raw: PhpValue): string | number | typeof NOT_STATIC {
  if (raw === null) return "";
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.trunc(raw) : NOT_STATIC;
  }
  if (typeof raw === "string") {
    return /^(0|-?[1-9]\d*)$/.test(raw) && Number.isSafeInteger(Number(raw))
      ? Number(raw)
      : raw;
  }
  return NOT_STATIC;
}

/** PHP numeric literals: `1_000`, `0x1F`, `0b1010`, `0o17` and legacy `017`. */
function parsePhpNumber(raw: string): number {
  const text = raw.replace(/_/g, "");
  if (/^0[xX]/.test(text)) return parseInt(text.slice(2), 16);
  if (/^0[bB]/.test(text)) return parseInt(text.slice(2), 2);
  if (/^0[oO]/.test(text)) return parseInt(text.slice(2), 8);
  if (/^0[0-7]+$/.test(text)) return parseInt(text.slice(1), 8);
  return Number(text);
}
