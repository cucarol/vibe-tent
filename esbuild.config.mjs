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

// Local Tent Service (B2): attach via loopback HTTP / JSON-RPC
const serviceCtx = await esbuild.context({
  entryPoints: ["src/service/cli.ts"],
  bundle: true,
  external: ["node:*"],
  format: "esm",
  target: "es2021",
  logLevel: "info",
  sourcemap: false,
  treeShaking: true,
  outfile: "service.mjs",
  platform: "node",
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});

if (prod) {
  await pluginCtx.rebuild();
  await cliCtx.rebuild();
  await serviceCtx.rebuild();
  await pluginCtx.dispose();
  await cliCtx.dispose();
  await serviceCtx.dispose();
} else {
  await pluginCtx.watch();
  await cliCtx.watch();
  await serviceCtx.watch();
}
