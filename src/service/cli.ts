// Minimal bootstrap entry: tent-service [start]
// Desktop/CLI clients attach via loopback HTTP; this process outlives UI windows.
// Shebang is injected by esbuild banner in esbuild.config.mjs (avoid double shebang).

import * as path from "node:path";
import { startLocalTentService } from "./service.js";
import { defaultServiceDataDir, readServiceEndpoint } from "./data-dir.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "start";

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(
      [
        "tent-service — Local Tent Service (B5)",
        "",
        "Usage:",
        "  tent-service start [--port <n>] [--data-dir <path>] [--mount <workspace>]",
        "  tent-service status",
        "",
        "Environment:",
        "  TENT_SERVICE_DATA_DIR  machine-local data area (default: %APPDATA%/Tent)",
        "",
        "Auth:",
        "  Loopback token is written to <dataDir>/service.json and required on /rpc + /events.",
        "  GET /health remains open for attach discovery (no mutation).",
        "",
      ].join("\n")
    );
    return;
  }

  if (cmd === "status") {
    const dataDir = flagValue(args, "--data-dir") ?? defaultServiceDataDir();
    const ep = await readServiceEndpoint(dataDir);
    if (!ep) {
      process.stdout.write(`No service endpoint in ${dataDir}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(JSON.stringify(ep, null, 2) + "\n");
    return;
  }

  if (cmd !== "start") {
    process.stderr.write(`Unknown command: ${cmd}\n`);
    process.exitCode = 2;
    return;
  }

  const portRaw = flagValue(args, "--port");
  const dataDir = flagValue(args, "--data-dir");
  const mountPath = flagValue(args, "--mount");

  const service = await startLocalTentService({
    port: portRaw ? Number(portRaw) : 0,
    dataDir: dataDir ? path.resolve(dataDir) : undefined,
  });

  if (mountPath) {
    const info = await service.hostApi.mount(path.resolve(mountPath));
    process.stdout.write(`Mounted ${info.workspaceRoot} as ${info.workspaceId}\n`);
  }

  process.stdout.write(
    `Local Tent Service listening on ${service.url}\n` +
      `dataDir: ${service.dataDir}\n` +
      `pid: ${process.pid}\n` +
      `token: (written to service.json under dataDir; required on /rpc and /events)\n` +
      `Attach: POST ${service.url}/rpc  |  events: GET ${service.url}/events  |  health: GET ${service.url}/health\n`
  );

  const shutdown = async (signal: string) => {
    process.stdout.write(`\nStopping (${signal})...\n`);
    await service.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.stack || error.message : String(error)) + "\n");
  process.exit(1);
});
