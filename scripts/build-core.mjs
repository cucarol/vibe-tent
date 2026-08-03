import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist-core");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");

if (path.dirname(output) !== root || path.basename(output) !== "dist-core") {
  throw new Error(`Refusing to clean unexpected Core output path: ${output}`);
}

await fs.rm(output, { recursive: true, force: true });

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [tsc, "-p", "tsconfig.core.json"], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`TypeScript compiler stopped by ${signal}.`));
    else resolve(code ?? 1);
  });
});

if (exitCode !== 0) process.exitCode = exitCode;
