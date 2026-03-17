import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";

const production = process.argv.includes("production");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", ...builtins],
  format: "cjs",
  target: "es2021",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
