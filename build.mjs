/**
 * Bundles the app into `dist/app.js` (ESM, node) with esbuild; dependencies
 * stay external and come from node_modules. `dist/cli.js` is a two-line
 * launcher that sets NODE_ENV to production before React loads, so React and
 * ink run their production builds instead of the several times slower
 * development ones. `--watch` rebuilds on change.
 */
import { chmodSync, writeFileSync } from "node:fs"
import * as esbuild from "esbuild"

/** The executable: production React unless the caller chose otherwise, then the app. */
const LAUNCHER = `#!/usr/bin/env node
process.env.NODE_ENV ??= "production"
await import("./app.js")
`

const context = await esbuild.context({
  entryPoints: { app: "src/cli.tsx" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  jsx: "automatic",
  packages: "external",
  tsconfig: "tsconfig.json",
  logLevel: "info",
  plugins: [{ name: "launcher", setup: build => build.onEnd(() => {
    writeFileSync("dist/cli.js", LAUNCHER)
    chmodSync("dist/cli.js", 0o755)
  }) }],
})

if (process.argv.includes("--watch")) await context.watch()
else {
  await context.rebuild()
  await context.dispose()
}
