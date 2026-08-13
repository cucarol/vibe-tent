// Agent-facing Node operations through Local Service. Never direct-write .tent.

import type { ServiceClient } from "../service/client.js";
import { attachOrBootstrapService, type CliAttachOptions } from "./service-attach.js";
import { ensureMountedWorkspace } from "./workspace-context.js";

export type NodeRpcGlobalOptions = {
  workspace?: string;
  cwd?: string;
  dataDir?: string;
  attachOnly?: boolean;
  serviceEntry?: string;
  packageRoot?: string;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  client?: ServiceClient;
};

export type NodeCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type NodeProjection = {
  nodeId: string;
  name: string;
  path: string;
  type?: string;
  mode?: string;
  children?: NodeProjection[];
};

export async function runNodeCommand(
  sub: string,
  args: string[],
  globals: NodeRpcGlobalOptions = {}
): Promise<NodeCommandResult> {
  try {
    const { positionals, flags } = parseFlags(args);
    const json = globals.json === true || flags.json === "true";
    const attachOpts: CliAttachOptions = {
      dataDir: flags["data-dir"] || globals.dataDir,
      attachOnly: globals.attachOnly === true || flags["attach-only"] === "true",
      serviceEntry: flags["service-entry"] || globals.serviceEntry,
      packageRoot: globals.packageRoot,
      env: globals.env,
    };
    const client =
      globals.client ?? (await attachOrBootstrapService(attachOpts)).client;
    const mounted = await ensureMountedWorkspace(client, {
      cwd: globals.cwd,
      workspace: flags.workspace || globals.workspace,
    });
    const workspaceId = mounted.workspaceId;

    switch (sub) {
      case "list": {
        if (positionals.length > 0) return usage("tent node list [--json]");
        const result = await client.docsList(workspaceId, false);
        return print(result, json, () => formatTree(result.nodes));
      }
      case "get": {
        const target = oneTarget(positionals, "tent node get <nodeId> [--json]");
        if (typeof target !== "string") return target;
        const result = await client.docsGet(workspaceId, nodeRef(target));
        return print(result, json, (value) => formatNode(value));
      }
      case "create": {
        const name = oneTarget(
          positionals,
          "tent node create <name> [--type <type>] [--parent <nodeId|root>] [--body <text>|-] [--tags a,b] [--json]"
        );
        if (typeof name !== "string") return name;
        let body = flagValue(flags, "body");
        if (body === "-") body = await readStdin();
        const parentPath = await resolveParentPath(client, workspaceId, flags.parent);
        const created = await client.docsCreateNote(workspaceId, {
          name,
          ...(flags.type ? { type: flags.type } : {}),
          parentPath,
          ...(body !== undefined ? { body } : {}),
        });
        const tags = parseCsv(flags.tags);
        if (tags.length > 0) {
          for (const tag of tags) await client.registryTagCreate(workspaceId, { name: tag });
          const edit = await client.docsReadForEdit(workspaceId, created.nodeId);
          await client.docsTagsSet(workspaceId, {
            nodeId: created.nodeId,
            tags,
            baseEtag: edit.etag,
          });
        }
        const result = await client.docsGet(workspaceId, created.nodeId);
        return print(result, json, (value) => `Created ${formatNode(value)}`);
      }
      case "write": {
        const target = oneTarget(positionals, "tent node write <nodeId> --body <text>|- [--json]");
        if (typeof target !== "string") return target;
        let body = flagValue(flags, "body");
        if (body === undefined) return usage("tent node write <nodeId> --body <text>|- [--json]");
        if (body === "-") body = await readStdin();
        const ref = nodeRef(target);
        const edit = await client.docsReadForEdit(workspaceId, ref);
        const result = await client.docsWrite(workspaceId, {
          nodeId: ref,
          body,
          baseEtag: edit.etag,
        });
        return print(result, json, () => `Updated ${edit.nodeId} ${edit.path}`);
      }
      case "rename": {
        if (positionals.length !== 2) return usage("tent node rename <nodeId> <new-name> [--json]");
        const result = await client.docsRename(workspaceId, {
          nodeId: nodeRef(positionals[0]),
          newName: positionals[1],
        });
        return print(result, json, (value) => `Renamed ${formatNode(value)}`);
      }
      case "move": {
        const target = oneTarget(positionals, "tent node move <nodeId> --parent <nodeId|root> [--json]");
        if (typeof target !== "string" || !/^cx-[a-z0-9]+$/i.test(target)) {
          return typeof target === "string"
            ? usage("tent node move requires a stable cx- id")
            : target;
        }
        if (!Object.prototype.hasOwnProperty.call(flags, "parent")) {
          return usage("tent node move <nodeId> --parent <nodeId|root> [--json]");
        }
        const current = (await client.docsGet(workspaceId, target)) as {
          node: NodeProjection;
        };
        const parent = flags.parent;
        const newParentId = !parent || parent === "root" ? null : parent;
        if (newParentId && !/^cx-[a-z0-9]+$/i.test(newParentId)) {
          return usage("tent node move --parent must be root or a stable cx- id");
        }
        const result = await client.docsMove(workspaceId, {
          nodeId: target,
          expectedPath: current.node.path,
          newParentId,
          position: { mode: "inside" },
        });
        return print(result, json, () => `Moved ${target}`);
      }
      case "archive":
      case "restore": {
        const target = oneTarget(positionals, `tent node ${sub} <nodeId> [--json]`);
        if (typeof target !== "string") return target;
        const mode = sub === "archive" ? "archived" : "editable";
        const result = await client.docsSetMode(workspaceId, {
          nodeId: nodeRef(target),
          mode,
        });
        return print(result, json, () => `${sub === "archive" ? "Archived" : "Restored"} ${target}`);
      }
      case "type": {
        if (positionals.length !== 2) return usage("tent node type <nodeId> <type> [--json]");
        const ref = nodeRef(positionals[0]);
        const edit = await client.docsReadForEdit(workspaceId, ref);
        const result = await client.docsSetType(workspaceId, {
          nodeId: ref,
          type: positionals[1],
          baseEtag: edit.etag,
        });
        return print(result, json, () => `Updated type for ${edit.nodeId}`);
      }
      case "tags": {
        const action = positionals[0];
        const target = positionals[1];
        if (!action || !target || !["set", "add", "remove"].includes(action)) {
          return usage("tent node tags set|add|remove <nodeId> <tag[,tag...]> [--json]");
        }
        const values = parseCsv(positionals.slice(2).join(","));
        if (values.length === 0 && action !== "set") {
          return usage("tent node tags set|add|remove <nodeId> <tag[,tag...]> [--json]");
        }
        const ref = nodeRef(target);
        let last: unknown;
        if (action === "set") {
          for (const tag of values) await client.registryTagCreate(workspaceId, { name: tag });
          const edit = await client.docsReadForEdit(workspaceId, ref);
          last = await client.docsTagsSet(workspaceId, {
            nodeId: ref,
            tags: values,
            baseEtag: edit.etag,
          });
        } else {
          for (const tag of values) {
            if (action === "add") await client.registryTagCreate(workspaceId, { name: tag });
            const edit = await client.docsReadForEdit(workspaceId, ref);
            last = action === "add"
              ? await client.docsTagAdd(workspaceId, { nodeId: ref, tag, baseEtag: edit.etag })
              : await client.docsTagRemove(workspaceId, { nodeId: ref, tag, baseEtag: edit.etag });
          }
        }
        return print(last ?? { workspaceId }, json, () => `Updated tags for ${target}`);
      }
      default:
        return usage(nodeHelpText());
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}

export function nodeHelpText(): string {
  return `tent node - Service-backed Node operations

Usage:
  tent node list [--workspace <path>] [--json]
  tent node get <nodeId> [--workspace <path>] [--json]
  tent node create <name> [--type <type>] [--parent <nodeId|root>] [--body <text>|-] [--tags a,b] [--json]
  tent node write <nodeId> --body <text>|- [--json]
  tent node rename <nodeId> <new-name> [--json]
  tent node move <nodeId> --parent <nodeId|root> [--json]
  tent node archive|restore <nodeId> [--json]
  tent node type <nodeId> <type> [--json]
  tent node tags set|add|remove <nodeId> <tag[,tag...]> [--json]

All mutations go through Local Service. No command writes .tent directly.`;
}

function nodeRef(value: string): string {
  if (!/^cx-[a-z0-9]+$/i.test(value)) throw new Error(`Expected canonical Node id (cx-*): ${value}`);
  return value;
}

async function resolveParentPath(
  client: ServiceClient,
  workspaceId: string,
  value: string | undefined
): Promise<string> {
  if (!value || value === "root") return "";
  const result = (await client.docsGet(workspaceId, nodeRef(value))) as {
    node: NodeProjection;
  };
  return result.node.path;
}

function oneTarget(positionals: string[], help: string): string | NodeCommandResult {
  return positionals.length === 1 ? positionals[0] : usage(help);
}

function flagValue(flags: Record<string, string>, name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(flags, name) ? flags[name] : undefined;
}

function parseCsv(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
}

function parseFlags(args: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const booleans = new Set(["json", "attach-only"]);
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    if (booleans.has(name)) {
      flags[name] = "true";
      continue;
    }
    if (i + 1 >= args.length) {
      flags[name] = "";
      continue;
    }
    flags[name] = args[++i];
  }
  return { positionals, flags };
}

function print(
  value: unknown,
  json: boolean,
  format: (value: unknown) => string
): NodeCommandResult {
  return {
    exitCode: 0,
    stdout: json ? JSON.stringify(value, null, 2) + "\n" : format(value).trimEnd() + "\n",
    stderr: "",
  };
}

function usage(text: string): NodeCommandResult {
  return { exitCode: 1, stdout: "", stderr: text.trimEnd() + "\n" };
}

function formatNode(value: unknown): string {
  const node = (value as { node?: NodeProjection }).node;
  if (!node) return JSON.stringify(value);
  return `${node.nodeId}  ${node.type}  ${node.path}`;
}

function formatTree(nodes: NodeProjection[]): string {
  const lines: string[] = [];
  const visit = (node: NodeProjection, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${node.nodeId}  ${node.type}  ${node.name}`);
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  for (const node of nodes) visit(node, 0);
  return lines.length > 0 ? lines.join("\n") : "(no nodes)";
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
