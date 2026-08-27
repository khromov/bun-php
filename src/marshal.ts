import { phpVar } from "@php-wasm/util";
import { PhpError, PhpFatalError } from "./errors";

// PHP flushes open output buffers to stdout on a fatal error, so a sentinel pair, not output
// buffering, is what keeps the script's own output apart from the result.
export const SENTINEL = "\u0000BUNPHP\u0000";
const PHP_SENTINEL = '"\\x00BUNPHP\\x00"';

export type Envelope =
  | { ok: true; v: unknown; out?: string }
  | {
      ok: false;
      e: { class: string; msg: string; file: string; line: number; trace: string };
      out?: string;
    }
  | { ok: false; fatal: { msg: string; file: string; line: number }; out?: string };

const MAX_INT64 = 2n ** 63n - 1n;
const MIN_INT64 = -(2n ** 63n);

/** Encode JS arguments as a PHP argument list. Trailing `undefined`s are dropped so PHP defaults apply. */
export function encodeArgs(args: readonly unknown[], label = "call"): string {
  let length = args.length;
  while (length > 0 && args[length - 1] === undefined) length--;
  return args
    .slice(0, length)
    .map((arg, i) => encodeValue(arg, `${label}: argument #${i + 1}`))
    .join(", ");
}

/** Encode one JS value as a PHP expression; `context` names it in error messages. */
export function encodeValue(value: unknown, context: string): string {
  if (value === undefined) throw new TypeError(`${context} is undefined; pass null instead`);
  if (typeof value === "bigint") {
    if (value < MIN_INT64 || value > MAX_INT64) {
      throw new TypeError(`${context} (${value}n) overflows PHP's 64-bit int`);
    }
    // PHP reads `-9223372036854775808` as a negated float literal, so PHP_INT_MIN needs the classic spelling.
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
 * The PHP script for one call. Both `require_once`s run on every call because php-wasm resets
 * request state (declared functions and autoloaders included) between runs.
 */
export function buildCallScript(
  modulePath: string,
  expression: string,
  autoloadPath?: string | null,
): string {
  const autoload = autoloadPath ? `    require_once ${phpVar(autoloadPath as never)};\n` : "";

  return `<?php
ini_set('html_errors', '0');
// Unbuffered, so echo reaches stdout while the request is still running.
ob_implicit_flush(true);
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
    }
    echo ${PHP_SENTINEL} . $json . ${PHP_SENTINEL};
};
register_shutdown_function(function () use ($__bunphp_emit, &$__bunphp_sent) {
    if ($__bunphp_sent) { return; }
    $err = error_get_last();
    // Only a fatal error explains reaching shutdown without a result; a stale warning must not be blamed.
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
try {
${autoload}    require_once ${phpVar(modulePath as never)};
    $__bunphp_emit(['ok' => true, 'v' => ${expression}]);
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

/** How much trailing output to keep for a fatal error's detail message. */
const TAIL_LIMIT = 8192;

/**
 * Splits stdout into script output and the result envelope as chunks arrive, so `echo` reaches
 * the terminal while the request is still running. Three things follow from that: a sentinel can
 * straddle a chunk, so a tail that could still grow into one is held back; a sentinel pair whose
 * contents are not JSON was never an envelope, so it is put back verbatim; and the last valid
 * envelope wins, so output after one is held until the stream ends in case a later one supersedes it.
 */
export class EnvelopeSplitter {
  /** Unclassified text, or envelope JSON so far while `#inEnvelope`. */
  #buffer = "";
  #inEnvelope = false;
  #envelope: Envelope | null = null;
  /** The winning envelope's raw text, re-emitted as output if a later one supersedes it. */
  #envelopeText = "";
  /** Output seen after the winning envelope, released when the stream ends. */
  #afterEnvelope = "";
  #tail = "";

  constructor(private readonly output: (text: string) => void) {}

  push(text: string): void {
    if (!text) return;
    this.#buffer += text;

    for (;;) {
      const at = this.#buffer.indexOf(SENTINEL);
      if (at === -1) break;
      const segment = this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(at + SENTINEL.length);
      if (this.#inEnvelope) this.#closeEnvelope(segment);
      else {
        this.#emit(segment);
        this.#inEnvelope = true;
      }
    }

    // Envelope JSON stays put until its closing sentinel; otherwise release all but a partial sentinel.
    if (this.#inEnvelope) return;
    const keep = this.#partialSentinelLength();
    this.#emit(this.#buffer.slice(0, this.#buffer.length - keep));
    this.#buffer = this.#buffer.slice(this.#buffer.length - keep);
  }

  /** Close the stream and return the envelope, if one arrived. */
  end(): Envelope | null {
    if (this.#inEnvelope) {
      // A lone sentinel: the process died before the closing one, so what followed is the best guess.
      const json = this.#buffer;
      this.#buffer = "";
      this.#inEnvelope = false;
      if (!this.#tryEnvelope(json, SENTINEL + json)) this.#emit(SENTINEL + json);
    } else {
      this.#emit(this.#buffer);
      this.#buffer = "";
    }
    this.#write(this.#afterEnvelope);
    this.#afterEnvelope = "";
    return this.#envelope;
  }

  /** The last of the output, for reporting a call that produced no result. */
  get tail(): string {
    return this.#tail;
  }

  #closeEnvelope(json: string): void {
    this.#inEnvelope = false;
    // Not JSON means it was never an envelope, just output that happened to contain the marker.
    if (!this.#tryEnvelope(json, SENTINEL + json + SENTINEL)) {
      this.#emit(SENTINEL + json + SENTINEL);
    }
  }

  /** Adopt `json` as the envelope, turning any earlier one back into output. */
  #tryEnvelope(json: string, raw: string): boolean {
    let parsed: Envelope;
    try {
      parsed = JSON.parse(json) as Envelope;
    } catch {
      return false;
    }
    if (this.#envelope) {
      this.#write(this.#envelopeText);
      this.#write(this.#afterEnvelope);
      this.#afterEnvelope = "";
    }
    this.#envelope = parsed;
    this.#envelopeText = raw;
    return true;
  }

  /** How many trailing characters could still grow into a sentinel. */
  #partialSentinelLength(): number {
    for (let k = Math.min(SENTINEL.length - 1, this.#buffer.length); k > 0; k--) {
      if (this.#buffer.endsWith(SENTINEL.slice(0, k))) return k;
    }
    return 0;
  }

  // Output after an envelope is held, so a later envelope can still supersede it in order.
  #emit(text: string): void {
    if (!text) return;
    if (this.#envelope) this.#afterEnvelope += text;
    else this.#write(text);
  }

  #write(text: string): void {
    if (!text) return;
    this.#tail = (this.#tail + text).slice(-TAIL_LIMIT);
    this.output(text);
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
