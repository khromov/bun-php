import { setPhpIniEntries } from "@php-wasm/universal";
import type { PHP } from "@php-wasm/universal";
import { nodeFsMountHandler } from "./php-runtime";

/**
 * One recorded filesystem/config step, in a shape that survives JSON.
 *
 * The journal exists for two reasons that share a mechanism: `PHP.cli()`
 * consumes its instance, so a replacement has to replay what was staged; and
 * `isolation: "process"` ships the same steps to a child process, which only
 * works because nothing in them is a function.
 */
export type JournalOp =
  | { readonly kind: "mount"; readonly host: string; readonly at: string }
  | {
      readonly kind: "writeFile";
      readonly path: string;
      readonly data: string;
      readonly encoding: "utf8" | "base64";
    }
  | { readonly kind: "mkdir"; readonly path: string }
  | { readonly kind: "ini"; readonly entries: Record<string, string | number> };

export function writeFileOp(path: string, data: string | Uint8Array): JournalOp {
  if (typeof data === "string") return { kind: "writeFile", path, data, encoding: "utf8" };
  return {
    kind: "writeFile",
    path,
    data: Buffer.from(data).toString("base64"),
    encoding: "base64",
  };
}

export async function applyJournalOp(php: PHP, op: JournalOp): Promise<void> {
  switch (op.kind) {
    case "mount":
      php.mkdir(op.at);
      await php.mount(op.at, nodeFsMountHandler(op.host));
      return;
    case "writeFile":
      php.writeFile(
        op.path,
        op.encoding === "base64" ? new Uint8Array(Buffer.from(op.data, "base64")) : op.data,
      );
      return;
    case "mkdir":
      php.mkdir(op.path);
      return;
    case "ini":
      await setPhpIniEntries(php, op.entries);
      return;
  }
}
