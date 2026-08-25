import { Engine } from "php-parser";
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
        constants.push({ name: String(nameNode.value), value });
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

    case "number":
      return parsePhpNumber(String(node.value));

    case "boolean":
      return Boolean(node.value);

    case "nullkeyword":
      return null;

    case "unary": {
      const inner = staticEval(node.what);
      if (inner === NOT_STATIC) return NOT_STATIC;
      if (node.type === "-" && typeof inner === "number") return -inner;
      if (node.type === "+" && typeof inner === "number") return inner;
      if (node.type === "!") return !inner;
      return NOT_STATIC;
    }

    case "array": {
      const items: Node[] = node.items ?? [];
      // A keyed entry makes this an associative array, i.e. a JS object.
      const keyed = items.some((item) => item?.key != null);
      if (items.some((item) => item?.unpack)) return NOT_STATIC;

      if (!keyed) {
        const out: PhpValue[] = [];
        for (const item of items) {
          const value = staticEval(item?.value);
          if (value === NOT_STATIC) return NOT_STATIC;
          out.push(value);
        }
        return out;
      }

      const out: Record<string, PhpValue> = {};
      let nextIndex = 0;
      for (const item of items) {
        const value = staticEval(item?.value);
        if (value === NOT_STATIC) return NOT_STATIC;
        if (item.key == null) {
          out[String(nextIndex++)] = value;
          continue;
        }
        const key = staticEval(item.key);
        if (key === NOT_STATIC || key === null || typeof key === "object") {
          return NOT_STATIC;
        }
        out[String(key)] = value;
      }
      return out;
    }

    default:
      return NOT_STATIC;
  }
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
