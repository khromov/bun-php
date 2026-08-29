# Changelog

## [1.0.0](https://github.com/khromov/bun-php/compare/bun-php-v0.2.0...bun-php-v1.0.0) (2026-08-29)


### ⚠ BREAKING CHANGES

* `php.call(name, args)` is now `php.$call(name, args)` on imported modules. `timeoutMs` no longer has any effect outside `isolation: "process"`, and passing it to the plugin or to `createPhpModule` now throws instead of being ignored. Types derived from `@param`/`@return` docblocks fall back to the declared hint, so a bare `array` is `PhpArray` where it may previously have been more specific. Inline snippets mixing HTML and PHP no longer work.

### Features

* cut docblock inference, inline markup, in-process timeouts, and the `call` collision ([a30004d](https://github.com/khromov/bun-php/commit/a30004dca529d94653daf8f65c92d8ba7d2a1e16))


### Bug Fixes

* cleanup ([e5e38da](https://github.com/khromov/bun-php/commit/e5e38dab3e0611bce3b1c207c7e15b0d53e0554d))
* cleanup ([284af07](https://github.com/khromov/bun-php/commit/284af076da5792382161e03ca4a405322c14d25e))
* reject `timeoutMs` in createPhpModule instead of ignoring it ([d865248](https://github.com/khromov/bun-php/commit/d865248b18eea2415dbd3a26793701743f038aaa))

## [0.2.0](https://github.com/khromov/bun-php/compare/bun-php-v0.1.0...bun-php-v0.2.0) (2026-08-26)

### Features

- configurable interpreters, PHP version selection and a CLI entry point ([b668fdb](https://github.com/khromov/bun-php/commit/b668fdb1e703de47649d48830e4c09ac2c40610f))
- process isolation for CLI runs ([c3c4a1c](https://github.com/khromov/bun-php/commit/c3c4a1c9bf2fce67304d653bccef4d92f34bf68b))
- process isolation for CLI runs ([2d3915f](https://github.com/khromov/bun-php/commit/2d3915f47fd92f57b6de0548a14d80dd793b65c3))
