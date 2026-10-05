/**
 * Bundles the CLI into `dist/cli.js` (ESM, node) with esbuild; dependencies
 * stay external and come from node_modules. `--watch` rebuilds on change.
 */
import { chmodSync } from "node:fs"
import * as esbuild from "esbuild"

const context = await esbuild.context({
  entryPoints: { cli: "src/cli.tsx" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  jsx: "automatic",
  packages: "external",
  tsconfig: "tsconfig.json",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
  plugins: [{ name: "executable", setup: build => build.onEnd(() => chmodSync("dist/cli.js", 0o755)) }],
})

if (process.argv.includes("--watch")) await context.watch()
else {
  await context.rebuild()
  await context.dispose()
}
