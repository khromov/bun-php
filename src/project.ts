import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PhpProject {
  /** Host directory to mount; mounting the root is what makes sibling `require`, `__DIR__` and Composer work. */
  root: string;
  /** Composer autoloader to require first, if there is one. */
  autoload: string | null;
}

const ROOT_MARKERS = ["vendor/autoload.php", "composer.json"];

/** The project a `.php` file belongs to: the nearest ancestor with a Composer marker, else its own directory. */
export function resolveProject(
  filePath: string,
  options: { autoload?: string | false } = {},
): PhpProject {
  const start = dirname(filePath);
  let root = start;
  for (let dir = start; ; dir = dirname(dir)) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) {
      root = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }

  if (options.autoload === false) return { root, autoload: null };
  if (typeof options.autoload === "string") return { root, autoload: options.autoload };
  const autoload = join(root, "vendor/autoload.php");
  return { root, autoload: existsSync(autoload) ? autoload : null };
}
