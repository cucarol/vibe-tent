// Fake ProviderAdapter — B9a mock only. Never issues paid/network provider requests.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  RouteLaunchPlan,
  ProviderAdapter,
  ProviderCapabilities,
  ResolvedLaunch,
  ResumeToken,
} from "../types.js";
import type { FakeRouteOptions, RuntimeEvent } from "../../runtime/types.js";

export const FAKE_ADAPTER_ID = "fake-cli";

export interface FakeAdapterOptions {
  /** Override node binary (default process.execPath). */
  nodePath?: string;
}

/**
 * Minimal child script: optional stdout, optional wait-for-signal, then exit.
 * Delivered as an inline `node -e` script so tests need no extra fixtures on disk
 * (bootstrap prompt may still land in a temp file when provided).
 */
function buildInlineScript(opts: Required<Pick<FakeRouteOptions, "sleepMs" | "exitCode" | "waitForSignal" | "emitStdout">>): string {
  // Keep this as a single expression string for `node -e`.
  // Intentionally has no network / no provider SDKs.
  return `
const fs = require('fs');
const sleepMs = ${opts.sleepMs};
const exitCode = ${opts.exitCode};
const waitForSignal = ${opts.waitForSignal ? "true" : "false"};
const emitStdout = ${opts.emitStdout ? "true" : "false"};
const promptFile = process.env.TENT_BOOTSTRAP_FILE || '';
if (emitStdout) {
  let prompt = '';
  try { if (promptFile) prompt = fs.readFileSync(promptFile, 'utf8').slice(0, 200); } catch {}
  process.stdout.write('fake-adapter live' + (prompt ? ' prompt=' + JSON.stringify(prompt) : '') + '\\n');
}
function shutdown(code) {
  try { if (promptFile) fs.unlinkSync(promptFile); } catch {}
  process.exit(code);
}
if (waitForSignal) {
  const onStop = () => shutdown(0);
  process.on('SIGTERM', onStop);
  process.on('SIGINT', onStop);
  // Windows: taskkill / SIGTERM via child.kill maps here when possible.
  setInterval(() => {}, 1 << 30);
} else {
  setTimeout(() => shutdown(exitCode), sleepMs);
}
`.trim();
}

function normalizeFakeOpts(raw: unknown): Required<
  Pick<FakeRouteOptions, "sleepMs" | "exitCode" | "waitForSignal" | "emitStdout">
> &
  FakeRouteOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as FakeRouteOptions;
  return {
    sleepMs: typeof o.sleepMs === "number" ? o.sleepMs : 30_000,
    exitCode: typeof o.exitCode === "number" ? o.exitCode : 0,
    waitForSignal: o.waitForSignal !== false,
    emitStdout: o.emitStdout !== false,
    failLaunch: o.failLaunch,
    canResume: o.canResume === true,
  };
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly id = FAKE_ADAPTER_ID;
  readonly displayNameKey = "adapter.fake.displayName";
  private readonly nodePath: string;

  constructor(options: FakeAdapterOptions = {}) {
    this.nodePath = options.nodePath ?? process.execPath;
  }

  capabilities(): ProviderCapabilities {
    return {
      canSpawn: true,
      canResume: false, // default; a route session may store a resume token separately
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "none",
      observeLevel: "process",
    };
  }

  resolveLaunch(plan: RouteLaunchPlan): ResolvedLaunch {
    const fake = normalizeFakeOpts(plan.extras?.fake ?? plan.extras);
    if (fake.failLaunch) {
      throw new Error(fake.failLaunch);
    }

    let bootstrapFile: string | undefined;
    if (plan.bootstrapPrompt != null && plan.bootstrapPrompt.length > 0) {
      bootstrapFile = path.join(
        os.tmpdir(),
        `tent-bootstrap-${plan.sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}.txt`
      );
      fs.writeFileSync(bootstrapFile, plan.bootstrapPrompt, "utf8");
    }

    const script = buildInlineScript(fake);
    const env: Record<string, string> = {
      ...plan.env,
      TENT_SESSION_ID: plan.sessionId,
      TENT_ROUTE_ID: plan.routeId,
    };
    if (bootstrapFile) env.TENT_BOOTSTRAP_FILE = bootstrapFile;

    // Allow route command override only as an explicit test escape hatch.
    if (plan.command) {
      return {
        command: plan.command,
        args: plan.args ?? [],
        cwd: plan.cwd,
        env,
        bootstrapFile,
        stopSignal: "SIGTERM",
      };
    }

    return {
      command: this.nodePath,
      args: ["-e", script],
      cwd: plan.cwd,
      env,
      bootstrapFile,
      stopSignal: "SIGTERM",
    };
  }

  parseResumeToken(raw: string): ResumeToken {
    return { raw, providerSessionId: raw };
  }

  mapExit(code: number | null, signal?: string): RuntimeEvent {
    // Caller fills sessionId; supervisor port rewrites with real id.
    if (signal && signal !== "SIGTERM" && signal !== "SIGINT") {
      return { type: "session.failed", sessionId: "", error: `signal:${signal}` };
    }
    if (code === 0 || code === null && (signal === "SIGTERM" || signal === "SIGINT")) {
      return { type: "session.exited", sessionId: "", exitCode: code };
    }
    if (code !== 0 && code != null) {
      return {
        type: "session.failed",
        sessionId: "",
        error: `exit:${code}`,
      };
    }
    return { type: "session.exited", sessionId: "", exitCode: code };
  }
}

export function createFakeAdapter(options?: FakeAdapterOptions): FakeProviderAdapter {
  return new FakeProviderAdapter(options);
}
