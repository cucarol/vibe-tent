// Machine-local protection for LaunchSecretStore.
// Windows MVP: CurrentUser DPAPI via PowerShell — plaintext only on stdin (never argv/logs).
// Non-Windows: fail-loud (no weak crypto fallback). Tests inject protect/unprotect.

import { spawn } from "node:child_process";

/** Protect / unprotect pair. Ciphertext is opaque base64 (or test-injected format). */
export type LaunchSecretProtector = {
  protect(plaintext: string): Promise<string>;
  unprotect(ciphertext: string): Promise<string>;
};

const NON_WINDOWS_MSG =
  "LaunchSecretStore requires Windows DPAPI (CurrentUser); non-Windows is not supported in this MVP (no weak-crypto fallback)";

/**
 * Platform protector. Windows → DPAPI CurrentUser; elsewhere throws on use.
 * Prefer injecting a protector in tests so suites stay offline and cross-platform.
 */
export function createPlatformLaunchSecretProtector(
  platform: NodeJS.Platform = process.platform
): LaunchSecretProtector {
  if (platform !== "win32") {
    return {
      protect: async () => {
        throw new Error(NON_WINDOWS_MSG);
      },
      unprotect: async () => {
        throw new Error(NON_WINDOWS_MSG);
      },
    };
  }
  return createWindowsDpapiLaunchSecretProtector();
}

/**
 * Windows DPAPI (CurrentUser) via PowerShell.
 * Plaintext / ciphertext travel only on process stdin — never in argv, env, or scripts.
 * Payload is base64 on the wire so binary-safe; argv never contains secret material.
 */
export function createWindowsDpapiLaunchSecretProtector(): LaunchSecretProtector {
  return {
    protect: async (plaintext) => {
      const b64In = Buffer.from(plaintext, "utf8").toString("base64");
      const b64Out = await runPowerShellStdin(
        [
          "Add-Type -AssemblyName System.Security",
          "$b64 = [Console]::In.ReadToEnd().Trim()",
          "$plain = [Convert]::FromBase64String($b64)",
          "$prot = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
          "[Convert]::ToBase64String($prot)",
        ].join("; "),
        b64In,
        "protect"
      );
      return b64Out.trim();
    },
    unprotect: async (ciphertext) => {
      const b64Out = await runPowerShellStdin(
        [
          "Add-Type -AssemblyName System.Security",
          "$b64 = [Console]::In.ReadToEnd().Trim()",
          "$prot = [Convert]::FromBase64String($b64)",
          "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($prot, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
          "[Convert]::ToBase64String($plain)",
        ].join("; "),
        ciphertext.trim(),
        "unprotect"
      );
      return Buffer.from(b64Out.trim(), "base64").toString("utf8");
    },
  };
}

/**
 * Spawn PowerShell with secret material only on stdin.
 * Errors report exit code / operation only — never stdin, stdout, or stderr bodies.
 */
function runPowerShellStdin(
  command: string,
  stdinData: string,
  op: "protect" | "unprotect"
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    let stdout = "";
    // Drain stderr so the pipe cannot block; never log or rethrow its body.
    child.stderr?.on("data", () => {
      // intentionally discarded
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(
        new Error(
          `DPAPI PowerShell ${op} failed to start: ${err instanceof Error ? err.message : "spawn error"}`
        )
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`DPAPI PowerShell ${op} failed (exit=${code ?? "null"})`));
        return;
      }
      resolve(stdout.replace(/^\uFEFF/, "").replace(/\r?\n$/, ""));
    });
    child.stdin?.on("error", (err) => {
      reject(
        new Error(
          `DPAPI PowerShell ${op} stdin failed: ${err instanceof Error ? err.message : "stdin error"}`
        )
      );
    });
    child.stdin?.end(stdinData, "utf8");
  });
}

/** In-memory envelope test protector (not secure). For offline unit tests only. */
export function createTestLaunchSecretProtector(prefix = "test-enc:"): LaunchSecretProtector {
  return {
    async protect(plaintext: string): Promise<string> {
      return prefix + Buffer.from(plaintext, "utf8").toString("base64");
    },
    async unprotect(ciphertext: string): Promise<string> {
      if (!ciphertext.startsWith(prefix)) {
        throw new Error("Test protector: invalid ciphertext envelope");
      }
      return Buffer.from(ciphertext.slice(prefix.length), "base64").toString("utf8");
    },
  };
}
