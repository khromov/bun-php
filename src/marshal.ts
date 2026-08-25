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

/** Encode JS arguments as a PHP argument list. */
export function encodeArgs(args: readonly unknown[]): string {
  return args.map((arg) => phpVar(arg as never)).join(", ");
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
        ]);
    }
    echo ${PHP_SENTINEL} . $json;
};
register_shutdown_function(function () use ($__bunphp_emit, &$__bunphp_sent) {
    if ($__bunphp_sent) { return; }
    $err = error_get_last();
    $__bunphp_emit([
        'ok' => false,
        'fatal' => [
            'msg' => $err['message'] ?? 'PHP exited before returning a value',
            'file' => $err['file'] ?? '',
            'line' => $err['line'] ?? 0,
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
 * The PHP side of a long-running session.
 *
 * Requires the autoloader and the module exactly once, then blocks in
 * `post_message_to_js()` waiting for jobs. Each job is answered with the same
 * envelope shape `buildCallScript` produces, so `unwrapEnvelope` handles both
 * execution modes unchanged.
 *
 * `\Throwable` covers thrown exceptions and PHP 8 `Error`s (an undefined
 * function, a type error), so those leave the loop running. Only `exit()`,
 * `die()` or a non-recoverable fatal ends the request, which the JavaScript
 * side detects and reports.
 */
export function buildLoopScript(
  modulePath: string,
  autoloadPath?: string | null,
): string {
  const prelude = autoloadPath
    ? `require_once ${phpVar(autoloadPath as never)};\n`
    : "";

  return `<?php
ini_set('html_errors', '0');

$__bunphp_encode = function (array $r): string {
    try {
        return json_encode($r, JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
    } catch (\\Throwable $e) {
        return json_encode([
            'type' => 'result',
            'ok' => false,
            'out' => $r['out'] ?? '',
            'e' => [
                'class' => 'JsonException',
                'msg' => 'Return value could not be encoded: ' . $e->getMessage(),
                'file' => '',
                'line' => 0,
                'trace' => '',
            ],
        ]);
    }
};

ob_start();
${prelude}require_once ${phpVar(modulePath as never)};
$__bunphp_payload = $__bunphp_encode(['type' => 'ready', 'out' => ob_get_clean()]);

while (true) {
    $__bunphp_job = json_decode(post_message_to_js($__bunphp_payload), true);
    $__bunphp_type = $__bunphp_job['type'] ?? '';
    if ($__bunphp_type === 'shutdown' || !is_array($__bunphp_job)) {
        break;
    }

    ob_start();
    try {
        if ($__bunphp_type === 'eval') {
            $__bunphp_v = eval('return (static function () { ' . $__bunphp_job['code'] . ' })();');
        } else {
            $__bunphp_v = call_user_func_array(
                $__bunphp_job['fn'],
                $__bunphp_job['args'] ?? []
            );
        }
        $__bunphp_r = ['ok' => true, 'v' => $__bunphp_v];
    } catch (\\Throwable $e) {
        $__bunphp_r = [
            'ok' => false,
            'e' => [
                'class' => get_class($e),
                'msg' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
                'trace' => $e->getTraceAsString(),
            ],
        ];
    }

    $__bunphp_r['out'] = ob_get_clean();
    $__bunphp_r['type'] = 'result';
    $__bunphp_payload = $__bunphp_encode($__bunphp_r);
}
`;
}

/** Split raw stdout into the script's own output and the result envelope. */
export function decodeOutput(stdout: string): {
  out: string;
  envelope: Envelope | null;
} {
  const index = stdout.lastIndexOf(SENTINEL);
  if (index === -1) return { out: stdout, envelope: null };

  const before = stdout.slice(0, index);
  const json = stdout.slice(index + SENTINEL.length);
  try {
    return { out: before, envelope: JSON.parse(json) as Envelope };
  } catch {
    return { out: stdout, envelope: null };
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
