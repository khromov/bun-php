import { phpVar } from "@php-wasm/util";
import { PhpError, PhpFatalError } from "./errors";

/**
 * Marker separating the PHP script's own output from the result envelope.
 *
 * A sentinel is used rather than relying on output buffering alone because PHP
 * flushes open buffers to stdout when a fatal error occurs, so captured output
 * can still reach stdout ahead of the envelope.
 */
const SENTINEL = "\u0000BUNPHP\u0000";

/** The same marker written as a PHP double-quoted literal. */
const PHP_SENTINEL = '"\\x00BUNPHP\\x00"';

interface SuccessEnvelope {
  ok: true;
  v: unknown;
  out?: string;
}

interface ThrowableEnvelope {
  ok: false;
  e: { class: string; msg: string; file: string; line: number; trace: string };
  out?: string;
}

interface FatalEnvelope {
  ok: false;
  fatal: { msg: string; file: string; line: number };
  out?: string;
}

export type Envelope = SuccessEnvelope | ThrowableEnvelope | FatalEnvelope;

const MAX_INT64 = 2n ** 63n - 1n;
const MIN_INT64 = -(2n ** 63n);

/**
 * Encode JS arguments as a PHP argument list.
 *
 * Trailing `undefined` arguments are dropped so PHP parameter defaults apply —
 * the natural meaning of forwarding an optional value that was never set. An
 * `undefined` hole before a defined argument has no PHP spelling, so it is
 * rejected rather than silently sent as `null`.
 */
export function encodeArgs(args: readonly unknown[], label = "call"): string {
  let length = args.length;
  while (length > 0 && args[length - 1] === undefined) length--;

  const parts: string[] = [];
  for (let i = 0; i < length; i++) {
    parts.push(encodeValue(args[i], `${label}: argument #${i + 1}`));
  }
  return parts.join(", ");
}

/**
 * Encode one JS value as a PHP expression. `context` names the value in error
 * messages, e.g. `greet: argument #1` or `BunPHP: interpolation #2`.
 */
export function encodeValue(value: unknown, context: string): string {
  if (value === undefined) {
    throw new TypeError(`${context} is undefined; pass null instead`);
  }
  if (typeof value === "bigint") {
    if (value < MIN_INT64 || value > MAX_INT64) {
      throw new TypeError(`${context} (${value}n) overflows PHP's 64-bit int`);
    }
    // PHP parses `-9223372036854775808` as unary minus on an overflowing
    // int literal (yielding a float), so PHP_INT_MIN needs the classic spelling.
    return value === MIN_INT64 ? "(-9223372036854775807 - 1)" : value.toString();
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return Number.isNaN(value) ? "NAN" : value > 0 ? "INF" : "-INF";
  }
  try {
    return phpVar(value as never);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new TypeError(`${context} could not be encoded: ${reason}`);
  }
}

/**
 * Build the PHP script for one call.
 *
 * Every call re-`require_once`s the module: php-wasm resets request-scoped PHP
 * state (declared functions included) between runs, so the include is both
 * necessary and safe from redeclaration errors.
 */
