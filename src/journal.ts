import { setPhpIniEntries } from "@php-wasm/universal";
import type { PHP } from "@php-wasm/universal";
import { nodeFsMountHandler } from "./php-runtime";

/**
 * One recorded filesystem/config step, kept as plain data because the same
 * journal both replays onto the replacement instance `PHP.cli()` forces and
 * ships to an `isolation: "process"` child as JSON.
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
