// Proposal submit via Local Service RPC (task-api §3 — separate from delivery).
// In-workspace tent propose MUST go through this path — no direct core mutation.

import type { ServiceClient } from "../service/client.js";
import { attachOrBootstrapService, type CliAttachOptions } from "./service-attach.js";
import { ensureMountedWorkspace } from "./workspace-context.js";

export type ProposalRpcGlobalOptions = {
  workspace?: string;
  cwd?: string;
  dataDir?: string;
  attachOnly?: boolean;
  serviceEntry?: string;
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected client (tests); skips attach when set. */
  client?: ServiceClient;
};

export type ProposalCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * Submit a proposal through Local Service (attach → mount → proposal.submit).
 * Role must already be validated by the caller (TENT_ROLE).
 */
export async function runProposalSubmit(
  args: {
    nodeId: string;
    role: string;
    body: string;
  },
  globals: ProposalRpcGlobalOptions = {}
): Promise<ProposalCommandResult> {
  try {
    const attachOpts: CliAttachOptions = {
      dataDir: globals.dataDir,
      attachOnly: globals.attachOnly === true,
      serviceEntry: globals.serviceEntry,
      packageRoot: globals.packageRoot,
      env: globals.env,
    };

    const client =
      globals.client ??
      (
        await attachOrBootstrapService(attachOpts)
      ).client;

    const ctx = await ensureMountedWorkspace(client, {
      cwd: globals.cwd,
      workspace: globals.workspace,
    });

    const result = (await client.proposalSubmit(ctx.workspaceId, {
      nodeId: args.nodeId,
      role: args.role,
      body: args.body,
    })) as { proposal?: { path?: string } };

    const proposalPath = result.proposal?.path;
    if (!proposalPath) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "proposal.submit returned no proposal path\n",
      };
    }
    return {
      exitCode: 0,
      stdout: `✓ Proposal submitted for triage: ${proposalPath}\n`,
      stderr: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}
