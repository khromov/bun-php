import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

export interface PhpProject {
  /**
   * Host directory to mount into the virtual filesystem. Mounting the project
   * root rather than writing a single file is what makes `require` of sibling
   * files, `__DIR__`, and Composer packages work.
   */
  root: string;
  /** Absolute path of a Composer autoloader to require first, if there is one. */
  autoload: string | null;
}

/** Markers that identify the root of a PHP project, in priority order. */
const ROOT_MARKERS = ["vendor/autoload.php", "composer.json"];

/**
 * Locate the project a `.php` file belongs to.
 *
 * Walks up from the file's directory looking for a Composer project, the same
 * way Composer itself resolves context. Falls back to the file's own directory
 * when there is no project around it.
 */
export function resolveProject(
  filePath: string,
  options: { autoload?: string | false } = {},
): PhpProject {
  const start = dirname(filePath);
  const { root: fsRoot } = parse(start);

  let current = start;
  let found: string | null = null;

  while (true) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(current, marker)))) {
      found = current;
      break;
    }
    const parent = dirname(current);
    if (parent === current || current === fsRoot) break;
    current = parent;
  }

  const root = found ?? start;

  if (options.autoload === false) return { root, autoload: null };
  if (typeof options.autoload === "string") {
    return { root, autoload: options.autoload };
  }

  const autoload = join(root, "vendor/autoload.php");
  return { root, autoload: existsSync(autoload) ? autoload : null };
}
