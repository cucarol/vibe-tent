import esbuild from "esbuild";
import process from "node:process";

const prod = process.argv[2] === "production";

const pluginCtx = await esbuild.context({
  entryPoints: ["src/plugin/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "node:*", "child_process", "fs", "path", "os", "util"],
  format: "cjs",
  target: "es2021",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  platform: "node",
});

// CLI 打包(给 agent 侧五个 skill 调用):tent <cmd> ...
const cliCtx = await esbuild.context({
  entryPoints: ["src/cli/tent.ts"],
  bundle: true,
  external: ["node:*"],
  format: "esm",
  target: "es2021",
  logLevel: "info",
  sourcemap: false,
  treeShaking: true,
  outfile: "cli.mjs",
  platform: "node",
});

if (prod) {
  await pluginCtx.rebuild();
  await cliCtx.rebuild();
  await pluginCtx.dispose();
  await cliCtx.dispose();
} else {
  await pluginCtx.watch();
  await cliCtx.watch();
}
