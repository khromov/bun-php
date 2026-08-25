import { plugin } from "bun";
import { phpPlugin } from "./plugin";

/**
 * Side-effecting entry point for `preload`.
 *
 * Registration has to happen before any module that imports a `.php` file is
 * resolved, which rules out calling `Bun.plugin()` from the importing file
 * itself. Add this to bunfig.toml instead:
 *
 *     preload = ["bun-php/register"]
 */
plugin(phpPlugin());
