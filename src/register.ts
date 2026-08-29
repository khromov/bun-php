import { plugin } from "bun";
import { phpPlugin } from "./plugin";

// Registration must happen before any module importing a `.php` file is resolved, which only
// `preload = ["bun-php/register"]` in bunfig.toml guarantees.
plugin(phpPlugin());
