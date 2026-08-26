/** A `.php` file could not be parsed. */
export class PhpParseError extends Error {
  override readonly name = "PhpParseError";
  constructor(
    message: string,
    readonly file: string,
    readonly line?: number,
  ) {
    super(message);
  }
}

/** A PHP `\Throwable` escaped the called function. */
export class PhpError extends Error {
  override readonly name = "PhpError";
  constructor(
    message: string,
    readonly phpClass: string,
    readonly phpFile: string,
    readonly phpLine: number,
    readonly phpTrace: string,
  ) {
    super(message);
  }
}

/**
 * A call outlived its deadline.
 *
 * The PHP work is **not** stopped — php-wasm offers no way to interrupt a
 * running request — so this hands control back to the caller and retires the
 * interpreter rather than pretending to have cancelled anything.
 */
export class PhpTimeoutError extends Error {
  override readonly name = "PhpTimeoutError";
  constructor(
    message: string,
    readonly timeoutMs: number,
  ) {
    super(message);
  }
}

/** A PHP fatal error (undefined function, `exit()`, memory exhaustion, ...). */
export class PhpFatalError extends Error {
  override readonly name = "PhpFatalError";
  constructor(
    message: string,
    readonly phpFile: string,
    readonly phpLine: number,
  ) {
    super(message);
  }
}