export function buildCallScript(
  modulePath: string,
  expression: string,
  autoloadPath?: string | null,
): string {
  // Composer's autoloader has to be registered again for every call, because
  // php-wasm resets request-scoped state (including declared functions and
  // registered autoloaders) between runs.
  const prelude = autoloadPath
    ? `    require_once ${phpVar(autoloadPath as never)};\n`
    : "";

  return `<?php
ini_set('html_errors', '0');
$__bunphp_sent = false;
$__bunphp_emit = function (array $r) use (&$__bunphp_sent) {
    if ($__bunphp_sent) { return; }
    $__bunphp_sent = true;
    $out = '';
    while (ob_get_level() > 0) { $out = ob_get_clean() . $out; }
    $r['out'] = $out;
    try {
        $json = json_encode($r, JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
    } catch (\\Throwable $e) {
        $json = json_encode([
            'ok' => false,
            'out' => $out,
            'e' => [
                'class' => 'JsonException',
                'msg' => 'Return value could not be encoded: ' . $e->getMessage(),
                'file' => '',
                'line' => 0,
                'trace' => '',
            ],
        ], JSON_INVALID_UTF8_SUBSTITUTE);
        if ($json === false) {
            $json = '{"ok":false,"out":"","e":{"class":"JsonException","msg":"Return value could not be encoded","file":"","line":0,"trace":""}}';
        }
    }
    echo ${PHP_SENTINEL} . $json . ${PHP_SENTINEL};
};
register_shutdown_function(function () use ($__bunphp_emit, &$__bunphp_sent) {
    if ($__bunphp_sent) { return; }
    $err = error_get_last();
    // Only a fatal error explains reaching shutdown without a result; a stale
    // warning or notice from earlier in the request must not be blamed.
    $fatal = $err !== null && ($err['type'] & (E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR | E_RECOVERABLE_ERROR)) !== 0;
    $__bunphp_emit([
        'ok' => false,
        'fatal' => [
            'msg' => $fatal ? $err['message'] : 'PHP exited before returning a value',
            'file' => $fatal ? $err['file'] : '',
            'line' => $fatal ? $err['line'] : 0,
        ],
    ]);
});
ob_start();
try {
${prelude}    require_once ${phpVar(modulePath as never)};
    $__bunphp_v = ${expression};
    $__bunphp_emit(['ok' => true, 'v' => $__bunphp_v]);
} catch (\\Throwable $e) {
    $__bunphp_emit([
        'ok' => false,
        'e' => [
            'class' => get_class($e),
            'msg' => $e->getMessage(),
            'file' => $e->getFile(),
            'line' => $e->getLine(),
            'trace' => $e->getTraceAsString(),
        ],
    ]);
}
`;
}

/**
 * Split raw stdout into the script's own output and the result envelope.
 *
 * The envelope sits between a sentinel pair, because output can surround it on
 * both sides: PHP flushes open buffers to stdout ahead of the envelope on a
 * fatal error, and user shutdown functions or destructors can still print
 * after the envelope has been emitted.
 */
export function decodeOutput(stdout: string): {
  out: string;
  envelope: Envelope | null;
} {
  const close = stdout.lastIndexOf(SENTINEL);
  if (close === -1) return { out: stdout, envelope: null };

  const open = close === 0 ? -1 : stdout.lastIndexOf(SENTINEL, close - 1);
  if (open === -1) {
    // A lone sentinel: the process died before the closing one was written.
    return parseEnvelope(
      stdout.slice(0, close),
      stdout.slice(close + SENTINEL.length),
      "",
      stdout,
    );
  }

  return parseEnvelope(
    stdout.slice(0, open),
    stdout.slice(open + SENTINEL.length, close),
    stdout.slice(close + SENTINEL.length),
    stdout,
  );
}

function parseEnvelope(
  before: string,
  json: string,
  after: string,
  raw: string,
): { out: string; envelope: Envelope | null } {
  try {
    return { out: before + after, envelope: JSON.parse(json) as Envelope };
  } catch {
    return { out: raw, envelope: null };
  }
}

/** Turn an envelope into either the return value or a thrown error. */
export function unwrapEnvelope(envelope: Envelope, label: string): unknown {
  if (envelope.ok) return envelope.v;

  if ("fatal" in envelope) {
    throw new PhpFatalError(
      `${label}: ${envelope.fatal.msg}`,
      envelope.fatal.file,
      envelope.fatal.line,
    );
  }

  throw new PhpError(
    `${label}: ${envelope.e.class}: ${envelope.e.msg}`,
    envelope.e.class,
    envelope.e.file,
    envelope.e.line,
    envelope.e.trace,
  );
}

export { SENTINEL };
