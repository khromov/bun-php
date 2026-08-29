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

/** A `cli()` under `isolation: "process"` outlived its deadline; the child was SIGKILLed. */
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
