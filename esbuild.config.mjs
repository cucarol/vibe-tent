import esbuild from "esbuild";
import process from "node:process";

const prod = process.argv[2] === "production";

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
  await cliCtx.rebuild();
  await serviceCtx.rebuild();
  await cliCtx.dispose();
  await serviceCtx.dispose();
} else {
  await cliCtx.watch();
  await serviceCtx.watch();
}
