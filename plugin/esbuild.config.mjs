import esbuild from "esbuild"

const watch = process.argv.includes("--watch")

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Provided by Obsidian at runtime.
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2020",
  platform: "browser",
  logLevel: "info",
  sourcemap: watch ? "inline" : false,
  treeShaking: true,
  outfile: "main.js"
})

if (watch) await context.watch()
else {
  await context.rebuild()
  await context.dispose()
}
