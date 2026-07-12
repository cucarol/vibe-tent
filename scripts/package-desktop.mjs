// Package Windows portable desktop build via electron-builder (if installed).
// Usage: node scripts/package-desktop.mjs
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// Ensure bundles exist
run("node", ["scripts/build-desktop.mjs"]);
run("npm", ["run", "build"]);

const eb = path.join(root, "node_modules", ".bin", "electron-builder");
if (!fs.existsSync(eb) && !fs.existsSync(eb + ".cmd")) {
  console.error(
    "electron-builder is not installed. Run: npm i -D electron electron-builder\n" +
      "Then re-run: npm run desktop:package"
  );
  process.exit(1);
}

run(eb, ["--win", "portable", "--config", "electron-builder.yml"]);
