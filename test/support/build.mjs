import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stub = resolve(here, "obsidian-stub.mjs");

/** Bundles a source module (with Obsidian replaced by a stub) and imports it. */
export async function importSource(entry) {
  const outfile = join(mkdtempSync(join(tmpdir(), "pdf-annotator-test-")), "module.mjs");
  await build({
    entryPoints: [resolve(here, "../../src", entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
    plugins: [{ name: "obsidian-stub", setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub })); } }],
  });
  return import(pathToFileURL(outfile).href);
}
