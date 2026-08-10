#!/usr/bin/env node

// src/cli/tent.ts
import * as path10 from "node:path";
import * as fs9 from "node:fs/promises";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/fs/node-fs.ts
import * as fs2 from "node:fs/promises";
import * as nodePath from "node:path";

// src/fs/mutation-lock.ts
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
var MUTATION_LOCK_STALE_MS = 12e4;
async function withFileMutationLock(lockPath, action, options) {
  const now = options.now ?? Date.now;
  const makeOwnerToken = options.makeOwnerToken ?? randomUUID;
  const staleMs = options.staleMs ?? MUTATION_LOCK_STALE_MS;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const ownerToken = makeOwnerToken();
  const record = {
    ownerToken,
    pid: process.pid,
    createdAt: new Date(now()).toISOString()
  };
  await fs.mkdir(dirnameOf(lockPath), { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      handle = await fs.open(lockPath, "wx");
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const reclaimable = await mayReclaimLock(lockPath, now, staleMs, isProcessAlive);
      if (!reclaimable || attempt >= 2) {
        throw new Error(options.busyMessage);
      }
      const quarantine = `${lockPath}.stale-${randomUUID()}`;
      try {
        await fs.rename(lockPath, quarantine);
        await fs.rm(quarantine, { force: true }).catch(() => void 0);
      } catch (renameError) {
        if (isNotFound(renameError)) continue;
        throw renameError;
      }
    }
  }
  if (!handle) throw new Error(options.acquireFailedMessage);
  try {
    await handle.writeFile(JSON.stringify(record), "utf8");
    return await action();
  } finally {
    await handle.close().catch(() => void 0);
    await releaseMutationLockIfOwned(lockPath, ownerToken);
  }
}
async function releaseMutationLockIfOwned(lockPath, ownerToken) {
  const quarantine = `${lockPath}.releasing-${ownerToken}`;
  try {
    await fs.rename(lockPath, quarantine);
  } catch (error) {
    if (isNotFound(error)) return false;
    return false;
  }
  const current = await readMutationLockRecord(quarantine);
  if (current?.ownerToken === ownerToken) {
    await fs.rm(quarantine, { force: true }).catch(() => void 0);
    return true;
  }
  try {
    await fs.rename(quarantine, lockPath);
  } catch {
    await fs.rm(quarantine, { force: true }).catch(() => void 0);
  }
  return false;
}
async function readMutationLockRecord(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const value = JSON.parse(raw);
    if (typeof value.ownerToken !== "string" || !value.ownerToken || typeof value.pid !== "number" || !Number.isInteger(value.pid) || typeof value.createdAt !== "string") {
      return null;
    }
    return value;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null;
    return null;
  }
}
async function mayReclaimLock(lockPath, now = Date.now, staleMs = MUTATION_LOCK_STALE_MS, isProcessAliveFn = processIsAlive) {
  let mtimeMs;
  try {
    const stat2 = await fs.stat(lockPath);
    mtimeMs = stat2.mtimeMs;
  } catch (error) {
    if (isNotFound(error)) return false;
    return true;
  }
  if (now() - mtimeMs <= staleMs) {
    return false;
  }
  const pid = await readRecordedPid(lockPath);
  if (pid !== null && isProcessAliveFn(pid)) {
    return false;
  }
  return true;
}
async function readRecordedPid(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const value = JSON.parse(raw);
    if (typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0) {
      return value.pid;
    }
    return null;
  } catch {
    return null;
  }
}
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}
function dirnameOf(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? "." : p.slice(0, i);
}
function isAlreadyExists(error) {
  return hasCode(error, "EEXIST");
}
function isNotFound(error) {
  return hasCode(error, "ENOENT");
}
function hasCode(error, code) {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

// src/fs/node-fs.ts
var NodeFs = class {
  constructor(root) {
    this.root = nodePath.resolve(root);
  }
  abs(p) {
    const resolved = nodePath.resolve(this.root, p);
    const root = process.platform === "win32" ? this.root.toLowerCase() : this.root;
    const candidate = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (candidate !== root && !candidate.startsWith(root + nodePath.sep)) {
      throw new Error(`Path escapes Tent root: ${p}`);
    }
    return resolved;
  }
  async listDir(dir) {
    const entries = await fs2.readdir(this.abs(dir), { withFileTypes: true });
    return entries.filter((e) => !e.name.startsWith(".git")).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  }
  async readFile(path11) {
    return fs2.readFile(this.abs(path11), "utf8");
  }
  async writeFile(path11, content) {
    const abs = this.abs(path11);
    await fs2.mkdir(nodePath.dirname(abs), { recursive: true });
    await this.atomicReplace(abs, content, "utf8");
  }
  async readBinary(path11) {
    const buf = await fs2.readFile(this.abs(path11));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  async readBinaryBounded(path11, maxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error(`Invalid binary read limit: ${maxBytes}`);
    }
    const handle = await fs2.open(this.abs(path11), "r");
    try {
      const bytes = new Uint8Array(maxBytes);
      let offset = 0;
      while (offset < maxBytes) {
        const read = await handle.read(bytes, offset, maxBytes - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      const stat2 = await handle.stat();
      return {
        bytes: bytes.subarray(0, offset),
        truncated: stat2.size > offset
      };
    } finally {
      await handle.close();
    }
  }
  async writeBinary(path11, data) {
    const abs = this.abs(path11);
    await fs2.mkdir(nodePath.dirname(abs), { recursive: true });
    const payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await this.atomicReplace(abs, payload);
  }
  async atomicReplace(abs, data, encoding) {
    const tmp = `${abs}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fs2.writeFile(tmp, data, encoding);
      await this.renameReplacingWithRetry(tmp, abs);
    } catch (err) {
      await fs2.rm(tmp, { force: true }).catch(() => void 0);
      throw err;
    }
  }
  async renameReplacingWithRetry(from, to) {
    const attempts = process.platform === "win32" ? 10 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await fs2.rename(from, to);
        return;
      } catch (err) {
        const code = err.code;
        const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
        if (!transient || attempt === attempts - 1) throw err;
        const delayMs = Math.min(10 * 2 ** attempt, 100);
        await new Promise((resolve10) => setTimeout(resolve10, delayMs));
      }
    }
  }
  async exists(path11) {
    try {
      await fs2.access(this.abs(path11));
      return true;
    } catch {
      return false;
    }
  }
  async mkdir(path11) {
    await fs2.mkdir(this.abs(path11), { recursive: true });
  }
  async move(from, to) {
    await fs2.mkdir(nodePath.dirname(this.abs(to)), { recursive: true });
    await fs2.rename(this.abs(from), this.abs(to));
  }
  async remove(path11) {
    await fs2.rm(this.abs(path11), { recursive: true, force: true });
  }
  async withLock(path11, action) {
    return withFileMutationLock(this.abs(path11), action, {
      busyMessage: "Tent is already running another write operation; try again later.",
      acquireFailedMessage: "Cannot acquire the Tent mutation lock."
    });
  }
};
var SystemClock = class {
  now() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
};

// src/machine/skills.ts
import * as fs3 from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
var SKILL_TARGET_IDS = ["shared-agents", "claude"];
var SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
function isSkillTargetId(value) {
  return SKILL_TARGET_IDS.includes(value);
}
function skillTargetDir(target, home) {
  const root = home ?? os.homedir();
  switch (target) {
    case "claude":
      return path.join(root, ".claude", "skills");
    case "shared-agents":
      return path.join(root, ".agents", "skills");
    default: {
      const _exhaustive = target;
      throw new Error(`Unknown skill target: ${String(_exhaustive)}`);
    }
  }
}
function defaultSkillInstallDirs(home) {
  return SKILL_TARGET_IDS.map((id) => skillTargetDir(id, home));
}
function resolveCliSkillInstallDirs(cliTarget, home) {
  const target = cliTarget.trim();
  if (target === "all") return defaultSkillInstallDirs(home);
  return [skillTargetDir(parseSkillTargetId(target), home)];
}
function assertSafeSkillName(name) {
  const trimmed = name.trim();
  if (!trimmed || !SAFE_SKILL_NAME.test(trimmed) || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\") || path.basename(trimmed) !== trimmed) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return trimmed;
}
function parseSkillTargetId(value) {
  const trimmed = value.trim();
  if (!isSkillTargetId(trimmed)) {
    throw new Error(
      `Unknown skill target: ${value} (allowed: ${SKILL_TARGET_IDS.join(", ")})`
    );
  }
  return trimmed;
}
function bundledSkillsDir(packageRoot2) {
  return path.join(packageRoot2, "skills");
}
async function listBundledSkillNames(packageRoot2) {
  const sourceDir = bundledSkillsDir(packageRoot2);
  let entries;
  try {
    entries = await fs3.readdir(sourceDir, { withFileTypes: true });
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : void 0;
    if (code === "ENOENT") {
      throw new Error(`No installable skills found in ${sourceDir}`);
    }
    throw err;
  }
  const skillNames = [];
  for (const entry2 of entries) {
    if (!entry2.isDirectory()) continue;
    if (!SAFE_SKILL_NAME.test(entry2.name)) continue;
    if (await existsPath(path.join(sourceDir, entry2.name, "SKILL.md"))) {
      skillNames.push(entry2.name);
    }
  }
  skillNames.sort();
  return skillNames;
}
async function installSkills(options) {
  const home = options.home ?? os.homedir();
  const force = options.force === true;
  const sourceDir = bundledSkillsDir(options.packageRoot);
  const allNames = await listBundledSkillNames(options.packageRoot);
  if (allNames.length === 0) {
    throw new Error(`No installable skills found in ${sourceDir}`);
  }
  const selectedNames = resolveSkillSelection(options.skills, allNames);
  const destinations = resolveInstallDestinations(options, home);
  if (destinations.length === 0) {
    throw new Error("skill-install requires at least one target directory");
  }
  const results = [];
  for (const dest of destinations) {
    await fs3.mkdir(dest.dir, { recursive: true });
    for (const name of selectedNames) {
      const source = path.join(sourceDir, name);
      const target = path.join(dest.dir, name);
      assertChildPath(sourceDir, source);
      assertChildPath(dest.dir, target);
      const exists2 = await existsPath(target);
      if (exists2 && !force) {
        results.push({
          targetDir: dest.dir,
          ...dest.target ? { target: dest.target } : {},
          skill: name,
          status: "skipped",
          reason: "already exists (use --force to overwrite)"
        });
        continue;
      }
      if (exists2 && force) {
        await fs3.rm(target, { recursive: true, force: true });
      }
      await fs3.cp(source, target, { recursive: true, errorOnExist: true });
      results.push({
        targetDir: dest.dir,
        ...dest.target ? { target: dest.target } : {},
        skill: name,
        status: "installed"
      });
    }
  }
  return results;
}
function resolveSkillSelection(requested, allNames) {
  if (!requested || requested.length === 0) return [...allNames];
  const known = new Set(allNames);
  const selected = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of requested) {
    const name = assertSafeSkillName(raw);
    if (!known.has(name)) {
      throw new Error(`Unknown bundled skill: ${name}`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    selected.push(name);
  }
  selected.sort();
  return selected;
}
function resolveInstallDestinations(options, home) {
  if (options.targetDirs !== void 0) {
    if (options.targetDirs.length === 0) {
      throw new Error("skill-install requires at least one target directory");
    }
    return options.targetDirs.map((dir) => ({ dir: path.resolve(dir) }));
  }
  const targetIds = options.targets && options.targets.length > 0 ? options.targets.map((t) => parseSkillTargetId(t)) : [...SKILL_TARGET_IDS];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const id of targetIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ dir: skillTargetDir(id, home), target: id });
  }
  return out;
}
function assertChildPath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Install target escapes the destination directory: ${child}`);
  }
}
async function existsPath(target) {
  try {
    await fs3.access(target);
    return true;
  } catch {
    return false;
  }
}

// src/machine/agent-hooks.ts
import * as fs4 from "node:fs/promises";
import * as os2 from "node:os";
import * as path2 from "node:path";
var AGENT_HOOK_IDS = ["claude", "codex", "copilot"];
var AGENT_ALIASES = {
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  copilot: "copilot",
  "github-copilot": "copilot"
};
var TENT_HOOK_MARKER = "tent-managed-hook";
function parseAgentHookId(value) {
  const key = value.trim().toLowerCase();
  const id = AGENT_ALIASES[key];
  if (!id) {
    throw new Error(
      `Unknown agent: ${value} (allowed: all, ${AGENT_HOOK_IDS.join(", ")})`
    );
  }
  return id;
}
function resolveAgentHookSelection(raw) {
  if (!raw || raw.length === 0) return [...AGENT_HOOK_IDS];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of raw) {
    const trimmed = item.trim().toLowerCase();
    if (trimmed === "all") {
      return [...AGENT_HOOK_IDS];
    }
    const id = parseAgentHookId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
function claudeSettingsPath(home) {
  return path2.join(home ?? os2.homedir(), ".claude", "settings.json");
}
function codexHooksPath(home) {
  return path2.join(home ?? os2.homedir(), ".codex", "hooks.json");
}
function managedSessionStartCommand(agent, tentCommand) {
  const base = (tentCommand ?? "tent").trim() || "tent";
  const tent = base === "tent" ? "tent" : quoteIfNeeded(base);
  return `${tent} session session-start --host ${agent}`;
}
function managedSessionEndCommand(agent, tentCommand) {
  const base = (tentCommand ?? "tent").trim() || "tent";
  const tent = base === "tent" ? "tent" : quoteIfNeeded(base);
  return `${tent} session session-end --host ${agent}`;
}
function isManagedHookCommand(command) {
  if (!command || typeof command !== "string") return false;
  const c = command.trim();
  if (managedCommandHost(c) === null) return false;
  if (!/tent/i.test(c)) return false;
  return isManagedStartStem(c) || isManagedEndStem(c);
}
function isManagedEnterCommand(command) {
  if (!isManagedHookCommand(command)) return false;
  return isManagedStartStem(String(command));
}
function isManagedLeaveCommand(command) {
  if (!isManagedHookCommand(command)) return false;
  return isManagedEndStem(String(command));
}
function isManagedStartStem(command) {
  return /\bsession\s+session-start\b/i.test(command);
}
function isManagedEndStem(command) {
  return /\bsession\s+session-end\b/i.test(command);
}
function managedCommandHost(command) {
  if (!command || typeof command !== "string") return null;
  const m = command.match(/--host(?:\s+|=)([^\s"']+)/i);
  return m?.[1] ?? null;
}
function isManagedSessionStartForHost(command, agent) {
  if (!isManagedEnterCommand(command)) return false;
  return managedCommandHost(command) === agent;
}
function isManagedSessionEndForHost(command, agent) {
  if (!isManagedLeaveCommand(command)) return false;
  return managedCommandHost(command) === agent;
}
async function installAgentHooks(options = {}) {
  const agents = resolveAgentHookSelection(options.agents);
  const home = options.home ?? os2.homedir();
  const results = [];
  for (const agent of agents) {
    results.push(await installOne(agent, home, options.tentCommand));
  }
  return { action: "install", results };
}
async function doctorAgentHooks(options = {}) {
  const agents = resolveAgentHookSelection(options.agents);
  const home = options.home ?? os2.homedir();
  const results = [];
  for (const agent of agents) {
    results.push(await doctorOne(agent, home, options.tentCommand));
  }
  return { action: "doctor", results };
}
async function removeAgentHooks(options = {}) {
  const agents = resolveAgentHookSelection(options.agents);
  const home = options.home ?? os2.homedir();
  const results = [];
  for (const agent of agents) {
    results.push(await removeOne(agent, home));
  }
  return { action: "remove", results };
}
async function installOne(agent, home, tentCommand) {
  switch (agent) {
    case "claude":
      return projectClaudeLike({
        agent,
        configPath: claudeSettingsPath(home),
        mode: "install",
        tentCommand,
        wrapRoot: true
      });
    case "codex":
      return projectClaudeLike({
        agent,
        configPath: codexHooksPath(home),
        mode: "install",
        tentCommand,
        wrapRoot: true,
        codexCommandShape: true
      });
    case "copilot":
      return unsupportedResult(
        agent,
        "No verified native SessionStart/Stop (or SessionEnd) lifecycle hook surface for GitHub Copilot CLI; not guessed."
      );
    default: {
      const _exhaustive = agent;
      throw new Error(`Unknown agent: ${String(_exhaustive)}`);
    }
  }
}
async function doctorOne(agent, home, tentCommand) {
  switch (agent) {
    case "claude":
      return projectClaudeLike({
        agent,
        configPath: claudeSettingsPath(home),
        mode: "doctor",
        tentCommand,
        wrapRoot: true
      });
    case "codex":
      return projectClaudeLike({
        agent,
        configPath: codexHooksPath(home),
        mode: "doctor",
        tentCommand,
        wrapRoot: true,
        codexCommandShape: true
      });
    case "copilot":
      return unsupportedResult(
        agent,
        "No verified native SessionStart/Stop (or SessionEnd) lifecycle hook surface for GitHub Copilot CLI; not guessed."
      );
    default: {
      const _exhaustive = agent;
      throw new Error(`Unknown agent: ${String(_exhaustive)}`);
    }
  }
}
async function removeOne(agent, home) {
  switch (agent) {
    case "claude":
      return projectClaudeLike({
        agent,
        configPath: claudeSettingsPath(home),
        mode: "remove",
        wrapRoot: true
      });
    case "codex":
      return projectClaudeLike({
        agent,
        configPath: codexHooksPath(home),
        mode: "remove",
        wrapRoot: true,
        codexCommandShape: true
      });
    case "copilot":
      return unsupportedResult(
        agent,
        "No verified native SessionStart/Stop (or SessionEnd) lifecycle hook surface for GitHub Copilot CLI; not guessed."
      );
    default: {
      const _exhaustive = agent;
      throw new Error(`Unknown agent: ${String(_exhaustive)}`);
    }
  }
}
function unsupportedResult(agent, reason) {
  return {
    agent,
    support: "unsupported",
    status: "unsupported",
    reason
  };
}
async function projectClaudeLike(options) {
  const { agent, configPath, mode, tentCommand, wrapRoot, codexCommandShape } = options;
  const enterCmd = managedSessionStartCommand(agent, tentCommand);
  const leaveCmd = managedSessionEndCommand(agent, tentCommand);
  const matchEnter = (cmd) => isManagedSessionStartForHost(cmd, agent);
  const matchLeave = (cmd) => isManagedSessionEndForHost(cmd, agent);
  let root = {};
  let existed = false;
  try {
    const raw = await fs4.readFile(configPath, "utf8");
    existed = true;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        agent,
        support: "lifecycle",
        status: "error",
        path: configPath,
        reason: `Config is not a JSON object: ${configPath}`
      };
    }
    root = parsed;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : void 0;
    if (code === "ENOENT") {
      root = {};
      existed = false;
    } else if (err instanceof SyntaxError) {
      return {
        agent,
        support: "lifecycle",
        status: "error",
        path: configPath,
        reason: `Invalid JSON in ${configPath}: ${err.message}`
      };
    } else {
      throw err;
    }
  }
  const nextRoot = { ...root };
  const hooksBag = wrapRoot ? asObject(nextRoot.hooks) : nextRoot;
  const hooks = wrapRoot ? { ...hooksBag } : { ...hooksBag };
  const presentBefore = detectManagedEvents(hooks, agent);
  if (mode === "doctor") {
    return doctorFromPresent(agent, configPath, presentBefore, existed);
  }
  if (mode === "remove") {
    const changed = removeManagedFromHooks(hooks);
    if (!changed && presentBefore.length === 0) {
      return {
        agent,
        support: "lifecycle",
        status: "skipped",
        path: configPath,
        reason: existed ? "no managed hooks present" : "config file absent",
        present: [],
        missing: ["SessionStart", "Stop"]
      };
    }
    await writeHooksRoot(configPath, nextRoot, hooks, wrapRoot, root);
    return {
      agent,
      support: "lifecycle",
      status: "removed",
      path: configPath,
      present: [],
      missing: ["SessionStart", "Stop"]
    };
  }
  const enterHandler = buildCommandHandler(enterCmd, codexCommandShape === true);
  const leaveHandler = buildCommandHandler(leaveCmd, codexCommandShape === true);
  const addedEnter = ensureManagedEvent(hooks, "SessionStart", enterHandler, matchEnter);
  const addedLeave = ensureManagedEvent(hooks, "Stop", leaveHandler, matchLeave);
  const normalizedCodexHandlers = codexCommandShape ? normalizeCodexManagedHandlers(hooks, agent) : false;
  const presentAfter = detectManagedEvents(hooks, agent);
  if (!addedEnter && !addedLeave && !normalizedCodexHandlers && presentAfter.length === 2) {
    return {
      agent,
      support: "lifecycle",
      status: "skipped",
      path: configPath,
      reason: "managed hooks already present",
      present: presentAfter,
      missing: missingEvents(presentAfter)
    };
  }
  await writeHooksRoot(configPath, nextRoot, hooks, wrapRoot, root);
  return {
    agent,
    support: "lifecycle",
    status: "installed",
    path: configPath,
    present: presentAfter,
    missing: missingEvents(presentAfter)
  };
}
function normalizeCodexManagedHandlers(hooks, agent) {
  let changed = false;
  const matches = {
    SessionStart: (command) => isManagedSessionStartForHost(command, agent),
    Stop: (command) => isManagedSessionEndForHost(command, agent)
  };
  for (const event of ["SessionStart", "Stop"]) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    hooks[event] = groups.map((group) => {
      if (!group || typeof group !== "object" || Array.isArray(group)) return group;
      const nextGroup = { ...group };
      if (!Array.isArray(nextGroup.hooks)) return nextGroup;
      nextGroup.hooks = nextGroup.hooks.map((handler) => {
        if (!handler || typeof handler !== "object" || Array.isArray(handler)) return handler;
        const nextHandler = { ...handler };
        const command = typeof nextHandler.command === "string" ? nextHandler.command : null;
        if (!matches[event](command)) return handler;
        if ("async" in nextHandler) {
          delete nextHandler.async;
          changed = true;
        }
        if (nextHandler.timeout !== 60) {
          nextHandler.timeout = 60;
          changed = true;
        }
        if (nextHandler.statusMessage !== TENT_HOOK_MARKER) {
          nextHandler.statusMessage = TENT_HOOK_MARKER;
          changed = true;
        }
        return nextHandler;
      });
      return nextGroup;
    });
  }
  return changed;
}
function doctorFromPresent(agent, configPath, present, existed) {
  const missing = missingEvents(present);
  if (present.length === 2) {
    return {
      agent,
      support: "lifecycle",
      status: "ok",
      path: configPath,
      present,
      missing: []
    };
  }
  if (present.length === 0) {
    return {
      agent,
      support: "lifecycle",
      status: "missing",
      path: configPath,
      reason: existed ? "managed hooks not found" : "config file absent",
      present: [],
      missing
    };
  }
  return {
    agent,
    support: "lifecycle",
    status: "partial",
    path: configPath,
    reason: `present=${present.join(",")} missing=${missing.join(",")}`,
    present,
    missing
  };
}
async function writeHooksRoot(configPath, nextRoot, hooks, wrapRoot, previousRoot) {
  pruneEmptyHookEvents(hooks);
  let toWrite;
  if (wrapRoot) {
    toWrite = { ...nextRoot };
    if (Object.keys(hooks).length === 0) {
      if ("hooks" in toWrite) delete toWrite.hooks;
    } else {
      toWrite.hooks = hooks;
    }
  } else {
    toWrite = hooks;
  }
  if (!wrapRoot && Object.keys(toWrite).length === 0) {
    try {
      await fs4.unlink(configPath);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? err.code : void 0;
      if (code !== "ENOENT") throw err;
    }
    return;
  }
  void previousRoot;
  await fs4.mkdir(path2.dirname(configPath), { recursive: true });
  const body = `${JSON.stringify(toWrite, null, 2)}
`;
  await fs4.writeFile(configPath, body, "utf8");
}
function detectManagedEvents(hooks, agent) {
  const present = [];
  if (eventHasManaged(hooks, "SessionStart", (c) => isManagedSessionStartForHost(c, agent))) {
    present.push("SessionStart");
  }
  if (eventHasManaged(hooks, "Stop", (c) => isManagedSessionEndForHost(c, agent))) {
    present.push("Stop");
  }
  return present;
}
function missingEvents(present) {
  const set = new Set(present);
  const out = [];
  if (!set.has("SessionStart")) out.push("SessionStart");
  if (!set.has("Stop")) out.push("Stop");
  return out;
}
function eventHasManaged(hooks, event, match) {
  const groups = hooks[event];
  if (!Array.isArray(groups)) return false;
  for (const group of groups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    const handlers = group.hooks;
    if (!Array.isArray(handlers)) continue;
    for (const h of handlers) {
      if (!h || typeof h !== "object" || Array.isArray(h)) continue;
      const cmd = h.command;
      if (typeof cmd === "string" && match(cmd)) return true;
    }
  }
  return false;
}
function ensureManagedEvent(hooks, event, handler, match) {
  if (eventHasManaged(hooks, event, match)) return false;
  const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
  let placed = false;
  const nextGroups = groups.map((group) => {
    if (placed) return group;
    if (!group || typeof group !== "object" || Array.isArray(group)) return group;
    const g = { ...group };
    const handlers = Array.isArray(g.hooks) ? [...g.hooks] : [];
    handlers.push(handler);
    g.hooks = handlers;
    placed = true;
    return g;
  });
  if (!placed) {
    nextGroups.push({ hooks: [handler] });
  }
  hooks[event] = nextGroups;
  return true;
}
function removeManagedFromHooks(hooks) {
  let changed = false;
  for (const event of ["SessionStart", "Stop"]) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const nextGroups = [];
    for (const group of groups) {
      if (!group || typeof group !== "object" || Array.isArray(group)) {
        nextGroups.push(group);
        continue;
      }
      const g = { ...group };
      const handlers = Array.isArray(g.hooks) ? g.hooks : [];
      const kept = handlers.filter((h) => {
        if (!h || typeof h !== "object" || Array.isArray(h)) return true;
        const cmd = h.command;
        if (typeof cmd === "string" && isManagedHookCommand(cmd)) {
          changed = true;
          return false;
        }
        return true;
      });
      if (kept.length === 0) {
        if (handlers.length > 0) {
          continue;
        }
        nextGroups.push(g);
        continue;
      }
      g.hooks = kept;
      nextGroups.push(g);
    }
    if (nextGroups.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = nextGroups;
    }
  }
  return changed;
}
function pruneEmptyHookEvents(hooks) {
  for (const key of Object.keys(hooks)) {
    const val = hooks[key];
    if (Array.isArray(val) && val.length === 0) {
      delete hooks[key];
    }
  }
}
function buildCommandHandler(command, codexShape) {
  if (codexShape) {
    return {
      type: "command",
      command,
      timeout: 60,
      statusMessage: TENT_HOOK_MARKER
    };
  }
  return {
    type: "command",
    command,
    // timeout generous enough for Local Service attach; not a permission field.
    timeout: 60
  };
}
function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}
function quoteIfNeeded(command) {
  if (!/[\s"]/.test(command)) return command;
  if (command.includes('"')) return command;
  return `"${command}"`;
}
function formatAgentHooksResults(batch) {
  const lines = [`\u2713 agent-hooks ${batch.action}`];
  for (const r of batch.results) {
    const bits = [`  - ${r.agent}: ${r.status}`];
    if (r.path) bits.push(`path=${r.path}`);
    if (r.present && r.present.length > 0) bits.push(`present=${r.present.join(",")}`);
    if (r.missing && r.missing.length > 0) bits.push(`missing=${r.missing.join(",")}`);
    if (r.reason) bits.push(`(${r.reason})`);
    lines.push(bits.join(" "));
  }
  return lines.join("\n");
}

// src/core/frontmatter.ts
var FENCE = "---";
var NODE_FRONTMATTER_KEY_ORDER = ["id", "type", "tags", "mode", "relations"];
function parseFrontmatter(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith(FENCE + "\n")) {
    return { data: {}, body: raw, keyOrder: [] };
  }
  const end = text.indexOf("\n" + FENCE, FENCE.length);
  if (end === -1) {
    return { data: {}, body: raw, keyOrder: [] };
  }
  const fmBlock = text.slice(FENCE.length + 1, end);
  const afterFence = text.indexOf("\n", end + 1);
  const body = afterFence === -1 ? "" : text.slice(afterFence + 1);
  const data = {};
  const keyOrder = [];
  const lines = fmBlock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^-\s*/.test(trimmed)) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let valuePart = trimmed.slice(colon + 1).trim();
    valuePart = stripInlineComment(valuePart);
    if ((valuePart.startsWith("{") || valuePart.startsWith("[")) && !flowCollectionCloses(valuePart)) {
      const recovered = readLegacyMultilineFlowCollection(lines, i, valuePart);
      valuePart = recovered.value;
      i = recovered.nextIndex;
    }
    if (valuePart === "" && isBlockSequenceStart(lines[i + 1])) {
      const { value, nextIndex } = readBlockSequence(lines, i + 1, key);
      data[key] = normalizeValueForKey(key, value);
      i = nextIndex - 1;
    } else {
      data[key] = normalizeValueForKey(key, coerceForKey(key, valuePart));
    }
    keyOrder.push(key);
  }
  return { data, body, keyOrder };
}
function stripInlineComment(v) {
  if (v.startsWith('"') || v.startsWith("'")) return v;
  const hash = v.indexOf(" #");
  return hash === -1 ? v : v.slice(0, hash).trim();
}
function scanFlowCollection(text, initial) {
  const state = initial ?? { stack: [], quote: null, invalid: false };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state.quote) {
      if (ch === "\\" && state.quote === '"' && i + 1 < text.length) {
        i += 1;
        continue;
      }
      if (ch === state.quote) state.quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      state.quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      state.stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      const expected = ch === "}" ? "{" : "[";
      if (state.stack.pop() !== expected) {
        state.invalid = true;
        return state;
      }
    }
  }
  return state;
}
function flowCollectionCloses(value) {
  const state = scanFlowCollection(value);
  return !state.invalid && state.quote === null && state.stack.length === 0;
}
function readLegacyMultilineFlowCollection(lines, startIndex, initialValue) {
  let value = initialValue;
  let state = scanFlowCollection(initialValue);
  if (state.invalid) {
    throw new Error("Invalid frontmatter YAML: malformed multiline flow collection.");
  }
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (/^[A-Za-z_][\w-]*\s*:/.test(lines[i])) {
      throw new Error("Invalid frontmatter YAML: unterminated multiline flow collection.");
    }
    const continuation = `
${lines[i]}`;
    value += continuation;
    state = scanFlowCollection(continuation, state);
    if (state.invalid) {
      throw new Error("Invalid frontmatter YAML: malformed multiline flow collection.");
    }
    if (state.quote === null && state.stack.length === 0) {
      return { value, nextIndex: i };
    }
  }
  throw new Error("Invalid frontmatter YAML: unterminated multiline flow collection.");
}
function coerce(v) {
  if (v === "") return void 0;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  if (v.startsWith('"') && !v.endsWith('"')) {
    throw new Error("Invalid frontmatter YAML: unterminated double-quoted string.");
  }
  if (v.startsWith('"') && v.endsWith('"')) {
    return parseDoubleQuoted(v);
  }
  if (v.startsWith("'") && !v.endsWith("'")) {
    throw new Error("Invalid frontmatter YAML: unterminated single-quoted string.");
  }
  if (v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith("{")) {
    if (!v.endsWith("}")) {
      throw new Error("Invalid frontmatter YAML: unterminated flow mapping.");
    }
    return parseFlowMapping(v);
  }
  if (v.startsWith("[") && !v.endsWith("]")) {
    throw new Error("Invalid frontmatter YAML: unterminated flow array.");
  }
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowCollection(inner).map((item) => coerce(item.trim()));
  }
  return v;
}
function isBlockSequenceStart(line) {
  return line !== void 0 && /^\s*-\s*/.test(line);
}
function leadingIndent(line) {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}
function readBlockSequence(lines, startIndex, key) {
  const value = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    const itemMatch = line.match(/^(\s*)-\s*(.*)$/);
    if (!itemMatch) break;
    const itemIndent = itemMatch[1].length;
    const rest = stripInlineComment(itemMatch[2].trim());
    i += 1;
    const inlineMap = rest.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (inlineMap && !(rest.startsWith("{") || rest.startsWith("["))) {
      const obj = {};
      const firstKey = inlineMap[1];
      const firstVal = stripInlineComment(inlineMap[2].trim());
      obj[firstKey] = firstVal === "" ? void 0 : coerceForKey(key, firstVal);
      while (i < lines.length) {
        const cont = lines[i];
        if (!cont.trim() || cont.trim().startsWith("#")) {
          i += 1;
          continue;
        }
        if (leadingIndent(cont) <= itemIndent) break;
        if (/^\s*-\s*/.test(cont)) break;
        const trimmed = cont.trim();
        const colon = trimmed.indexOf(":");
        if (colon === -1) break;
        const fieldKey = trimmed.slice(0, colon).trim();
        const fieldVal = stripInlineComment(trimmed.slice(colon + 1).trim());
        obj[fieldKey] = fieldVal === "" ? void 0 : coerceForKey(key, fieldVal);
        i += 1;
      }
      for (const k of Object.keys(obj)) {
        if (obj[k] === void 0) delete obj[k];
      }
      value.push(obj);
      continue;
    }
    value.push(rest === "" ? null : coerceForKey(key, rest));
  }
  return { value, nextIndex: i };
}
function parseFlowMapping(raw) {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return {};
  const parts = splitFlowCollection(inner);
  const out = {};
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = findTopLevelColon(trimmed);
    if (colon === -1) {
      throw new Error(`Invalid frontmatter YAML: flow mapping entry missing colon: ${trimmed}`);
    }
    const k = trimmed.slice(0, colon).trim();
    const v = trimmed.slice(colon + 1).trim();
    if (!k) throw new Error("Invalid frontmatter YAML: empty flow mapping key.");
    out[k] = v === "" ? null : coerce(v);
  }
  return out;
}
function findTopLevelColon(s) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === ":" && depth === 0) return i;
  }
  return -1;
}
function splitFlowCollection(inner) {
  const items = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < inner.length) {
        current += inner[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items;
}
function coerceForKey(key, raw) {
  if (key !== "commits") return coerce(raw);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowCollection(inner).map((item) => coerceCommitItem(item.trim()));
  }
  return coerceCommitItem(raw);
}
function coerceCommitItem(raw) {
  return /^\d+$/.test(raw) ? raw : coerce(raw);
}
function parseDoubleQuoted(v) {
  try {
    return JSON.parse(v);
  } catch {
    return unescapeYamlDoubleQuoted(v.slice(1, -1));
  }
}
function unescapeYamlDoubleQuoted(value) {
  const escapes = {
    "0": "\0",
    a: "\x07",
    b: "\b",
    t: "	",
    n: "\n",
    v: "\v",
    f: "\f",
    r: "\r",
    e: "\x1B",
    '"': '"',
    "/": "/",
    "\\": "\\"
  };
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "\\" || i === value.length - 1) {
      out += ch;
      continue;
    }
    const next = value[++i];
    out += escapes[next] ?? `\\${next}`;
  }
  return out;
}
function normalizeValueForKey(key, value) {
  if (key === "workspace" || key === "path" || key === "ref") {
    return normalizeWindowsPathValue(value);
  }
  if (key === "paths" && Array.isArray(value)) {
    return value.map((item) => normalizeWindowsPathValue(item));
  }
  return value;
}
function normalizeWindowsPathValue(value) {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/.test(value)) return value;
  return value.replace(/\\{2,}/g, "\\");
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function serializeFrontmatter(data, body, keyOrder = []) {
  const keys = orderedKeys(data, keyOrder);
  const lines = [FENCE];
  for (const k of keys) {
    const val = data[k];
    if (val === void 0) continue;
    if (Array.isArray(val) && val.some(isPlainObject)) {
      lines.push(`${k}:`);
      if (val.length === 0) {
        lines[lines.length - 1] = `${k}: []`;
      } else {
        for (const item of val) {
          lines.push(`  - ${emit(item)}`);
        }
      }
      continue;
    }
    lines.push(`${k}: ${emit(val)}`);
  }
  lines.push(FENCE);
  const out = lines.join("\n");
  return body ? out + "\n" + body : out + "\n";
}
function orderedKeys(data, keyOrder) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const k of keyOrder) {
    if (k in data && !seen.has(k)) {
      result.push(k);
      seen.add(k);
    }
  }
  for (const k of Object.keys(data)) {
    if (!seen.has(k)) {
      result.push(k);
      seen.add(k);
    }
  }
  return result;
}
function emit(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return "[" + v.map((item) => emit(item)).join(", ") + "]";
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== void 0);
    if (keys.length === 0) return "{}";
    return "{" + keys.map((k) => `${k}: ${emit(v[k])}`).join(", ") + "}";
  }
  const s = String(v);
  if (/^-?(?:\d+|\d*\.\d+)$/.test(s) || /[:,#\[\]{}]/.test(s) || /[\u0000-\u001f\u007f-\u009f]/.test(s) || s !== s.trim() || s === "") {
    return JSON.stringify(s);
  }
  return s;
}

// src/core/registryRecovery.ts
async function backupCorruptRegistry(fs10, path11) {
  const backupPath = `${path11}.corrupt-${timestamp()}`;
  await fs10.writeFile(backupPath, await fs10.readFile(path11));
  return backupPath;
}
function warnRegistryRecovered(path11, backupPath, action, extra = "") {
  console.error(
    `WARNING: ${path11} was corrupt; backed up to ${backupPath} and ${action}. Review it.${extra ? ` ${extra}` : ""}`
  );
}
function timestamp() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
}

// src/core/paths.ts
var TENT_SYSTEM_DIR = ".tent";
var TYPE_REGISTRY_PATH = "types.json";
var ROLES_REGISTRY_PATH = "roles.json";
var TAGS_REGISTRY_PATH = "tags.json";
var ORDER_PATH = "order.json";
var MUTATION_LOCK_PATH = "mutation.lock";
var INDEX_PATH = "index.md";
var WORKSPACE_SETTINGS_PATH = "settings.json";
var ANNOTATIONS_PATH = "annotations.json";
var TEMP_DIR = "temp";
var ATTACHMENTS_DIR = "attachments";
var ROLES_TEMP_DIR = "roles";
var SESSIONS_TEMP_DIR = "sessions";
function nodeNotePath(nodePath3) {
  const separator = nodePath3.lastIndexOf("/");
  const name = separator === -1 ? nodePath3 : nodePath3.slice(separator + 1);
  return nodePath3 === "" ? ".md" : `${nodePath3}/${name}.md`;
}
var OPERATIONAL_TOP_LEVEL = /* @__PURE__ */ new Set([
  TEMP_DIR,
  ATTACHMENTS_DIR,
  // 若仍见嵌套 .tent，视为系统区而非 Node。
  TENT_SYSTEM_DIR
]);
var SYSTEM_REGISTRY_FILES = /* @__PURE__ */ new Set([
  TYPE_REGISTRY_PATH,
  ROLES_REGISTRY_PATH,
  TAGS_REGISTRY_PATH,
  ORDER_PATH,
  MUTATION_LOCK_PATH,
  WORKSPACE_SETTINGS_PATH,
  ANNOTATIONS_PATH,
  INDEX_PATH,
  "log.md"
]);
function workspaceRootFromSystemRoot(systemRoot) {
  const normalized = systemRoot.replace(/[\\/]+$/, "");
  const base = normalized.split(/[\\/]/).pop() ?? "";
  if (base !== TENT_SYSTEM_DIR) return void 0;
  const parent = normalized.replace(/[\\/]+[^\\/]+$/, "");
  return parent || void 0;
}
function isOperationalPath(relativePath) {
  const path11 = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!path11) return false;
  const top = path11.split("/")[0] ?? "";
  return OPERATIONAL_TOP_LEVEL.has(top);
}
function isSystemNoteName(fileName) {
  return SYSTEM_REGISTRY_FILES.has(fileName) || fileName === "MIGRATED.md";
}

// src/core/order.ts
var ROOT_KEY = "__root__";
async function loadOrder(fs10) {
  if (!await fs10.exists(ORDER_PATH)) return {};
  try {
    return JSON.parse(await fs10.readFile(ORDER_PATH));
  } catch {
    const backupPath = await backupCorruptRegistry(fs10, ORDER_PATH);
    await saveOrder(fs10, {});
    warnRegistryRecovered(ORDER_PATH, backupPath, "recovered");
    return {};
  }
}
async function saveOrder(fs10, map) {
  await fs10.writeFile(ORDER_PATH, JSON.stringify(map, null, 2) + "\n");
}
function sortByOrder(items, order, fallback) {
  const sorted = [...items];
  if (!order || order.length === 0) {
    sorted.sort(fallback);
    return sorted;
  }
  const idx = new Map(order.map((id, i) => [id, i]));
  sorted.sort((a, b) => {
    const ai = idx.has(a.id) ? idx.get(a.id) : Infinity;
    const bi = idx.has(b.id) ? idx.get(b.id) : Infinity;
    if (ai !== bi) return ai - bi;
    return fallback(a, b);
  });
  return sorted;
}

// src/core/typeRegistry.ts
var CANONICAL_PRIMARY_TYPES = ["goal", "prompt", "output"];
var BUILTIN_SECONDARY_TYPES = ["reference", "asset"];
var DEFAULT_TYPE_REGISTRY = {
  goal: { tier: "base" },
  prompt: { tier: "base" },
  output: { tier: "base" },
  reference: { tier: "modifier" },
  asset: { tier: "modifier" }
};
function splitType(type) {
  const i = type.indexOf("-");
  if (i === -1) return { base: type };
  return { base: type.slice(0, i), modifier: type.slice(i + 1) };
}
function isCanonicalPrimary(name) {
  return CANONICAL_PRIMARY_TYPES.includes(name);
}
function isBuiltinSecondary(name) {
  return BUILTIN_SECONDARY_TYPES.includes(name);
}
function typeExists(type, registry) {
  const trimmed = type.trim();
  if (!trimmed) return false;
  const { base, modifier } = splitType(trimmed);
  if (!isCanonicalPrimary(base)) return false;
  if (!registry[base] || (registry[base].tier ?? "base") === "modifier") return false;
  if (modifier !== void 0 && modifier.length === 0) return false;
  return true;
}
function isValidNodeType(type, registry) {
  const trimmed = type.trim();
  if (!trimmed) return false;
  const { base, modifier } = splitType(trimmed);
  if (!isCanonicalPrimary(base)) return false;
  if (!registry[base] || (registry[base].tier ?? "base") === "modifier") return false;
  if (modifier === void 0) return true;
  if (modifier.length === 0) return false;
  const mod = registry[modifier];
  return !!mod && mod.tier === "modifier";
}
function assertValidNodeType(type, registry) {
  const trimmed = typeof type === "string" ? type.trim() : "";
  if (!trimmed) throw new Error("Primary type cannot be cleared.");
  if (isValidNodeType(trimmed, registry)) return;
  const { base, modifier } = splitType(trimmed);
  if (!isCanonicalPrimary(base)) {
    throw new Error(
      `Invalid node type: ${trimmed}. Node type must be goal|prompt|output or goal|prompt|output-<marker>; bare markers are not valid node types.`
    );
  }
  if (modifier !== void 0) {
    if (modifier.length === 0) {
      throw new Error(`Invalid node type: ${trimmed}. Empty marker is not allowed.`);
    }
    throw new Error(
      `Unknown type marker: ${modifier} (in ${trimmed}). Register the marker before writing.`
    );
  }
  throw new Error(`Unknown type: ${trimmed}.`);
}
async function loadTypeRegistry(fs10) {
  if (!await fs10.exists(TYPE_REGISTRY_PATH)) return cloneDefaults();
  try {
    const parsed = JSON.parse(await fs10.readFile(TYPE_REGISTRY_PATH));
    return normalizeRegistry(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`types.json is corrupt: ${detail}.`);
  }
}
function normalizeRegistry(value) {
  if (!isRecord(value)) {
    throw new Error("types.json root must be an object.");
  }
  const root = value;
  if (Object.prototype.hasOwnProperty.call(root, "primary") || Object.prototype.hasOwnProperty.call(root, "secondary")) {
    throw new Error("Legacy primary/secondary type registry buckets are not supported.");
  }
  const registry = cloneDefaults();
  mergeDefinitions(registry, root);
  finalizeRegistry(registry);
  return registry;
}
function mergeDefinitions(registry, source) {
  if (!isRecord(source)) return;
  for (const [name, raw] of Object.entries(source)) {
    if (!name.trim() || name === "temp" || !isRecord(raw)) continue;
    const tier = raw.tier === "base" || raw.tier === "modifier" ? raw.tier : registry[name]?.tier ?? (isCanonicalPrimary(name) ? "base" : "modifier");
    if (isCanonicalPrimary(name)) {
      registry[name] = { tier: "base" };
      continue;
    }
    if (isBuiltinSecondary(name)) {
      registry[name] = { tier: "modifier" };
      continue;
    }
    if (tier === "base") continue;
    registry[name] = { tier: "modifier" };
  }
}
function finalizeRegistry(registry) {
  for (const p of CANONICAL_PRIMARY_TYPES) {
    registry[p] = { tier: "base" };
  }
  for (const s of BUILTIN_SECONDARY_TYPES) {
    registry[s] = { tier: "modifier" };
  }
  delete registry.note;
  delete registry.artifact;
  delete registry.open;
  delete registry.sealed;
}
function cloneDefaults() {
  return Object.fromEntries(
    Object.entries(DEFAULT_TYPE_REGISTRY).map(([name, def]) => [name, { ...def }])
  );
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/core/adapter.ts
function withTentMutation(fs10, action) {
  return fs10.withLock ? fs10.withLock(MUTATION_LOCK_PATH, action) : action();
}

// src/core/relations.ts
var RELATION_ID_PREFIX = "rl-";
var RelationError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "RelationError";
  }
};
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRelationId(id) {
  return id.startsWith(RELATION_ID_PREFIX) && id.length > RELATION_ID_PREFIX.length;
}
function normalizeRelationTarget(raw) {
  if (!isRecord2(raw)) {
    throw new RelationError("INVALID_INPUT", "relation target must be an object");
  }
  const hasNodeId = Object.prototype.hasOwnProperty.call(raw, "nodeId");
  const hasUnresolved = Object.prototype.hasOwnProperty.call(raw, "unresolved");
  if (hasNodeId && hasUnresolved) {
    throw new RelationError(
      "INVALID_INPUT",
      "relation target must be exactly one of { nodeId } or { unresolved }"
    );
  }
  if (hasNodeId) {
    if (typeof raw.nodeId !== "string" || !raw.nodeId.trim()) {
      throw new RelationError("INVALID_INPUT", "relation target.nodeId must be a non-empty string");
    }
    return { nodeId: raw.nodeId.trim() };
  }
  if (hasUnresolved) {
    if (typeof raw.unresolved !== "string" || !raw.unresolved.trim()) {
      throw new RelationError(
        "INVALID_INPUT",
        "relation target.unresolved must be a non-empty string"
      );
    }
    return { unresolved: raw.unresolved.trim() };
  }
  throw new RelationError(
    "INVALID_INPUT",
    "relation target must be exactly one of { nodeId } or { unresolved }"
  );
}
function normalizeRelationDirection(raw) {
  if (raw === "directed" || raw === "bidirectional") return raw;
  throw new RelationError(
    "INVALID_INPUT",
    'relation direction must be "directed" or "bidirectional"'
  );
}
function normalizeRelationKind(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new RelationError("INVALID_INPUT", "relation kind must be a non-empty string");
  }
  const kind = raw.trim();
  if (/[\r\n]/.test(kind)) {
    throw new RelationError("INVALID_INPUT", "relation kind cannot contain newlines");
  }
  return kind;
}
function normalizeRelationLabel(raw) {
  if (raw === void 0 || raw === null) return void 0;
  if (typeof raw !== "string") {
    throw new RelationError("INVALID_INPUT", "relation label must be a string when present");
  }
  const label = raw.trim();
  return label.length > 0 ? label : void 0;
}
function parseRelationRecord(raw) {
  if (!isRecord2(raw)) return null;
  if (typeof raw.id !== "string" || !isRelationId(raw.id)) return null;
  let kind;
  let direction;
  let target;
  let label;
  try {
    kind = normalizeRelationKind(raw.kind);
    direction = normalizeRelationDirection(raw.direction);
    label = normalizeRelationLabel(raw.label);
    if (isRecord2(raw.target)) {
      target = normalizeRelationTarget(raw.target);
    } else if (Object.prototype.hasOwnProperty.call(raw, "nodeId") || Object.prototype.hasOwnProperty.call(raw, "unresolved")) {
      target = normalizeRelationTarget({
        ...Object.prototype.hasOwnProperty.call(raw, "nodeId") ? { nodeId: raw.nodeId } : {},
        ...Object.prototype.hasOwnProperty.call(raw, "unresolved") ? { unresolved: raw.unresolved } : {}
      });
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const out = { id: raw.id, kind, direction, target };
  if (label !== void 0) out.label = label;
  return out;
}
function normalizeRelationsList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of value) {
    const parsed = parseRelationRecord(item);
    if (!parsed) continue;
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out;
}
function relationToFrontmatterItem(record) {
  const item = {
    id: record.id,
    kind: record.kind,
    direction: record.direction
  };
  if (record.label !== void 0) item.label = record.label;
  if ("nodeId" in record.target) item.nodeId = record.target.nodeId;
  else item.unresolved = record.target.unresolved;
  return item;
}
function relationsToFrontmatterValue(records) {
  if (records.length === 0) return void 0;
  return records.map(relationToFrontmatterItem);
}

// src/core/id.ts
var ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
var NODE_ID_PREFIX = "cx-";
var ROLE_ID_PREFIX = "rl-";
function deterministicDigest(input, byteLen = 32) {
  const out = new Uint8Array(byteLen);
  for (let offset = 0; offset < byteLen; offset += 4) {
    let h = (2166136261 ^ Math.imul(offset + 1, 2654435769)) >>> 0;
    const salted = `${offset}\0${input}`;
    for (let i = 0; i < salted.length; i++) {
      h ^= salted.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= h >>> 16;
    h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 3266489909) >>> 0;
    h ^= h >>> 16;
    out[offset] = h & 255;
    if (offset + 1 < byteLen) out[offset + 1] = h >>> 8 & 255;
    if (offset + 2 < byteLen) out[offset + 2] = h >>> 16 & 255;
    if (offset + 3 < byteLen) out[offset + 3] = h >>> 24 & 255;
  }
  return out;
}
function encodeAlphabetBytes(bytes, len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    const b = bytes[i % bytes.length] ^ i * 17 & 255;
    s += ALPHABET[b % ALPHABET.length];
  }
  return s;
}
function makePrefixedId(prefix, rand = Math.random, len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return prefix + s;
}
function makeUniquePrefixedId(prefix, existing, rand = Math.random) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = makePrefixedId(prefix, rand);
    if (!existing.has(id)) return id;
  }
  return makePrefixedId(prefix, rand, 10);
}
function makeUniqueNodeId(existing, rand = Math.random) {
  return makeUniquePrefixedId(NODE_ID_PREFIX, existing, rand);
}
function makeUniqueRoleId(existing, rand = Math.random) {
  return makeUniquePrefixedId(ROLE_ID_PREFIX, existing, rand);
}
function deterministicRoleIdFromName(name, existing = /* @__PURE__ */ new Set()) {
  const key = name.trim();
  const digest = deterministicDigest(`tent.role.id.v1:${key}`, 32);
  for (let len = 6; len <= 16; len++) {
    const id = ROLE_ID_PREFIX + encodeAlphabetBytes(digest, len);
    if (!existing.has(id)) return id;
  }
  const fallback = deterministicDigest(
    `tent.role.id.v1.fallback:${key}:${[...existing].sort().join(",")}`,
    32
  );
  return ROLE_ID_PREFIX + encodeAlphabetBytes(fallback, 12);
}
function isNodeId(id) {
  return /^cx-[a-z0-9]+$/i.test(id);
}
function isRoleId(id) {
  return /^rl-[a-z0-9]+$/i.test(id);
}
function isSessionId(id) {
  return /^ss-[a-z0-9]+$/i.test(id);
}

// src/core/etag.ts
import { createHash } from "node:crypto";
function contentEtag(content) {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 24);
}

// src/core/tree.ts
async function loadTent(fs10) {
  const byId = /* @__PURE__ */ new Map();
  const byPath = /* @__PURE__ */ new Map();
  const roots = [];
  const typeRegistry = await loadTypeRegistry(fs10);
  const top = await fs10.listDir("");
  for (const entry2 of top) {
    if (!entry2.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry2.name)) continue;
    if (isSystemNoteName(entry2.name)) continue;
    await loadNodeInto(fs10, entry2.name, null, typeRegistry, roots);
  }
  const order = await loadOrder(fs10);
  const sortedRoots = sortByOrder(roots, order[ROOT_KEY], (a, b) => a.name.localeCompare(b.name));
  for (const root of sortedRoots) sortChildren(root, order);
  for (const root of sortedRoots) resolveSubtree(root, typeRegistry);
  const duplicateIds = findDuplicateIds(sortedRoots);
  for (const root of sortedRoots) applyDuplicateInvalid(root, duplicateIds);
  for (const root of sortedRoots) indexSubtree(root, byId, byPath, duplicateIds);
  return { roots: sortedRoots, byId, byPath, duplicateIds, typeRegistry };
}
function findDuplicateIds(roots) {
  const counts = /* @__PURE__ */ new Map();
  const visit = (node) => {
    if (node.id) counts.set(node.id, (counts.get(node.id) || 0) + 1);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}
function applyDuplicateInvalid(node, duplicateIds, inherited) {
  const direct = duplicateIds.has(node.id) ? { rootId: node.id, reason: `Duplicate id: ${node.id}; native copies must be converted to forks.` } : void 0;
  const invalid = inherited || direct;
  if (invalid) {
    node.invalid = true;
    node.invalidRootId = invalid.rootId;
    node.invalidReason = invalid.reason;
  }
  for (const child of node.children) applyDuplicateInvalid(child, duplicateIds, invalid);
}
function sortChildren(node, order) {
  node.children = sortByOrder(node.children, order[node.id], (a, b) => a.name.localeCompare(b.name));
  for (const c of node.children) sortChildren(c, order);
}
async function loadNode(fs10, path11, parent, registry) {
  if (isOperationalPath(path11)) return null;
  const boxFile = nodeNotePath(path11);
  if (!await fs10.exists(boxFile)) {
    return null;
  }
  const raw = await fs10.readFile(boxFile);
  let parsed;
  let parseError;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
    parsed = { data: {}, body: raw, keyOrder: [] };
  }
  const { data, body } = parsed;
  const name = baseName(path11);
  const schemaError = canonicalIdentityError(data);
  const { fm, tags, relations } = normalizeIdentity(data);
  const node = {
    id: fm.id,
    type: fm.type,
    tags,
    relations,
    mode: "editable",
    archived: false,
    invalid: !!parseError || !!schemaError,
    path: path11,
    name,
    fm,
    etag: contentEtag(raw),
    body,
    children: [],
    parent
  };
  if (parseError || schemaError) {
    node.invalidRootId = path11;
    node.invalidReason = parseError ? `Invalid frontmatter: ${parseError}` : schemaError;
  }
  const sub = await fs10.listDir(path11);
  for (const entry2 of sub) {
    if (!entry2.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry2.name)) continue;
    await loadNodeInto(fs10, join3(path11, entry2.name), node, registry, node.children);
  }
  return node;
}
function canonicalIdentityError(data) {
  if (typeof data.id !== "string" || !isNodeId(data.id)) {
    return `Invalid Node id: ${typeof data.id === "string" && data.id ? data.id : "<missing>"}; canonical Node ids must start with cx-.`;
  }
  if (data.mode !== void 0 && parseNodeMode(data.mode) === void 0) {
    return `Invalid Node mode: ${String(data.mode)}.`;
  }
  return void 0;
}
function normalizeIdentity(data) {
  const rawType = typeof data.type === "string" && data.type ? data.type : "custom";
  const fm = {
    ...data,
    id: typeof data.id === "string" ? data.id : "",
    type: rawType
  };
  const tags = normalizeTags(data.tags);
  if (tags.length > 0) fm.tags = tags;
  else delete fm.tags;
  const mode = parseNodeMode(data.mode);
  if (mode && mode !== "editable") fm.mode = mode;
  else delete fm.mode;
  const relations = normalizeRelationsList(data.relations);
  const fmRelations = relationsToFrontmatterValue(relations);
  if (fmRelations) fm.relations = fmRelations;
  else delete fm.relations;
  return { fm, tags, relations };
}
function parseNodeMode(value) {
  if (value === "archived") return "archived";
  if (value === "editable") return "editable";
  return void 0;
}
function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = item.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}
async function loadNodeInto(fs10, path11, parent, registry, target) {
  if (isOperationalPath(path11)) return;
  const node = await loadNode(fs10, path11, parent, registry);
  if (node) {
    target.push(node);
    return;
  }
  const sub = await fs10.listDir(path11);
  for (const entry2 of sub) {
    if (!entry2.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry2.name)) continue;
    await loadNodeInto(fs10, join3(path11, entry2.name), parent, registry, target);
  }
}
function resolveSubtree(node, registry, inheritedInvalid, inheritedArchived = false) {
  const directInvalid = node.invalid ? { rootId: node.invalidRootId || node.path, reason: node.invalidReason || "Invalid frontmatter." } : invalidTypeReference(node, registry);
  const invalid = inheritedInvalid || directInvalid;
  node.invalid = !!invalid;
  node.invalidRootId = invalid?.rootId;
  node.invalidReason = invalid?.reason;
  const localMode = parseNodeMode(node.fm.mode) ?? "editable";
  node.archived = inheritedArchived || localMode === "archived";
  node.mode = node.archived ? "archived" : "editable";
  if (localMode === "archived" && !inheritedArchived) node.fm.mode = "archived";
  else delete node.fm.mode;
  for (const c of node.children) resolveSubtree(c, registry, invalid, node.archived);
}
function invalidTypeReference(node, registry) {
  if (!isNodeId(node.id)) {
    return {
      rootId: node.path,
      reason: `Invalid Node id: ${node.id || "<missing>"}; canonical Node ids must start with cx-.`
    };
  }
  if (node.fm.mode !== void 0 && parseNodeMode(node.fm.mode) === void 0) {
    return { rootId: node.id, reason: `Invalid Node mode: ${String(node.fm.mode)}.` };
  }
  if (!typeExists(node.type, registry)) {
    return { rootId: node.id, reason: `Unknown type: ${node.type}.` };
  }
  return void 0;
}
function indexSubtree(node, byId, byPath, duplicateIds) {
  if (!node.invalid && isNodeId(node.id) && !duplicateIds.has(node.id)) byId.set(node.id, node);
  byPath.set(node.path, node);
  for (const c of node.children) indexSubtree(c, byId, byPath, duplicateIds);
}
function join3(...parts) {
  return parts.filter((p) => p !== "").join("/");
}
function baseName(path11) {
  const i = path11.lastIndexOf("/");
  return i === -1 ? path11 : path11.slice(i + 1);
}

// src/core/tags.ts
var DEFAULT_TAG_REGISTRY = { tags: [] };
async function loadTagRegistry(fs10) {
  if (!await fs10.exists(TAGS_REGISTRY_PATH)) return { tags: [] };
  try {
    return normalizeRegistry2(JSON.parse(await fs10.readFile(TAGS_REGISTRY_PATH)));
  } catch {
    const backupPath = await backupCorruptRegistry(fs10, TAGS_REGISTRY_PATH);
    const recovered = await recoverTagRegistryFromNodes(fs10);
    await saveTagRegistryUnlocked(fs10, recovered);
    warnRegistryRecovered(TAGS_REGISTRY_PATH, backupPath, "recovered");
    return recovered;
  }
}
async function saveTagRegistryUnlocked(fs10, registry) {
  await fs10.writeFile(TAGS_REGISTRY_PATH, JSON.stringify(normalizeRegistry2(registry), null, 2) + "\n");
}
function findNodesByTag(tent, name) {
  const tag = normalizeTagName(name);
  return [...tent.byId.values()].filter((node) => node.tags.includes(tag)).sort((a, b) => a.path.localeCompare(b.path));
}
function normalizeTagName(name) {
  const tag = name.trim();
  if (!tag) throw new Error("Tag name cannot be empty.");
  if (/[\/\\\r\n]/.test(tag)) throw new Error("Tag name cannot contain path separators or newlines.");
  return tag;
}
function normalizeRegistry2(value) {
  if (!isRecord3(value) || !Array.isArray(value.tags)) return { tags: [] };
  const tags = [];
  for (const valueTag of value.tags) {
    if (typeof valueTag !== "string") continue;
    try {
      tags.push(normalizeTagName(valueTag));
    } catch {
    }
  }
  return { tags: uniqueSorted(tags) };
}
async function recoverTagRegistryFromNodes(fs10) {
  const tent = await loadTent(fs10);
  const tags = [];
  for (const node of tent.byPath.values()) {
    tags.push(...node.tags);
  }
  return { tags: uniqueSorted(tags) };
}
function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/core/artifact.ts
import path3 from "node:path";

// src/core/task-model.ts
var TaskLifecycleError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "TaskLifecycleError";
  }
};
function isTaskActorKind(value) {
  return value === "user" || value === "role";
}
function parseTaskActorRef(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task ${label} must be an object { kind, id }.`
    );
  }
  const raw = value;
  const kind = raw.kind;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!isTaskActorKind(kind)) {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task ${label}.kind must be user|role; got ${String(kind)}.`
    );
  }
  if (!id) {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task ${label}.id must be a non-empty string.`
    );
  }
  if (kind === "user" && id !== "user") {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task ${label} with kind=user requires id "user"; got ${id}.`
    );
  }
  if (kind === "role" && id === "user") {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task ${label} with kind=role must name a durable role (not user).`
    );
  }
  return { kind, id };
}
function assertParentReviewerEqual(parentActor, reviewer) {
  if (parentActor.kind !== reviewer.kind || parentActor.id !== reviewer.id) {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task reviewer must equal parentActor (no arbitrary delegation); got parentActor=${parentActor.kind}:${parentActor.id} reviewer=${reviewer.kind}:${reviewer.id}.`
    );
  }
}
function resolveParentReviewerPair(input) {
  const parentActor = parseTaskActorRef(input.parentActor, "parentActor");
  const reviewer = input.reviewer ? parseTaskActorRef(input.reviewer, "reviewer") : { ...parentActor };
  assertParentReviewerEqual(parentActor, reviewer);
  return { parentActor, reviewer };
}
function isAcceptMode(value) {
  return value === "review-required" || value === "auto-accept" || value === "agent-decide";
}
var ACTIVE_TASK_STATES = /* @__PURE__ */ new Set([
  "queued",
  "running",
  "waiting",
  "delivered"
]);
function isActiveTaskState(state) {
  return ACTIVE_TASK_STATES.has(state);
}
function isTaskId(id) {
  return /^tk-[a-z0-9]+$/i.test(id);
}

// src/core/canonical-digest.ts
import { createHash as createHash2 } from "node:crypto";

// src/core/task-node-selection.ts
var TaskNodeSelectionError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskNodeSelectionError";
  }
};
function normalizeNodeIds(value, field) {
  if (!Array.isArray(value)) {
    throw new TaskNodeSelectionError(`Task ${field} must be an array.`);
  }
  const ids = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of value) {
    if (typeof item !== "string" || item !== item.trim() || item !== item.toLowerCase() || !isNodeId(item)) {
      throw new TaskNodeSelectionError(
        `Task ${field} must contain canonical lowercase cx-* Node ids.`
      );
    }
    if (seen.has(item)) {
      throw new TaskNodeSelectionError(`Task ${field} contains duplicate Node id: ${item}.`);
    }
    seen.add(item);
    ids.push(item);
  }
  return ids;
}
function normalizeTaskNodeSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskNodeSelectionError("Task Node selection must be an object.");
  }
  const record = value;
  const expected = /* @__PURE__ */ new Set(["workNodeIds", "contextNodeIds"]);
  if (Object.keys(record).some((key) => !expected.has(key))) {
    throw new TaskNodeSelectionError("Task Node selection contains unknown fields.");
  }
  const workNodeIds = normalizeNodeIds(record.workNodeIds, "workNodeIds");
  const contextNodeIds = normalizeNodeIds(record.contextNodeIds, "contextNodeIds");
  if (workNodeIds.length === 0) {
    throw new TaskNodeSelectionError("Task workNodeIds requires at least one Node.");
  }
  const work = new Set(workNodeIds);
  const overlap = contextNodeIds.find((id) => work.has(id));
  if (overlap) {
    throw new TaskNodeSelectionError(
      `Task Node cannot be both writable work and read-only context: ${overlap}.`
    );
  }
  return { workNodeIds, contextNodeIds };
}
function orderedTaskNodeIds(selection) {
  const normalized = normalizeTaskNodeSelection(selection);
  return [...normalized.workNodeIds, ...normalized.contextNodeIds];
}

// src/core/task-node-snapshot.ts
var TaskNodeSnapshotError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskNodeSnapshotError";
  }
};
function normalizeNodePath(value) {
  const path11 = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path11 || path11.startsWith("/") || /^[a-zA-Z]:/.test(path11) || path11.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new TaskNodeSnapshotError("Task Node snapshot path must be a canonical relative Node path.");
  }
  return path11;
}
function normalizeTags2(value) {
  if (!Array.isArray(value)) {
    throw new TaskNodeSnapshotError("Task Node snapshot tags must be an array.");
  }
  const tags = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new TaskNodeSnapshotError("Task Node snapshot tags must contain non-empty strings.");
    }
    const tag = item.trim();
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}
function normalizeTaskNodeSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskNodeSnapshotError("Task Node snapshot must be an object.");
  }
  const record = value;
  const expected = /* @__PURE__ */ new Set(["id", "path", "type", "tags", "body", "etag"]);
  if (Object.keys(record).some((key) => !expected.has(key))) {
    throw new TaskNodeSnapshotError("Task Node snapshot contains unknown fields.");
  }
  if (typeof record.id !== "string" || record.id !== record.id.trim() || record.id !== record.id.toLowerCase() || !isNodeId(record.id)) {
    throw new TaskNodeSnapshotError("Task Node snapshot id must be a canonical cx-* Node id.");
  }
  if (typeof record.path !== "string") {
    throw new TaskNodeSnapshotError("Task Node snapshot path must be a string.");
  }
  if (typeof record.type !== "string" || !record.type.trim()) {
    throw new TaskNodeSnapshotError("Task Node snapshot type must be a non-empty string.");
  }
  if (typeof record.body !== "string") {
    throw new TaskNodeSnapshotError("Task Node snapshot body must be a string.");
  }
  if (typeof record.etag !== "string" || !/^[a-f0-9]{24}$/.test(record.etag)) {
    throw new TaskNodeSnapshotError("Task Node snapshot etag must be a canonical content etag.");
  }
  return {
    id: record.id.trim(),
    path: normalizeNodePath(record.path),
    type: record.type.trim(),
    tags: normalizeTags2(record.tags),
    body: record.body,
    etag: record.etag
  };
}
function normalizeTaskNodeSnapshots(value, selection) {
  if (!Array.isArray(value)) {
    throw new TaskNodeSnapshotError("Task Node snapshots must be an array.");
  }
  const snapshots = value.map(normalizeTaskNodeSnapshot);
  const orderedNodeIds = orderedTaskNodeIds(normalizeTaskNodeSelection(selection));
  if (snapshots.length !== orderedNodeIds.length || snapshots.some((snapshot, index) => snapshot.id !== orderedNodeIds[index])) {
    throw new TaskNodeSnapshotError(
      "Task Node snapshots must exactly match the ordered work/context Node refs."
    );
  }
  return snapshots;
}

// src/core/task-node-context.ts
var TaskNodeContextError = class extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "TaskNodeContextError";
    this.cause = cause;
  }
};
function normalizeTaskNodeContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskNodeContextError("Task Node context must be an object.");
  }
  const record = value;
  const expected = /* @__PURE__ */ new Set(["workNodeIds", "contextNodeIds", "nodeSnapshots"]);
  if (Object.keys(record).some((key) => !expected.has(key))) {
    throw new TaskNodeContextError("Task Node context contains unknown fields.");
  }
  try {
    const selection = normalizeTaskNodeSelection({
      workNodeIds: record.workNodeIds,
      contextNodeIds: record.contextNodeIds
    });
    return {
      ...selection,
      nodeSnapshots: normalizeTaskNodeSnapshots(record.nodeSnapshots, selection)
    };
  } catch (error) {
    throw new TaskNodeContextError(
      error instanceof Error ? error.message : "Invalid Task Node context.",
      error
    );
  }
}

// src/core/task-context-card-schema.ts
var TASK_CONTEXT_CARD_SCHEMA_VERSION = "v2";
var TaskContextCardSchemaError = class extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "TaskContextCardSchemaError";
    this.cause = cause;
  }
};
function normalizeTaskContextCard(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskContextCardSchemaError("Task Context Card must be an object.");
  }
  const record = value;
  const expected = /* @__PURE__ */ new Set([
    "schemaVersion",
    "workNodeIds",
    "contextNodeIds",
    "nodeSnapshots",
    "contextGeneration",
    "taskDeltaDigest"
  ]);
  if (Object.keys(record).some((key) => !expected.has(key))) {
    throw new TaskContextCardSchemaError("Task Context Card contains retired or unknown fields.");
  }
  if (record.schemaVersion !== TASK_CONTEXT_CARD_SCHEMA_VERSION) {
    throw new TaskContextCardSchemaError(
      `Task Context Card schemaVersion must be ${TASK_CONTEXT_CARD_SCHEMA_VERSION}.`
    );
  }
  if (record.contextGeneration !== void 0 && (typeof record.contextGeneration !== "string" || !/^cg-v1-[a-f0-9]{64}$/.test(record.contextGeneration))) {
    throw new TaskContextCardSchemaError(
      "Task Context Card contextGeneration must be a canonical cg-v1 digest when present."
    );
  }
  if (typeof record.taskDeltaDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.taskDeltaDigest)) {
    throw new TaskContextCardSchemaError(
      "Task Context Card taskDeltaDigest must be a lowercase sha256 digest."
    );
  }
  try {
    const nodeContext = normalizeTaskNodeContext({
      workNodeIds: record.workNodeIds,
      contextNodeIds: record.contextNodeIds,
      nodeSnapshots: record.nodeSnapshots
    });
    return {
      schemaVersion: TASK_CONTEXT_CARD_SCHEMA_VERSION,
      ...nodeContext,
      ...record.contextGeneration !== void 0 ? { contextGeneration: record.contextGeneration } : {},
      taskDeltaDigest: record.taskDeltaDigest
    };
  } catch (error) {
    throw new TaskContextCardSchemaError(
      error instanceof Error ? error.message : "Invalid Task Node context.",
      error
    );
  }
}

// src/core/task-context-card.ts
var INTEGRATION_MUTATOR_SERVICE = "service";
var TaskContextCardError = class extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "TaskContextCardError";
    this.code = code;
    this.details = details;
  }
};
function parseTaskContextCard(data) {
  try {
    return normalizeTaskContextCard(data);
  } catch (error) {
    throw new TaskContextCardError(
      "INVALID_CARD",
      error instanceof Error ? error.message : "Invalid Task Context Card.",
      { cause: error }
    );
  }
}
function loadTaskContextCardFromFrontmatter(data) {
  if (data.contextCard !== void 0 && data.contextCard !== null) {
    return parseTaskContextCard(data.contextCard);
  }
  return null;
}
function deriveIntegrationAuthority(input) {
  try {
    const pair = resolveParentReviewerPair({
      parentActor: input.parentActor,
      reviewer: input.reviewer
    });
    return {
      actor: { kind: pair.parentActor.kind, id: pair.parentActor.id },
      mutator: INTEGRATION_MUTATOR_SERVICE
    };
  } catch (err) {
    if (err instanceof TaskLifecycleError) {
      throw new TaskContextCardError("INVALID_ACTOR", err.message, {
        parentActor: input.parentActor,
        reviewer: input.reviewer
      });
    }
    throw err;
  }
}
function assertIntegrationAuthorityMatchesParent(authority, parentActor, reviewer) {
  const derived = deriveIntegrationAuthority({ parentActor, reviewer });
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    throw new TaskContextCardError(
      "INVALID_ACTOR",
      "integrationAuthority must be { actor, mutator: service } derived from parent/reviewer.",
      { authority }
    );
  }
  const raw = authority;
  if (raw.mutator !== INTEGRATION_MUTATOR_SERVICE) {
    throw new TaskContextCardError(
      "INVALID_ACTOR",
      `integrationAuthority.mutator must be "${INTEGRATION_MUTATOR_SERVICE}" (Service only); got ${String(raw.mutator)}.`,
      { authority }
    );
  }
  let actor;
  try {
    actor = parseTaskActorRef(raw.actor, "parentActor");
  } catch (err) {
    if (err instanceof TaskLifecycleError) {
      throw new TaskContextCardError("INVALID_ACTOR", err.message, { authority });
    }
    throw err;
  }
  if (actor.kind !== derived.actor.kind || actor.id !== derived.actor.id) {
    throw new TaskContextCardError(
      "INVALID_ACTOR",
      `integrationAuthority.actor must equal Task parent/reviewer (${derived.actor.kind}:${derived.actor.id}); got ${actor.kind}:${actor.id}.`,
      { authority, derived }
    );
  }
  return derived;
}

// src/core/task-node-refs.ts
var MISSING_TASK_NODE_SELECTION = "MISSING_TASK_NODE_SELECTION: Task.workNodeIds and Task.contextNodeIds are required.";
function normalizedSelection(task) {
  const label = task.id || task.path || "(unknown)";
  try {
    return normalizeTaskNodeSelection({
      workNodeIds: task.workNodeIds,
      contextNodeIds: task.contextNodeIds
    });
  } catch (error) {
    const wrapped = new Error(`${MISSING_TASK_NODE_SELECTION} task=${label}`);
    wrapped.cause = error;
    throw wrapped;
  }
}
function taskReferencedNodeIds(task) {
  const selection = normalizedSelection(task);
  return [...selection.workNodeIds, ...selection.contextNodeIds];
}

// src/core/task.ts
async function loadTaskEnvelopes(fs10) {
  const tasks = [];
  if (!await fs10.exists(TEMP_DIR)) return tasks;
  for (const entry2 of await fs10.listDir(TEMP_DIR)) {
    if (!entry2.isDir) continue;
    if (entry2.name !== ROLES_TEMP_DIR && entry2.name !== SESSIONS_TEMP_DIR) continue;
    const ownerRoot = join3(TEMP_DIR, entry2.name);
    for (const ownerEntry of await fs10.listDir(ownerRoot)) {
      if (!ownerEntry.isDir) continue;
      await collectTaskFiles(fs10, join3(ownerRoot, ownerEntry.name, "tasks"), tasks);
    }
  }
  return tasks.sort((a, b) => a.path.localeCompare(b.path));
}
async function collectTaskFiles(fs10, taskDir, tasks) {
  if (!await fs10.exists(taskDir)) return;
  for (const entry2 of await fs10.listDir(taskDir)) {
    if (entry2.isDir || !entry2.name.endsWith(".md")) continue;
    const path11 = join3(taskDir, entry2.name);
    tasks.push(await loadTaskEnvelope(fs10, path11));
  }
}
function taskExecutionLabel(task) {
  return [task.roleId ? `roleId=${task.roleId}` : "", task.sessionId ? `sessionId=${task.sessionId}` : ""].filter(Boolean).join(" ");
}
function assertIsoTimestamp(value, label) {
  const raw = value.trim();
  if (!raw) {
    throw new Error(`${label} must be a non-empty ISO-8601 timestamp.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new Error(
      `${label} must be a real ISO-8601 timestamp with timezone; got ${raw}.`
    );
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new Error(`${label} is not a parseable ISO-8601 instant: ${raw}.`);
  }
  return raw;
}
function parseBaseCommitCapture(value) {
  if (value === void 0 || value === null) return void 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "Task baseCommitCapture must be an object { source, baseCommit, actor, capturedAt }."
    );
  }
  const raw = value;
  const source = raw.source;
  if (source !== "first-claim") {
    throw new Error(
      `Task baseCommitCapture.source must be first-claim; got ${String(source)}.`
    );
  }
  const baseCommit = typeof raw.baseCommit === "string" ? raw.baseCommit.trim() : "";
  if (!baseCommit) {
    throw new Error("Task baseCommitCapture.baseCommit must be a non-empty SHA.");
  }
  const capturedAtRaw = typeof raw.capturedAt === "string" ? raw.capturedAt.trim() : "";
  const capturedAt = assertIsoTimestamp(
    capturedAtRaw,
    "Task baseCommitCapture.capturedAt"
  );
  let actor;
  try {
    actor = parseTaskActorRef(raw.actor, "parentActor");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg.replace(/Task parentActor/g, "Task baseCommitCapture.actor"));
  }
  return { source, baseCommit, actor, capturedAt };
}
async function loadTaskEnvelope(fs10, path11) {
  if (!await fs10.exists(path11)) throw new Error(`Task envelope not found: ${path11}.`);
  const { data, body } = parseFrontmatter(await fs10.readFile(path11));
  if (data.type !== "task" || typeof data.manifest !== "string") {
    throw new Error(`Invalid task envelope format: ${path11}.`);
  }
  const roleId = typeof data.roleId === "string" ? data.roleId.trim() : "";
  const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
  if (!roleId && !sessionId) {
    throw new Error(`Invalid task envelope format: ${path11} (roleId or sessionId is required).`);
  }
  if (roleId && !isRoleId(roleId)) {
    throw new Error(`Invalid task envelope format: ${path11} (invalid roleId).`);
  }
  if (sessionId && !isSessionId(sessionId)) {
    throw new Error(`Invalid task envelope format: ${path11} (invalid sessionId).`);
  }
  if (typeof data.id !== "string" || !isTaskId(data.id)) {
    throw new Error(`Invalid task envelope format: ${path11} (canonical task id is required).`);
  }
  const state = parseTaskState(data.state);
  const actors = resolveActorsFromDisk(data);
  const contextCard = loadTaskContextCardFromFrontmatter(data) ?? void 0;
  if (!contextCard) {
    throw new Error(
      `Invalid task envelope format: ${path11} (missing Task Context Card v2).`
    );
  }
  if ("deliveryPolicy" in data) {
    throw new Error(
      `Invalid task envelope format: ${path11} (retired deliveryPolicy field; use acceptMode).`
    );
  }
  if (!isAcceptMode(data.acceptMode)) {
    throw new Error(
      `Invalid task envelope format: ${path11} (acceptMode must be review-required, auto-accept, or agent-decide).`
    );
  }
  const task = {
    path: path11,
    ...roleId ? { roleId } : {},
    ...sessionId ? { sessionId } : {},
    manifest: data.manifest,
    state,
    id: data.id,
    parentActor: actors.parentActor,
    reviewer: actors.reviewer,
    prompt: body.trim() || void 0,
    contextCard,
    workNodeIds: contextCard.workNodeIds,
    contextNodeIds: contextCard.contextNodeIds,
    nodeSnapshots: contextCard.nodeSnapshots,
    acceptMode: data.acceptMode
  };
  if (data.asSub === true) task.asSub = true;
  if (typeof data.workspace === "string") task.workspace = data.workspace;
  if (typeof data.worktree === "string") task.worktree = data.worktree;
  if (typeof data.branch === "string") task.branch = data.branch;
  if (typeof data.targetBranch === "string") task.targetBranch = data.targetBranch;
  if (typeof data.roleBranchBase === "string" && data.roleBranchBase.trim()) {
    task.roleBranchBase = data.roleBranchBase.trim();
  }
  if (typeof data.baseCommit === "string" && data.baseCommit.trim()) {
    task.baseCommit = data.baseCommit.trim();
  }
  const baseCommitCapture = parseBaseCommitCapture(data.baseCommitCapture);
  if (baseCommitCapture) {
    const recordedBase = task.baseCommit?.trim() || "";
    if (!recordedBase) {
      throw new Error(
        `Invalid task envelope format: ${path11} (baseCommitCapture present but baseCommit missing).`
      );
    }
    if (recordedBase !== baseCommitCapture.baseCommit) {
      throw new Error(
        `Invalid task envelope format: ${path11} (baseCommit ${recordedBase} !== baseCommitCapture.baseCommit ${baseCommitCapture.baseCommit}).`
      );
    }
    task.baseCommitCapture = baseCommitCapture;
  }
  if (data.integrationAuthority !== void 0 && data.integrationAuthority !== null && task.parentActor && task.reviewer) {
    task.integrationAuthority = assertIntegrationAuthorityMatchesParent(
      data.integrationAuthority,
      task.parentActor,
      task.reviewer
    );
  }
  task.contextGeneration = contextCard.contextGeneration;
  task.taskDeltaDigest = contextCard.taskDeltaDigest;
  if (typeof data.activeDeliveryId === "string") task.activeDeliveryId = data.activeDeliveryId;
  if (data.lastOutcome === "delivered" || data.lastOutcome === "blocked" || data.lastOutcome === "needs-input") {
    task.lastOutcome = data.lastOutcome;
  }
  if (typeof data.createdAt === "string") task.createdAt = data.createdAt;
  if (typeof data.updatedAt === "string") task.updatedAt = data.updatedAt;
  const wait = parseWaitFields(data);
  if (wait) task.wait = wait;
  return task;
}
function resolveActorsFromDisk(data) {
  const hasParent = data.parentActor !== void 0 && data.parentActor !== null;
  const hasReviewer = data.reviewer !== void 0 && data.reviewer !== null;
  if (hasParent || hasReviewer) {
    if (!hasParent || !hasReviewer) {
      throw new Error(
        "Invalid task envelope: parentActor and reviewer must both be present when either is set."
      );
    }
    return resolveParentReviewerPair({
      parentActor: parseTaskActorRef(data.parentActor, "parentActor"),
      reviewer: parseTaskActorRef(data.reviewer, "reviewer")
    });
  }
  throw new Error("Invalid task envelope: missing parentActor/reviewer.");
}
async function ensureRoleInit(fs10, role, tentName) {
  if (!role.id || !isRoleId(role.id)) {
    throw new Error(`Role init requires a canonical Role id for ${role.name}.`);
  }
  const path11 = join3(TEMP_DIR, ROLES_TEMP_DIR, role.id, "init.md");
  const body = `# Role Init

- Tent: ${tentName}
- Agent rules (workspace file read): AGENTS.md at the workspace root
- Role registry (workspace file read): .tent/roles.json (or run \`tent roles\` from workspace root)

## Role Prompt

${role.prompt?.trim() || "(no persistent role prompt)"}

## Operating Model

Manifest readable/writable entries are an honor-system contract, not a security sandbox. If prompts conflict or a boundary cannot be followed, stop and ask the user.
Task lifecycle uses \`tent task *\` (Local Service). Do not invent paths as <workspace>/temp \u2014 operational files live under .tent/temp.
`;
  await fs10.writeFile(path11, serializeFrontmatter({ type: "role-init", role: role.name }, body));
  return path11;
}
function parseTaskState(value) {
  if (value === "queued" || value === "running" || value === "waiting" || value === "delivered" || value === "accepted" || value === "rejected" || value === "interrupted" || value === "failed") {
    return value;
  }
  throw new Error(`Invalid task state: ${String(value)}.`);
}
function parseWaitFields(data) {
  const reason = data.waitReason;
  const summary = data.waitSummary;
  if ((reason === "user-input" || reason === "review" || reason === "external") && typeof summary === "string") {
    const code = typeof data.waitCode === "string" && data.waitCode.trim() ? data.waitCode.trim() : void 0;
    return { reason, summary, ...code ? { code } : {} };
  }
  return void 0;
}

// src/core/output.ts
function parseOutputPointer(fm, body) {
  const result = {};
  const fmWorkspace = fieldString(fm.workspace);
  if (fmWorkspace) result.workspace = fmWorkspace;
  const fmRef = fieldString(fm.ref);
  if (fmRef) result.ref = fmRef;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = normalizeLabelLine(rawLine);
    if (!result.workspace) {
      const workspace = matchField(line, ["workspace", "workspace \u8DEF\u5F84", "repo", "pointer", "\u8DEF\u5F84"]);
      if (workspace) result.workspace = workspace;
    }
    if (!result.ref) {
      const ref = matchField(line, ["git ref", "git-ref", "\u5F53\u524D ref", "commit", "ref"]);
      if (ref) result.ref = ref;
    }
  }
  return result;
}
function fieldString(value) {
  return typeof value === "string" && value.trim() ? cleanValue(value) : void 0;
}
function normalizeLabelLine(line) {
  return line.trim().replace(/^[-*]\s+/, "").replace(/\*\*/g, "").replace(/`([^`]+)`/g, "$1").trim();
}
function matchField(line, fields) {
  for (const field of fields) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^${escaped}\\s*[:\uFF1A]\\s*(.+)$`, "i").exec(line);
    if (match) return cleanValue(match[1]);
  }
  return void 0;
}
function cleanValue(value) {
  return value.trim().replace(/^`|`$/g, "").trim();
}

// src/core/skillRoleRegistry.ts
var DEFAULT_ROLES_REGISTRY = {
  roles: []
};
async function loadRolesRegistry(fs10) {
  const { registry } = await readRolesRegistryState(fs10);
  return registry;
}
async function readRolesRegistryState(fs10) {
  if (!await fs10.exists(ROLES_REGISTRY_PATH)) {
    return {
      registry: cloneDefaultRoles(),
      recovered: false
    };
  }
  try {
    const rawText = await fs10.readFile(ROLES_REGISTRY_PATH);
    const parsed = JSON.parse(rawText);
    const registry = normalizeRolesRegistry(parsed);
    return { registry, recovered: false };
  } catch {
    const backupPath = await backupCorruptRegistry(fs10, ROLES_REGISTRY_PATH);
    const reset = cloneDefaultRoles();
    await writeJson(fs10, ROLES_REGISTRY_PATH, serializeRolesRegistry(reset));
    warnRegistryRecovered(
      ROLES_REGISTRY_PATH,
      backupPath,
      "reset",
      "IMPORTANT: role definitions cannot be inferred; restore needed roles from the backup."
    );
    return {
      registry: reset,
      recovered: true
    };
  }
}
function assertRoleNameAvailable(name) {
  if ([ROLES_TEMP_DIR, SESSIONS_TEMP_DIR].includes(name.trim().toLowerCase())) {
    throw new Error(`Role name is reserved by Tent: ${name}.`);
  }
}
function resolveRole(roles, ref) {
  const key = typeof ref === "string" ? ref.trim() : "";
  if (!key) return void 0;
  const byId = roles.find((role) => role.id === key);
  if (byId) return byId;
  return roles.find((role) => role.name === key);
}
function normalizeRolesRegistry(value) {
  const root = isRecord4(value) ? value : {};
  const roles = [];
  const usedIds = /* @__PURE__ */ new Set();
  if (Array.isArray(root.roles)) {
    for (const item of root.roles) {
      if (!isRecord4(item)) continue;
      const role = normalizeRoleDefinition(item, {
        usedIds,
        assignMissingId: "deterministic"
      });
      if (!role.name || roles.some((existing) => existing.name === role.name)) continue;
      if (roles.some((existing) => existing.id === role.id)) continue;
      usedIds.add(role.id);
      roles.push(role);
    }
  }
  return { roles };
}
function normalizeRoleDefinition(value, opts = {}) {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const usedIds = opts.usedIds ?? /* @__PURE__ */ new Set();
  const assign = opts.assignMissingId ?? "deterministic";
  let id = typeof value.id === "string" ? value.id.trim() : "";
  if (id && !isRoleId(id)) {
    id = "";
  }
  if (id && usedIds.has(id) && assign !== "keep") {
    id = "";
  }
  if (!id) {
    if (assign === "random") {
      id = makeUniqueRoleId(usedIds, opts.rand ?? Math.random);
    } else if (name) {
      id = deterministicRoleIdFromName(name, usedIds);
    } else {
      id = makeUniqueRoleId(usedIds, opts.rand ?? Math.random);
    }
  }
  const displayRaw = typeof value.displayName === "string" ? value.displayName.trim() : "";
  const displayName = displayRaw || name;
  const role = { id, name, displayName };
  if (typeof value.prompt === "string" && value.prompt.trim()) role.prompt = value.prompt.trim();
  if (typeof value.description === "string" && value.description.trim()) {
    role.description = value.description.trim();
  }
  if (typeof value.color === "string" && value.color.trim()) role.color = value.color.trim();
  const cli = normalizeCliConfig(value.cli);
  if (cli) role.cli = cli;
  return role;
}
function normalizeCliConfig(value) {
  if (value === void 0) return void 0;
  if (!isRecord4(value)) throw new Error("role.cli must be an object.");
  const command = typeof value.command === "string" ? value.command.trim() : "";
  if (!command) throw new Error("role.cli.command must be a non-empty string.");
  const cli = { command };
  if (value.resume !== void 0) {
    const resume = typeof value.resume === "string" ? value.resume.trim() : "";
    if (!resume) throw new Error("role.cli.resume must be a non-empty string.");
    cli.resume = resume;
  }
  return cli;
}
function serializeRolesRegistry(registry) {
  return {
    roles: registry.roles.map((role) => {
      const row = {
        id: role.id,
        name: role.name,
        displayName: role.displayName || role.name
      };
      if (role.prompt) row.prompt = role.prompt;
      if (role.description) row.description = role.description;
      if (role.color) row.color = role.color;
      if (role.cli) row.cli = { ...role.cli };
      return row;
    })
  };
}
function cloneDefaultRoles() {
  return {
    roles: DEFAULT_ROLES_REGISTRY.roles.map((role) => ({ ...role }))
  };
}
async function writeJson(fs10, path11, value) {
  if (!await fs10.exists(".tent")) await fs10.mkdir(".tent");
  await fs10.writeFile(path11, JSON.stringify(value, null, 2) + "\n");
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/core/status.ts
import * as fs5 from "node:fs/promises";
import * as path4 from "node:path";

// src/core/proposal.ts
async function loadProposals(fs10) {
  const proposals = [];
  if (!await fs10.exists("temp")) return proposals;
  for (const roleDir of await fs10.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join3("temp", roleDir.name, "proposals");
    if (!await fs10.exists(dir)) continue;
    for (const entry2 of await fs10.listDir(dir)) {
      if (entry2.isDir || !entry2.name.endsWith(".md")) continue;
      const path11 = join3(dir, entry2.name);
      try {
        proposals.push(await loadProposal(fs10, path11));
      } catch {
      }
    }
  }
  return proposals.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}
async function loadProposal(fs10, inputPath) {
  const path11 = normalizeProposalPath(inputPath);
  if (!await fs10.exists(path11)) throw new Error(`Proposal not found: ${path11}.`);
  const { data, body } = parseFrontmatter(await fs10.readFile(path11));
  if (data.type !== "proposal" || typeof data.nodeId !== "string" || !isNodeId(data.nodeId) || typeof data.role !== "string" || data.status !== "pending" && data.status !== "accepted" && data.status !== "rejected") {
    throw new Error(`Invalid proposal format: ${path11}.`);
  }
  return {
    path: path11,
    nodeId: data.nodeId,
    role: data.role,
    status: data.status,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : void 0,
    body: body.trim()
  };
}
function normalizeProposalPath(input) {
  const path11 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  const match = /^temp\/[^/]+\/proposals\/([^/]+)\.md$/.exec(path11);
  if (!match || !isNodeId(match[1])) {
    throw new Error("Proposal must point to temp/<role>/proposals/<nodeId>.md.");
  }
  return path11;
}

// src/core/claim.ts
function envelopeIsActiveOccupation(task) {
  return isActiveTaskState(task.state);
}

// src/core/workspace.ts
import * as nodePath2 from "node:path";
import * as nodeFs from "node:fs/promises";
import { spawn } from "node:child_process";
function resolveTentWorkspace(_tent, systemRoot) {
  void _tent;
  if (!systemRoot) return void 0;
  const fromLayout = workspaceRootFromSystemRoot(systemRoot);
  return fromLayout ? nodePath2.resolve(fromLayout) : void 0;
}

// src/core/status.ts
var NOT_INSIDE_TENT_MESSAGE = "Not inside a Tent (no .tent/index.md marker found).";
async function renderTentStatus(cwd = process.cwd(), role = process.env.TENT_ROLE, createFs) {
  const systemRoot = await findTentSystemRoot(cwd);
  if (!systemRoot) throw new Error(NOT_INSIDE_TENT_MESSAGE);
  if (!createFs) {
    throw new Error(
      "renderTentStatus requires createFs (host FsAdapter factory); Core does not import src/fs"
    );
  }
  const fsAdapter = createFs(systemRoot);
  const tent = await loadTent(fsAdapter);
  const workspace = resolveTentWorkspace(tent, systemRoot);
  const lines = [
    `Tent: ${systemRoot}`,
    `Workspace: ${workspace || "(none)"}`,
    ""
  ];
  const proposals = (await loadProposals(fsAdapter)).filter((proposal) => proposal.status === "pending");
  if (proposals.length === 0) {
    lines.push("Pending proposals: none");
  } else {
    lines.push("Pending proposals:");
    for (const proposal of proposals) {
      const node = tent.byId.get(proposal.nodeId);
      const first = proposal.body.split("\n").map((line) => line.trim()).find(Boolean) || "(empty proposal)";
      lines.push(`- ${proposal.nodeId}: ${node?.name ?? "(missing node)"} (${proposal.role}) - ${first}`);
    }
  }
  const allTasks = await loadTaskEnvelopes(fsAdapter);
  const roleId = role ? resolveRole((await loadRolesRegistry(fsAdapter)).roles, role)?.id : void 0;
  const pendingTasks = allTasks.filter((task) => task.state === "queued").filter((task) => !role || task.roleId === roleId);
  lines.push("");
  if (pendingTasks.length === 0) {
    lines.push("Pending tasks: none");
  } else {
    lines.push("Pending tasks:");
    for (const task of pendingTasks) {
      const nodeIds = taskReferencedNodeIds(task);
      lines.push(
        `- ${taskExecutionLabel(task)}/${path4.posix.basename(task.path)} -> ${nodeIds.join(", ") || "-"}`
      );
    }
  }
  const activeTasks = allTasks.filter((task) => envelopeIsActiveOccupation(task)).filter((task) => task.state !== "queued").filter((task) => !role || task.roleId === roleId);
  lines.push("");
  if (activeTasks.length === 0) {
    lines.push("Active tasks: none");
  } else {
    lines.push("Active tasks:");
    for (const task of activeTasks) {
      const state = task.state;
      const nodeIds = taskReferencedNodeIds(task);
      lines.push(
        `- ${task.id || path4.posix.basename(task.path)}: ${taskExecutionLabel(task)} [${state}] nodes=${nodeIds.join(",") || "-"}`
      );
    }
  }
  return lines.join("\n") + "\n";
}
async function findTentSystemRoot(cwd = process.cwd()) {
  let dir = path4.resolve(cwd);
  for (; ; ) {
    if (await isSystemRoot(dir)) return dir;
    const nested = path4.join(dir, ".tent");
    if (await isSystemRoot(nested)) return nested;
    const parent = path4.dirname(dir);
    if (parent === dir) return void 0;
    dir = parent;
  }
}
async function isSystemRoot(root) {
  return exists(path4.join(root, INDEX_PATH));
}
async function exists(target) {
  try {
    await fs5.access(target);
    return true;
  } catch {
    return false;
  }
}

// src/core/scaffold.ts
var RECOGNIZED_REGISTRY_PATHS = [
  TYPE_REGISTRY_PATH,
  ROLES_REGISTRY_PATH,
  TAGS_REGISTRY_PATH
];
async function scaffoldInWorkspace(workspaceFs, options) {
  const systemRelative = TENT_SYSTEM_DIR;
  if (await workspaceFs.exists(systemRelative)) {
    throw new Error(`Target already has a Tent system dir: ${systemRelative}`);
  }
  await workspaceFs.mkdir(systemRelative);
  const nested = (p) => `${systemRelative}/${p}`.replace(/\\/g, "/");
  const typeRegistry = options.typeRegistry ?? DEFAULT_TYPE_REGISTRY;
  const usedIds = /* @__PURE__ */ new Set();
  for (const node of options.nodes ?? []) {
    const nodeName = validateNodeName(node.name);
    const type = node.type.trim();
    if (!type) throw new Error(`Node ${nodeName} is missing a primary type.`);
    assertValidNodeType(type, typeRegistry);
    const id = node.id?.trim() || makeUniqueNodeId(usedIds);
    if (!isNodeId(id)) throw new Error(`Scaffold Node id must use canonical cx-* form: ${id}`);
    usedIds.add(id);
    const frontmatter = { id, type };
    const path11 = nested(nodeName);
    await workspaceFs.mkdir(path11);
    await workspaceFs.writeFile(
      `${path11}/${nodeName}.md`,
      serializeFrontmatter(frontmatter, `
${node.body ?? `# ${nodeName}
`}
`, NODE_FRONTMATTER_KEY_ORDER)
    );
  }
  await workspaceFs.mkdir(nested(TEMP_DIR));
  await workspaceFs.mkdir(nested(ATTACHMENTS_DIR));
  await workspaceFs.writeFile(
    nested(TYPE_REGISTRY_PATH),
    JSON.stringify(typeRegistry, null, 2) + "\n"
  );
  await workspaceFs.writeFile(
    nested(ROLES_REGISTRY_PATH),
    JSON.stringify(options.rolesRegistry ?? { roles: [] }, null, 2) + "\n"
  );
  await workspaceFs.writeFile(
    nested(TAGS_REGISTRY_PATH),
    JSON.stringify(DEFAULT_TAG_REGISTRY, null, 2) + "\n"
  );
  await workspaceFs.writeFile(nested(INDEX_PATH), tentIndexMarker());
  await ensureWorkspaceGitignore(workspaceFs);
  return { systemRootRelative: systemRelative };
}
async function reAdoptOrphanTent(workspaceFs) {
  const systemRelative = TENT_SYSTEM_DIR;
  const nested = (p) => `${systemRelative}/${p}`.replace(/\\/g, "/");
  if (!await workspaceFs.exists(systemRelative)) {
    throw new Error(
      `Cannot re-adopt: workspace has no ${TENT_SYSTEM_DIR}/ system directory.`
    );
  }
  const indexRel = nested(INDEX_PATH);
  if (await workspaceFs.exists(indexRel)) {
    const raw = await workspaceFs.readFile(indexRel);
    if (isValidTentIndexMarker(raw)) {
      throw new Error(
        `Cannot re-adopt: ${TENT_SYSTEM_DIR}/${INDEX_PATH} already marks a valid Tent.`
      );
    }
    throw new Error(
      `Cannot re-adopt: ${TENT_SYSTEM_DIR}/${INDEX_PATH} exists but is not a valid Tent index marker; refusing to overwrite ambiguous content.`
    );
  }
  const hasEvidence = await hasOrphanTentEvidence(workspaceFs, nested);
  if (!hasEvidence) {
    throw new Error(
      `Cannot re-adopt: ${TENT_SYSTEM_DIR}/ has no recognized Tent evidence (expected a registry file or a Markdown Node with durable cx- id).`
    );
  }
  const createdDirs = [];
  for (const dir of [TEMP_DIR, ATTACHMENTS_DIR]) {
    const rel = nested(dir);
    if (!await workspaceFs.exists(rel)) createdDirs.push(dir);
  }
  const createdRegistries = [];
  const registryBodies = /* @__PURE__ */ new Map();
  for (const reg of RECOGNIZED_REGISTRY_PATHS) {
    const rel = nested(reg);
    if (await workspaceFs.exists(rel)) continue;
    createdRegistries.push(reg);
    registryBodies.set(reg, defaultRegistryBody(reg));
  }
  const gitignoreWillUpdate = await workspaceGitignoreNeedsTentEntry(workspaceFs);
  for (const dir of createdDirs) {
    await workspaceFs.mkdir(nested(dir));
  }
  for (const reg of createdRegistries) {
    await workspaceFs.writeFile(nested(reg), registryBodies.get(reg));
  }
  await workspaceFs.writeFile(indexRel, tentIndexMarker());
  if (gitignoreWillUpdate) {
    await ensureWorkspaceGitignore(workspaceFs);
  }
  return {
    systemRootRelative: systemRelative,
    createdIndex: true,
    createdDirs,
    createdRegistries,
    gitignoreUpdated: gitignoreWillUpdate
  };
}
function isValidTentIndexMarker(raw) {
  try {
    const { data } = parseFrontmatter(raw);
    return data.type === "index";
  } catch {
    return false;
  }
}
async function hasOrphanTentEvidence(workspaceFs, nested) {
  for (const reg of RECOGNIZED_REGISTRY_PATHS) {
    if (await workspaceFs.exists(nested(reg))) return true;
  }
  return hasDurableNodeView(workspaceFs, "");
}
async function hasDurableNodeView(workspaceFs, systemRelDir) {
  if (systemRelDir && isOperationalPath(systemRelDir)) return false;
  const workspaceDir = systemRelDir ? `${TENT_SYSTEM_DIR}/${systemRelDir}`.replace(/\\/g, "/") : TENT_SYSTEM_DIR;
  let entries;
  try {
    entries = await workspaceFs.listDir(workspaceDir);
  } catch {
    return false;
  }
  for (const entry2 of entries) {
    const childSystemRel = systemRelDir ? `${systemRelDir}/${entry2.name}`.replace(/\\/g, "/") : entry2.name;
    if (entry2.isDir) {
      if (isOperationalPath(childSystemRel)) continue;
      if (await hasDurableNodeView(workspaceFs, childSystemRel)) return true;
      continue;
    }
    if (!entry2.name.endsWith(".md")) continue;
    if (isSystemNoteName(entry2.name)) continue;
    const workspaceFile = `${workspaceDir}/${entry2.name}`.replace(/\\/g, "/");
    let raw;
    try {
      raw = await workspaceFs.readFile(workspaceFile);
    } catch {
      continue;
    }
    try {
      const { data } = parseFrontmatter(raw);
      const id = typeof data.id === "string" ? data.id.trim() : "";
      if (id && isNodeId(id)) return true;
    } catch {
    }
  }
  return false;
}
function defaultRegistryBody(reg) {
  if (reg === TYPE_REGISTRY_PATH) {
    return JSON.stringify(DEFAULT_TYPE_REGISTRY, null, 2) + "\n";
  }
  if (reg === ROLES_REGISTRY_PATH) {
    return JSON.stringify({ roles: [] }, null, 2) + "\n";
  }
  if (reg === TAGS_REGISTRY_PATH) {
    return JSON.stringify(DEFAULT_TAG_REGISTRY, null, 2) + "\n";
  }
  throw new Error(`Unknown registry path for re-adopt defaults: ${reg}`);
}
async function workspaceGitignoreNeedsTentEntry(workspaceFs) {
  const path11 = ".gitignore";
  const entry2 = `${TENT_SYSTEM_DIR}/`;
  if (!await workspaceFs.exists(path11)) return true;
  const text = await workspaceFs.readFile(path11);
  const lines = text.split(/\r?\n/);
  return !lines.some((line) => {
    const t = line.trim();
    return t === entry2 || t === TENT_SYSTEM_DIR || t === `/${entry2}` || t === `/${TENT_SYSTEM_DIR}`;
  });
}
async function ensureWorkspaceGitignore(workspaceFs) {
  const path11 = ".gitignore";
  const entry2 = `${TENT_SYSTEM_DIR}/`;
  if (!await workspaceFs.exists(path11)) {
    await workspaceFs.writeFile(path11, `${entry2}
`);
    return;
  }
  const text = await workspaceFs.readFile(path11);
  const lines = text.split(/\r?\n/);
  const has = lines.some((line) => {
    const t = line.trim();
    return t === entry2 || t === TENT_SYSTEM_DIR || t === `/${entry2}` || t === `/${TENT_SYSTEM_DIR}`;
  });
  if (has) return;
  const next = text.endsWith("\n") || text === "" ? `${text}${entry2}
` : `${text}
${entry2}
`;
  await workspaceFs.writeFile(path11, next);
}
function validateNodeName(value) {
  const name = value.trim();
  if (!name) throw new Error("Node name cannot be empty.");
  if (name.length > 200) throw new Error("Node name cannot be longer than 200 characters.");
  if (/[\/\\]/.test(name)) throw new Error("Node name cannot contain path separators.");
  if (/[\r\n]/.test(name)) throw new Error("Node name cannot contain newlines.");
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(name)) throw new Error("Node name cannot contain control characters.");
  return name;
}
function tentIndexMarker() {
  return `---
type: index
okf_version: "0.1"
---
# Index
`;
}

// src/cli/service-attach.ts
import * as fs8 from "node:fs/promises";
import * as path7 from "node:path";
import { spawn as spawn2 } from "node:child_process";
import { fileURLToPath } from "node:url";

// src/service/data-dir.ts
import * as fs7 from "node:fs/promises";
import { isIP } from "node:net";
import * as os3 from "node:os";
import * as path6 from "node:path";

// src/machine-state.ts
import * as fs6 from "node:fs/promises";
import * as path5 from "node:path";
function isNotFoundError(err) {
  return !!err && typeof err === "object" && "code" in err && err.code === "ENOENT";
}

// src/service/data-dir.ts
var MAX_SERVICE_ENDPOINT_CANDIDATES = 32;
var MAX_SERVICE_ENDPOINT_FILE_BYTES = 16 * 1024;
var SERVICE_ENDPOINT_PREFIX = "service.endpoint.";
var SERVICE_ENDPOINT_SUFFIX = ".json";
var INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function defaultServiceDataDir(env = process.env) {
  if (env.TENT_SERVICE_DATA_DIR) return path6.resolve(env.TENT_SERVICE_DATA_DIR);
  if (process.platform === "win32") {
    const base = env.APPDATA || path6.join(os3.homedir(), "AppData", "Roaming");
    return path6.join(base, "Tent");
  }
  if (process.platform === "darwin") {
    return path6.join(os3.homedir(), "Library", "Application Support", "Tent");
  }
  const xdg = env.XDG_STATE_HOME || path6.join(os3.homedir(), ".local", "state");
  return path6.join(xdg, "tent");
}
function serviceBaseUrl(host, port) {
  const authorityHost = isIP(host) === 6 ? `[${host}]` : host;
  return `http://${authorityHost}:${port}`;
}
function isLoopbackServiceHost(host) {
  const normalized = host.trim().toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return normalized.startsWith("127.");
  if (family === 6) {
    return normalized === "::1" || /^::ffff:127\./.test(normalized);
  }
  return false;
}
async function readServiceEndpointCandidates(dataDir) {
  const names = await newestEndpointGenerationNames(dataDir);
  const records = [];
  for (const name of names) {
    const file = path6.join(dataDir, name);
    try {
      const raw = await readBoundedEndpointFile(file);
      if (raw === null) continue;
      const value = parseServiceEndpointRecord(JSON.parse(raw));
      if (!value || endpointGenerationName(value.instanceId, value.startedAt) !== name) {
        continue;
      }
      records.push(value);
    } catch (error) {
      if (isNotFoundError(error) || error instanceof SyntaxError) continue;
      continue;
    }
  }
  return records;
}
function parseServiceEndpointRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value;
  if (typeof data.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(data.instanceId) || !Number.isInteger(data.pid) || (data.pid ?? 0) <= 0 || !Number.isInteger(data.port) || (data.port ?? 0) <= 0 || (data.port ?? 0) > 65535 || typeof data.host !== "string" || !isLoopbackServiceHost(data.host) || typeof data.startedAt !== "string" || !isCanonicalServiceStartedAt(data.startedAt) || typeof data.version !== "string" || data.token !== void 0 && typeof data.token !== "string") {
    return null;
  }
  return data;
}
function endpointGenerationName(instanceId, startedAt) {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error("Invalid Local Tent Service instance id");
  }
  if (!isCanonicalServiceStartedAt(startedAt)) {
    throw new Error("Invalid Local Tent Service startedAt");
  }
  const startedMs = Date.parse(startedAt);
  return `${SERVICE_ENDPOINT_PREFIX}${Math.trunc(startedMs).toString().padStart(16, "0")}.${instanceId}${SERVICE_ENDPOINT_SUFFIX}`;
}
function isCanonicalServiceStartedAt(value) {
  const startedMs = Date.parse(value);
  return Number.isFinite(startedMs) && startedMs >= 0 && new Date(startedMs).toISOString() === value;
}
async function newestEndpointGenerationNames(dataDir) {
  const newest = [];
  let directory;
  try {
    directory = await fs7.opendir(dataDir);
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  for await (const entry2 of directory) {
    if (!entry2.isFile() || !isEndpointGenerationName(entry2.name)) continue;
    const insertAt = newest.findIndex((name) => entry2.name > name);
    if (insertAt < 0) newest.push(entry2.name);
    else newest.splice(insertAt, 0, entry2.name);
    if (newest.length > MAX_SERVICE_ENDPOINT_CANDIDATES) newest.pop();
  }
  return newest;
}
function isEndpointGenerationName(name) {
  if (!name.startsWith(SERVICE_ENDPOINT_PREFIX) || !name.endsWith(SERVICE_ENDPOINT_SUFFIX)) {
    return false;
  }
  const middle = name.slice(SERVICE_ENDPOINT_PREFIX.length, -SERVICE_ENDPOINT_SUFFIX.length);
  const separator = middle.indexOf(".");
  if (separator <= 0) return false;
  const timestamp2 = middle.slice(0, separator);
  const instanceId = middle.slice(separator + 1);
  return /^\d{16}$/.test(timestamp2) && INSTANCE_ID_PATTERN.test(instanceId);
}
async function readBoundedEndpointFile(file) {
  let handle;
  try {
    handle = await fs7.open(file, "r");
    const buffer = Buffer.allocUnsafe(MAX_SERVICE_ENDPOINT_FILE_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        used,
        buffer.length - used,
        null
      );
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used === 0 || used > MAX_SERVICE_ENDPOINT_FILE_BYTES) return null;
    return buffer.subarray(0, used).toString("utf8");
  } finally {
    await handle?.close().catch(() => void 0);
  }
}

// src/service/protocol.ts
var TENT_SERVICE_PROTOCOL_VERSION = 5;
var ServiceProtocolIncompatibleError = class extends Error {
  constructor(kind, options = {}) {
    const servicePackageVersion = typeof options.servicePackageVersion === "string" && options.servicePackageVersion.trim() ? options.servicePackageVersion.trim() : "unknown";
    const serviceProtocolVersion = options.serviceProtocolVersion;
    const message = options.message ?? (kind === "missing" ? `Local Tent Service protocol is missing (legacy endpoint). This CLI requires protocol ${TENT_SERVICE_PROTOCOL_VERSION} (package version stays 0.1.0; protocol is a separate contract). Service package version=${servicePackageVersion}. Restart or upgrade tent-service, then retry. Refusing to attach or spawn a competing service against an incompatible process.` : `Local Tent Service protocol mismatch: service=${String(serviceProtocolVersion)}, client=${TENT_SERVICE_PROTOCOL_VERSION} (package 0.1.0; protocol is separate). Service package version=${servicePackageVersion}. Restart or upgrade tent-service to a compatible build before any business RPC. Refusing attach success and refusing to spawn a competing service.`);
    super(message);
    this.code = "TENT_SERVICE_PROTOCOL_INCOMPATIBLE";
    this.name = "ServiceProtocolIncompatibleError";
    this.kind = kind;
    this.clientProtocolVersion = TENT_SERVICE_PROTOCOL_VERSION;
    this.serviceProtocolVersion = serviceProtocolVersion;
    this.servicePackageVersion = servicePackageVersion;
  }
};
function isServiceProtocolIncompatibleError(err) {
  return err instanceof ServiceProtocolIncompatibleError || typeof err === "object" && err !== null && err.code === "TENT_SERVICE_PROTOCOL_INCOMPATIBLE";
}
function assertServiceProtocolCompatible(health) {
  const servicePackageVersion = health && typeof health.version === "string" && health.version.trim() ? health.version.trim() : "unknown";
  const raw = health?.protocolVersion;
  if (raw === void 0 || raw === null) {
    throw new ServiceProtocolIncompatibleError("missing", {
      servicePackageVersion,
      serviceProtocolVersion: raw
    });
  }
  if (raw !== TENT_SERVICE_PROTOCOL_VERSION) {
    throw new ServiceProtocolIncompatibleError("mismatch", {
      servicePackageVersion,
      serviceProtocolVersion: raw
    });
  }
}

// src/service/endpoint-discovery.ts
var SERVICE_ENDPOINT_PROBE_TIMEOUT_MS = 1e3;
var OWNED_SERVICE_CHILD_STOP_TIMEOUT_MS = 2e3;
var MultipleHealthyServiceEndpointsError = class extends Error {
  constructor(endpoints) {
    super(
      `Multiple authenticated Local Tent Services are healthy: ${endpoints.map((endpoint) => `${endpoint.instanceId}@${serviceBaseUrl(endpoint.host, endpoint.port)}`).join(", ")}`
    );
    this.endpoints = endpoints;
    this.code = "MULTIPLE_HEALTHY_SERVICE_ENDPOINTS";
    this.name = "MultipleHealthyServiceEndpointsError";
  }
};
async function discoverAuthenticatedServiceEndpoint(dataDir, probe) {
  const candidates = await readServiceEndpointCandidates(dataDir);
  const results = await Promise.all(
    candidates.map(async (endpoint) => {
      if (!endpoint.token?.trim()) return { kind: "unhealthy", endpoint };
      let probed;
      try {
        probed = await runBoundedProbe(endpoint, probe);
      } catch {
        return { kind: "unhealthy", endpoint };
      }
      if (!probed || probed.health.status !== "ok") {
        return { kind: "unhealthy", endpoint };
      }
      try {
        assertServiceProtocolCompatible(probed.health);
      } catch (error) {
        if (isServiceProtocolIncompatibleError(error)) {
          return { kind: "incompatible", endpoint, error };
        }
        throw error;
      }
      if (probed.health.instanceId !== endpoint.instanceId || probed.health.pid !== endpoint.pid || probed.health.startedAt !== endpoint.startedAt) {
        return { kind: "unhealthy", endpoint };
      }
      return { kind: "compatible", endpoint, value: probed.value };
    })
  );
  const incompatible = results.find((result) => result.kind === "incompatible");
  if (incompatible?.kind === "incompatible") throw incompatible.error;
  const compatible = results.filter(
    (result) => result.kind === "compatible"
  );
  if (compatible.length > 1) {
    throw new MultipleHealthyServiceEndpointsError(
      compatible.map((result) => result.endpoint)
    );
  }
  return compatible[0]?.value ?? null;
}
async function runBoundedProbe(endpoint, probe) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      probe(endpoint, controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Local Tent Service authenticated probe timed out"));
        }, SERVICE_ENDPOINT_PROBE_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function stopOwnedServiceChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
  } catch {
  }
  if (await waitForChildExit(child, OWNED_SERVICE_CHILD_STOP_TIMEOUT_MS)) return;
  try {
    child.kill("SIGKILL");
  } catch {
  }
  if (await waitForChildExit(child, OWNED_SERVICE_CHILD_STOP_TIMEOUT_MS)) return;
  throw new Error(`Owned Local Tent Service child ${child.pid} did not exit`);
}
async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve10) => {
    let timer;
    const finish = (exited) => {
      if (timer) clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve10(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(child.exitCode !== null || child.signalCode !== null);
    child.once("exit", onExit);
    child.once("error", onError);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

// src/service/auth.ts
import * as crypto2 from "node:crypto";

// src/runtime/session-token.ts
import * as crypto from "node:crypto";

// src/service/auth.ts
var AUTH_TOKEN_HEADER = "x-tent-token";
var CALLER_SESSION_ID_HEADER = "x-tent-session-id";
var CALLER_SESSION_TOKEN_HEADER = "x-tent-session-token";
var CALLER_EXTERNAL_KEY_HEADER = "x-tent-external-key";

// src/service/client.ts
function isPlainObject2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseRpcErrorBody(value) {
  if (!isPlainObject2(value)) return null;
  if (!Number.isInteger(value.code) || typeof value.message !== "string") return null;
  const error = { code: value.code, message: value.message };
  if (Object.prototype.hasOwnProperty.call(value, "data")) {
    error.data = value.data;
  }
  return error;
}
var ServiceClient = class {
  constructor(options) {
    this.idSeq = 1;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.currentSessionId = options.currentSessionId?.trim() || void 0;
    this.currentSessionToken = options.currentSessionToken?.trim() || void 0;
    this.currentExternalKey = options.currentExternalKey?.trim() || void 0;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async health() {
    const res = await this.fetchImpl(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`health HTTP ${res.status}`);
    return res.json();
  }
  async call(method, params, request) {
    const rpc = await this.rpcRaw(method, params, request);
    if (rpc.error) {
      const err = new Error(rpc.error.message);
      err.code = rpc.error.code;
      err.data = rpc.error.data;
      throw err;
    }
    return rpc.result;
  }
  async tryCall(method, params) {
    const rpc = await this.rpcRaw(method, params);
    if (rpc.error) {
      return { ok: false, error: rpc.error };
    }
    return { ok: true, result: rpc.result };
  }
  async rpcRaw(method, params, request) {
    const id = this.idSeq++;
    const res = await this.fetchImpl(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AUTH_TOKEN_HEADER]: this.token,
        ...this.currentSessionId && this.currentSessionToken ? {
          [CALLER_SESSION_ID_HEADER]: this.currentSessionId,
          [CALLER_SESSION_TOKEN_HEADER]: this.currentSessionToken
        } : {},
        ...this.currentExternalKey ? { [CALLER_EXTERNAL_KEY_HEADER]: this.currentExternalKey } : {}
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: request?.signal
    });
    if (res.status === 401) {
      return { error: { code: -32001, message: "Unauthorized: invalid or missing service token" } };
    }
    let rawText;
    try {
      rawText = await res.text();
    } catch {
      throw new Error(`Service RPC: failed to read response (HTTP ${res.status})`);
    }
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      if (res.ok) throw new Error("Service RPC: invalid JSON response");
      throw new Error(`Service RPC HTTP ${res.status}`);
    }
    if (!isPlainObject2(parsed) || parsed.jsonrpc !== "2.0") {
      if (res.ok) {
        throw new Error(
          !isPlainObject2(parsed) ? "Service RPC: response must be a plain object" : "Service RPC: invalid jsonrpc version"
        );
      }
      throw new Error(`Service RPC HTTP ${res.status}`);
    }
    const hasResult = Object.prototype.hasOwnProperty.call(parsed, "result");
    const hasError = Object.prototype.hasOwnProperty.call(parsed, "error");
    if (hasResult === hasError) {
      if (res.ok) {
        throw new Error("Service RPC: response must include exactly one of result or error");
      }
      throw new Error(`Service RPC HTTP ${res.status}`);
    }
    if (res.ok) {
      if (parsed.id !== id) {
        throw new Error(`Service RPC: response id mismatch (expected ${id})`);
      }
      if (hasResult) {
        return { result: parsed.result };
      }
      const error2 = parseRpcErrorBody(parsed.error);
      if (!error2) {
        throw new Error("Service RPC: invalid error object");
      }
      return { error: error2 };
    }
    if (!hasError) {
      throw new Error(`Service RPC HTTP ${res.status}`);
    }
    const error = parseRpcErrorBody(parsed.error);
    if (!error) {
      throw new Error(`Service RPC HTTP ${res.status}`);
    }
    return { error };
  }
  // ---- convenience: workspace ----
  mount(workspaceRoot, opts) {
    return this.call("workspace.mount", { workspaceRoot, ...opts });
  }
  unmount(workspaceId) {
    return this.call("workspace.unmount", { workspaceId });
  }
  listWorkspaces() {
    return this.call("workspace.list", {});
  }
  setForeground(workspaceId) {
    return this.call("workspace.setForeground", { workspaceId });
  }
  /**
   * Read workspace collaboration settings projection (defaultAcceptMode, extensible).
   * Missing file/field resolves to defaultAcceptMode=review-required.
   */
  workspaceSettings(workspaceId) {
    return this.call("workspace.settings", { workspaceId });
  }
  /**
   * User-only settings mutation (MutationBus).
   * Emits exactly one workspace.settings.updated on successful actual change; no-op emits none.
   * `actor` defaults to "user"; non-user is rejected by the service.
   * Canonical writes accept review-required | auto-accept | agent-decide only.
   */
  workspaceSettingsUpdate(workspaceId, patch, actor = "user") {
    return this.call("workspace.settings.update", {
      workspaceId,
      ...patch,
      actor
    });
  }
  /**
   * Read canonical workspace-root AGENTS.md projection.
   * Missing file → content "" and exists=false (not an error). Includes etag for edit.
   */
  workspaceAgents(workspaceId) {
    return this.call("workspace.agents", { workspaceId });
  }
  /**
   * User-only write of workspace-root AGENTS.md (MutationBus, atomic).
   * Optional baseEtag rejects stale writes with -32009. Emits workspace.agents.updated
   * only when content actually changes; no-op emits none.
   * `actor` defaults to "user"; non-user is rejected by the service.
   */
  workspaceAgentsWrite(workspaceId, args) {
    return this.call("workspace.agents.write", {
      workspaceId,
      content: args.content,
      ...args.baseEtag !== void 0 ? { baseEtag: args.baseEtag } : {},
      actor: args.actor ?? "user"
    });
  }
  // ---- convenience: docs ----
  docsList(workspaceId, includeBody = false) {
    return this.call("docs.list", {
      workspaceId,
      includeBody
    });
  }
  docsGet(workspaceId, nodeId) {
    return this.call("docs.get", {
      workspaceId,
      nodeId
    });
  }
  docsReadForEdit(workspaceId, nodeId) {
    return this.call("docs.readForEdit", { workspaceId, nodeId });
  }
  /**
   * Existing-node body/frontmatter write. baseEtag is required (from docs.readForEdit).
   * Missing → -32008; stale → -32009. Errors carry currentEtag only (no body).
   */
  docsWrite(workspaceId, args) {
    return this.call("docs.write", { workspaceId, ...args });
  }
  docsCreateNote(workspaceId, args) {
    return this.call(
      "docs.createNote",
      { workspaceId, ...args }
    );
  }
  docsFork(workspaceId, nodeId) {
    return this.call("docs.fork", { workspaceId, nodeId });
  }
  /**
   * User-only atomic Node rename (MutationBus).
   * Success emits exactly one node.changed with oldPath/path.
   */
  docsRename(workspaceId, args) {
    return this.call("docs.rename", { workspaceId, ...args });
  }
  /**
   * User-only structural move / reparent (MutationBus).
   * Resolve by stable cx- id; expectedPath required for stale-path conflict.
   * newParentId null = tent root. position: inside | before/after siblingId.
   * Success emits exactly one node.changed (reason docs.move) with oldPath/path/pathMap.
   */
  docsMove(workspaceId, args) {
    return this.call("docs.move", { workspaceId, ...args });
  }
  /**
   * Set Node mode (editable | archived). Sole mode mutation client surface.
   */
  docsSetMode(workspaceId, args) {
    return this.call("docs.setMode", { workspaceId, ...args });
  }
  /**
   * Import attachment bytes for a Node. Wire payload is base64; disk stores original bytes.
   */
  docsImportAttachment(workspaceId, args) {
    return this.call("docs.importAttachment", { workspaceId, ...args });
  }
  /**
   * User-only set compound Node type (MutationBus + baseEtag).
   * Missing baseEtag → -32008; stale → -32009. Emits node.changed reason docs.setType.
   */
  docsSetType(workspaceId, args) {
    return this.call("docs.setType", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user"
    });
  }
  /**
   * User-only replace Node tags (MutationBus + baseEtag). Empty clears Node tags only.
   */
  docsTagsSet(workspaceId, args) {
    return this.call("docs.tags.set", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user"
    });
  }
  /** User-only attach one tag (idempotent; MutationBus + baseEtag). */
  docsTagAdd(workspaceId, args) {
    return this.call("docs.tag.add", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user"
    });
  }
  /** User-only detach one tag from Node (does not prune registry). */
  docsTagRemove(workspaceId, args) {
    return this.call("docs.tag.remove", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user"
    });
  }
  /**
   * Read-only first-class semantic relations for a Node.
   * Outgoing from source frontmatter; incoming derived from other Nodes.
   * Does not include Markdown/wiki body links.
   */
  relationList(workspaceId, args) {
    return this.call("relation.list", { workspaceId, ...args });
  }
  /**
   * User-only create semantic relation on source Node (MutationBus + baseEtag).
   * Missing baseEtag → -32008; stale → -32009. Emits node.changed reason relation.create.
   */
  relationCreate(workspaceId, args) {
    return this.call("relation.create", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user"
    });
  }
  /**
   * User-only update semantic relation (cannot change id/source).
   * label: null clears. Emits node.changed reason relation.update.
   */
  relationUpdate(workspaceId, args) {
    return this.call("relation.update", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user"
    });
  }
  /**
   * User-only delete semantic relation by id on source Node.
   * Missing id fails loudly. Emits node.changed reason relation.delete.
   */
  relationDelete(workspaceId, args) {
    return this.call("relation.delete", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user"
    });
  }
  // ---- convenience: registry ----
  registryTypes(workspaceId) {
    return this.call("registry.types", { workspaceId });
  }
  /**
   * User-only custom secondary type create. Primaries / built-ins fail loud.
   * Emits registry.types.updated.
   */
  registryTypeCreate(workspaceId, args) {
    return this.call("registry.type.create", {
      workspaceId,
      name: args.name,
      actor: args.actor ?? "user"
    });
  }
  /**
   * User-only custom secondary type delete. confirmation must equal name.
   * In-use and built-in fail loud. Emits registry.types.updated.
   */
  registryTypeDelete(workspaceId, args) {
    return this.call("registry.type.delete", {
      workspaceId,
      name: args.name,
      confirmation: args.confirmation,
      actor: args.actor ?? "user"
    });
  }
  /** Read-only global tag vocabulary. */
  registryTags(workspaceId) {
    return this.call("registry.tags", { workspaceId });
  }
  /** User-only ensure tag in global vocabulary. Emits registry.tags.updated. */
  registryTagCreate(workspaceId, args) {
    return this.call("registry.tag.create", {
      workspaceId,
      name: args.name,
      actor: args.actor ?? "user"
    });
  }
  /** User-only global tag delete + cascade off Nodes. Emits registry.tags.updated. */
  registryTagDelete(workspaceId, args) {
    return this.call("registry.tag.delete", {
      workspaceId,
      name: args.name,
      actor: args.actor ?? "user"
    });
  }
  /** Read-only durable Role registry projection (name-sorted). */
  registryRoles(workspaceId) {
    return this.call("registry.roles", { workspaceId });
  }
  /**
   * User-only role create (MutationBus). Pass fields at top level — never secrets.
   * Server assigns immutable roleId. `actor` defaults to "user"; non-user is rejected.
   */
  registryRoleCreate(workspaceId, role) {
    return this.call("registry.role.create", { workspaceId, ...role });
  }
  /**
   * User-only role update. Resolve by operational name (compat) or pass roleId in patch.
   * Operational name cannot be renamed in identity batch 1; change displayName instead.
   * Success emits exactly one registry.roles.updated.
   */
  registryRoleUpdate(workspaceId, name, patch) {
    return this.call("registry.role.update", { workspaceId, name, ...patch });
  }
  /**
   * User-only role delete. confirmation must equal operational name or roleId.
   * Refuses when the role has an active task or live managed session.
   */
  registryRoleDelete(workspaceId, name, confirmation, actor = "user") {
    return this.call("registry.role.delete", {
      workspaceId,
      name,
      confirmation,
      actor
    });
  }
  // ---- convenience: machine-local Agent Connections (safe metadata / editor projection) ----
  connectionList(opts) {
    return this.call("connection.list", opts ?? {});
  }
  connectionGet(connectionId) {
    return this.call("connection.get", { connectionId });
  }
  connectionCreate(connection) {
    return this.call("connection.create", connection);
  }
  /** Method connectionId always wins over patch data. */
  connectionUpdate(connectionId, patch) {
    return this.call("connection.update", { ...patch, connectionId });
  }
  connectionDelete(connectionId) {
    return this.call("connection.delete", { connectionId });
  }
  /**
   * Read-only product provider verification catalog.
   * Returns adapterId + verificationLevel (+ optional canResume/notes).
   * Distinct from connection.list (machine-local launch config). Never secrets.
   */
  providerCatalog() {
    return this.call("provider.catalog", {});
  }
  // ---- privileged machine Settings launch secrets (never returns plaintext) ----
  settingsLaunchSecretList() {
    return this.call("settings.launchSecret.list", {});
  }
  /**
   * Store encrypted secret under id. Response is id/metadata only.
   * Callers must not log `secret`; RPC response never echoes it.
   */
  settingsLaunchSecretSet(id, secret, label) {
    return this.call("settings.launchSecret.set", {
      id,
      secret,
      ...label !== void 0 ? { label } : {}
    });
  }
  settingsLaunchSecretDelete(id) {
    return this.call("settings.launchSecret.delete", { id });
  }
  // ---- convenience: machine-local skills (bundled only; no workspaceId) ----
  skillList() {
    return this.call("skill.list", {});
  }
  /**
   * Install bundled skills into shared-agents and/or claude skill dirs.
   * Omitting skills installs all bundled; omitting targets installs both.
   * Does not accept arbitrary source/destination paths.
   */
  skillInstall(opts) {
    return this.call("skill.install", opts ?? {});
  }
  // ---- convenience: task ----
  taskDispatch(workspaceId, args) {
    return this.call("task.dispatch", { workspaceId, ...args });
  }
  taskClaim(workspaceId, taskPath) {
    return this.call("task.claim", { workspaceId, taskPath });
  }
  /**
   * Create and immediately claim a durable Role's own execution Task.
   * This is execution ownership, not downstream dispatch: there is no target,
   * caller-authored parent/reviewer, asSub flag, or managed Session launch.
   */
  taskClaimDirect(workspaceId, args) {
    return this.call("task.claimDirect", { workspaceId, ...args });
  }
  taskWait(workspaceId, taskPath, reason, summary) {
    return this.call("task.wait", { workspaceId, taskPath, reason, summary });
  }
  taskResume(workspaceId, taskPath) {
    return this.call("task.resume", { workspaceId, taskPath });
  }
  /**
   * Exact executing Session requests a parent/user decision. Transport metadata
   * supplies requester identity; options are optional because custom/deny are universal.
   */
  taskRequestDecision(workspaceId, taskPath, args) {
    return this.call("task.requestDecision", { workspaceId, taskPath, ...args });
  }
  /**
   * U2A one-shot append to a running/waiting managed task (user-only).
   * Provide text and/or contextRefs (stable entity ids). Not chat; not a Decision response.
   */
  taskSendInput(workspaceId, taskPath, args) {
    return this.call("task.sendInput", { workspaceId, taskPath, ...args });
  }
  taskDeliver(workspaceId, taskPath, args) {
    return this.call("task.deliver", { workspaceId, taskPath, ...args });
  }
  taskAccept(workspaceId, taskPath, deliveryId, actor, opts) {
    return this.call("task.accept", {
      workspaceId,
      taskPath,
      deliveryId,
      actor,
      ...opts?.outputNodeIds ? { outputNodeIds: opts.outputNodeIds } : {}
    });
  }
  taskReject(workspaceId, taskPath, deliveryId, actor, opts) {
    return this.call("task.reject", { workspaceId, taskPath, deliveryId, actor, ...opts });
  }
  taskInterrupt(workspaceId, taskPath) {
    return this.call("task.interrupt", { workspaceId, taskPath });
  }
  taskCancel(workspaceId, taskPath) {
    return this.call("task.cancel", { workspaceId, taskPath });
  }
  taskStartSession(workspaceId, args) {
    return this.call("task.startSession", { workspaceId, ...args });
  }
  /**
   * Explicit fresh managed Session on the same Task when the bound provider
   * context is unusable. Not a silent fallback from taskStartSession.
   * Uses the Session's immutable Agent Connection snapshot; refuses turnBusy with
   * TURN_BUSY (no force).
   * Shares the per-Task managed-session execution slot with startSession.
   */
  taskReplaceSession(workspaceId, args) {
    return this.call("task.replaceSession", { workspaceId, ...args });
  }
  taskList(workspaceId) {
    return this.call("task.list", { workspaceId });
  }
  taskGet(workspaceId, taskPath) {
    return this.call("task.get", { workspaceId, taskPath });
  }
  /**
   * List deliveries for a workspace (optional Task / Node / responsibility filters).
   * Read projection only — review still uses task.accept / task.reject.
   */
  deliveryList(workspaceId, opts) {
    return this.call(
      "delivery.list",
      { workspaceId, ...opts }
    );
  }
  /** Get one delivery by id within a workspace. */
  deliveryGet(workspaceId, id) {
    return this.call(
      "delivery.get",
      { workspaceId, id }
    );
  }
  /** Exact-Node collaboration projection with at most one active Task. */
  nodeCollaboration(workspaceId, nodeId) {
    return this.call("node.collaboration", {
      workspaceId,
      nodeId
    });
  }
  /** Batch exact-Node collaboration; input order is preserved. */
  nodeCollaborations(workspaceId, nodeIds) {
    return this.call("node.collaborations", {
      workspaceId,
      nodeIds
    });
  }
  /**
   * V0.2 Output provenance: Output → Delivery → Task → sourceNode by id.
   * Unbound type=output returns bound:false; never infers by path/name/time.
   */
  outputProvenance(workspaceId, nodeId) {
    return this.call("output.provenance", {
      workspaceId,
      nodeId
    });
  }
  /**
   * Workspace-level graph projection for Working-set Canvas.
   * Node summaries include the raw document etag; no body or placement state.
   * Parent / markdown / wiki / relation edges remain separately partitioned.
   * Unresolved Node links are retained with an explicit unresolved payload.
   */
  graphProjection(workspaceId) {
    return this.call("graph.projection", { workspaceId });
  }
  // ---- convenience: proposal (triage; separate from delivery review) ----
  proposalList(workspaceId, opts) {
    return this.call("proposal.list", { workspaceId, ...opts });
  }
  proposalSubmit(workspaceId, args) {
    return this.call("proposal.submit", { workspaceId, ...args });
  }
  /**
   * User-only resolve (accept|reject). actor defaults to "user";
   * non-user actors are rejected by the service.
   */
  proposalResolve(workspaceId, path11, decision, actor = "user") {
    return this.call("proposal.resolve", { workspaceId, path: path11, decision, actor });
  }
  sessionList(workspaceId) {
    return this.call(
      "session.list",
      workspaceId ? { workspaceId } : {}
    );
  }
  sessionGet(sessionId) {
    return this.call("session.get", { sessionId });
  }
  /**
   * Register or reuse a pull-host external session (no ACP spawn).
   * Machine-callable; idempotent for sessionId / externalKey.
   */
  sessionEnter(args = {}) {
    return this.call("session.enter", { ...args });
  }
  /**
   * Optional Role Checkpoint (cooperative continuation note).
   * Operational under temp/<role>/checkpoint.md — not Delivery or Task state.
   */
  roleCheckpointGet(workspaceId, role) {
    return this.call("role.checkpoint.get", { workspaceId, role });
  }
  roleCheckpointSet(workspaceId, args) {
    return this.call("role.checkpoint.set", { workspaceId, ...args });
  }
  roleCheckpointClear(workspaceId, role, opts) {
    return this.call("role.checkpoint.clear", {
      workspaceId,
      role,
      ...opts?.actor ? { actor: opts.actor } : {}
    });
  }
  /** Probe external/managed session + incomplete task bindings. */
  sessionStatus(args = {}) {
    return this.call("session.status", { ...args });
  }
  /**
   * End external session binding only — never deliver/accept tasks.
   * Reports incompleteTasks still bound to the sessionId / externalKey.
   * Accepts either a sessionId string or an options object (hook closed-loop).
   */
  sessionLeave(sessionIdOrArgs, workspaceId) {
    if (typeof sessionIdOrArgs === "string") {
      return this.call("session.leave", {
        sessionId: sessionIdOrArgs,
        ...workspaceId ? { workspaceId } : {}
      });
    }
    return this.call("session.leave", { ...sessionIdOrArgs });
  }
  /** ACP tool permission pending list (permissionPolicy=ask). */
  toolApprovalListPending(workspaceId) {
    return this.call("toolApproval.listPending", workspaceId ? { workspaceId } : {});
  }
  toolApprovalGet(approvalId) {
    return this.call("toolApproval.get", { approvalId });
  }
  /** User-only: allow_once for one ACP tool request. */
  toolApprovalApproveOnce(approvalId, actor = "user") {
    return this.call("toolApproval.approveOnce", { approvalId, actor });
  }
  /** User-only: deny/cancel one ACP tool request. */
  toolApprovalDeny(approvalId, actor = "user") {
    return this.call("toolApproval.deny", { approvalId, actor });
  }
  /** Pending Decision Requests visible to the authenticated user/Role authority. */
  decisionRequestListPending(workspaceId) {
    return this.call("decisionRequest.listPending", { workspaceId });
  }
  decisionRequestGet(workspaceId, taskPath, requestId) {
    return this.call("decisionRequest.get", { workspaceId, taskPath, requestId });
  }
  /** Respond through authenticated transport authority; caller actor text is forbidden. */
  decisionRequestRespond(workspaceId, taskPath, requestId, response) {
    return this.call("decisionRequest.respond", {
      workspaceId,
      taskPath,
      requestId,
      response
    });
  }
  decisionRequestEscalate(workspaceId, taskPath, requestId) {
    return this.call("decisionRequest.escalate", { workspaceId, taskPath, requestId });
  }
  /**
   * Unified A2U pending read projection for one workspace.
   * Aggregates user-targeted Decision Requests / toolApproval / ready Delivery.
   * Resolve actions stay on domain RPCs — no interaction.resolve.
   */
  interactionListPending(workspaceId) {
    return this.call("interaction.listPending", {
      workspaceId
    });
  }
  /**
   * U2A attention rows for external/parent review (pending|failed|uncertain).
   * This projection is never a provider inject source.
   * Always requires workspaceId + taskPath — no machine-global inbox.
   */
  taskInputListPending(workspaceId, taskPath) {
    return this.call("taskInput.listPending", { workspaceId, taskPath });
  }
  /**
   * Scoped get: workspaceId + taskPath + inputId (no id-only lookup).
   */
  taskInputGet(workspaceId, taskPath, inputId) {
    return this.call("taskInput.get", { workspaceId, taskPath, inputId });
  }
  /**
   * Formal ack after observing one-shot input. Omit actor for the user path;
   * Role/session callers pass their exact bound identity.
   */
  taskInputAck(workspaceId, taskPath, inputId, actor) {
    return this.call("taskInput.ack", {
      workspaceId,
      taskPath,
      inputId,
      ...actor ? { actor } : {}
    });
  }
  /**
   * User-only operational retention preview (task-api §6).
   * Read-only: returns candidates/skipped/warnings; never mutates.
   * `keepTerminalTasksDays` defaults to 30; `0` = immediately eligible.
   */
  operationalRetentionPreview(workspaceId, opts) {
    return this.call("operationalRetention.preview", {
      workspaceId,
      ...opts
    });
  }
  /**
   * User-only operational retention purge (task-api §6).
   * Mutates via MutationBus; emits exactly one retention.purged when files are deleted.
   */
  operationalRetentionPurge(workspaceId, opts) {
    return this.call("operationalRetention.purge", {
      workspaceId,
      ...opts
    });
  }
  /**
   * Read-only Task worktree reclaim diagnostic (task-api WorkspaceLane GC).
   * Does not remove anything; auto-reclaim still runs on terminal transitions.
   */
  taskWorktreeReclaimPreview(workspaceId, taskPath) {
    return this.call("task.worktreeReclaim.preview", {
      workspaceId,
      taskPath
    });
  }
  /**
   * User-only exact-task reclaim reconciliation. Reloads one Task and reuses
   * normal ownership/dirty/session/integration gates; never scans or prunes.
   */
  taskWorktreeReclaimReconcile(workspaceId, taskPath, actor) {
    return this.call("task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath,
      actor
    });
  }
  /**
   * List Node Markdown underline annotations for a node (cx- identity).
   * Projection includes live relocate state; does not rewrite stored anchors.
   */
  annotationList(workspaceId, nodeId) {
    return this.call("annotation.list", { workspaceId, nodeId });
  }
  /**
   * User-only create underline annotation (MutationBus).
   * Validates range/quote against authoritative body; documentEtag uses docs.readForEdit etag.
   * Events: annotation.changed (invalidation only). Never injects Agent / TaskInput.
   */
  annotationCreate(workspaceId, args) {
    return this.call("annotation.create", {
      workspaceId,
      nodeId: args.nodeId,
      quote: args.quote,
      start: args.start,
      end: args.end,
      body: args.body,
      documentEtag: args.documentEtag,
      actor: args.actor ?? "user"
    });
  }
  /** User-only resolve annotation (open → resolved). */
  annotationResolve(workspaceId, id, actor = "user") {
    return this.call("annotation.resolve", { workspaceId, id, actor });
  }
  /** User-only reopen annotation (resolved → open). */
  annotationReopen(workspaceId, id, actor = "user") {
    return this.call("annotation.reopen", { workspaceId, id, actor });
  }
  /** User-only delete annotation record. */
  annotationDelete(workspaceId, id, actor = "user") {
    return this.call("annotation.delete", { workspaceId, id, actor });
  }
  /**
   * Subscribe to SSE events. Returns an abort handle.
   * Requires a global EventSource-compatible environment; for Node tests prefer
   * fetch streaming or EventBus in-process.
   */
  subscribeEvents(onEvent, onError) {
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/events`, {
          headers: { [AUTH_TOKEN_HEADER]: this.token, accept: "text/event-stream" },
          signal: ac.signal
        });
        if (!res.ok || !res.body) {
          onError?.(new Error(`SSE HTTP ${res.status}`));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const payload = JSON.parse(dataLine.slice(6));
              onEvent(payload);
            } catch {
            }
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) onError?.(err);
      }
    })();
    return { close: () => ac.abort() };
  }
};
function createServiceClient(options) {
  return new ServiceClient(options);
}

// src/cli/service-attach.ts
async function attachOrBootstrapService(options = {}) {
  const dataDir = options.dataDir ?? defaultServiceDataDir(options.env);
  const readyTimeoutMs = options.readyTimeoutMs ?? 15e3;
  const pollMs = options.pollMs ?? 200;
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnFn = options.spawnFn ?? spawn2;
  const currentSessionId = options.env?.TENT_SESSION_ID ?? process.env.TENT_SESSION_ID;
  const currentSessionToken = options.env?.TENT_SESSION_TOKEN ?? process.env.TENT_SESSION_TOKEN;
  const callerEnv = options.env ?? process.env;
  const currentExternalKey = callerEnv.TENT_EXTERNAL_SESSION_KEY?.trim() || (callerEnv.CODEX_THREAD_ID?.trim() ? `codex:${callerEnv.CODEX_THREAD_ID.trim()}` : callerEnv.CLAUDE_SESSION_ID?.trim() ? `claude:${callerEnv.CLAUDE_SESSION_ID.trim()}` : void 0);
  const existing = await tryAttachService(
    dataDir,
    fetchImpl,
    currentSessionId,
    currentSessionToken,
    currentExternalKey
  );
  if (existing) {
    return { ...existing, started: false, child: null, dataDir };
  }
  if (options.attachOnly) {
    throw new Error(
      `No healthy Local Tent Service endpoint in ${dataDir}. Start tent-service, or omit --attach-only to let CLI bootstrap one.`
    );
  }
  const entry2 = options.serviceEntry ?? await resolveDefaultServiceEntry(options.packageRoot);
  const entryAbs = path7.resolve(entry2);
  const child = spawnFn(process.execPath, [entryAbs, "start", "--data-dir", dataDir], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: cliServiceChildEnv(options.env, dataDir),
    windowsHide: true,
    cwd: path7.dirname(entryAbs)
  });
  let spawnLog = "";
  child.stdout?.on("data", (c) => {
    spawnLog += c.toString("utf8");
  });
  child.stderr?.on("data", (c) => {
    spawnLog += c.toString("utf8");
  });
  child.on("error", (err) => {
    spawnLog += String(err);
  });
  child.unref();
  let attachSucceeded = false;
  try {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      const attached = await tryAttachService(
        dataDir,
        fetchImpl,
        currentSessionId,
        currentSessionToken,
        currentExternalKey
      );
      if (attached) {
        attachSucceeded = true;
        return { ...attached, started: true, child, dataDir };
      }
      await sleep(pollMs);
    }
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(
        `Local Tent Service exited before an endpoint became healthy (code=${child.exitCode}). entry=${entryAbs}
${spawnLog}`
      );
    }
    throw new Error(
      `Timed out waiting for Local Tent Service after spawn (entry=${entryAbs}, dataDir=${dataDir})
${spawnLog}`
    );
  } finally {
    try {
      if (!attachSucceeded) await stopOwnedServiceChild(child);
    } finally {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }
}
function cliServiceChildEnv(overrides, dataDir) {
  return {
    ...process.env,
    ...overrides,
    TENT_SERVICE_DATA_DIR: dataDir,
    // Harmless for plain Node; required when parent is Electron-as-node.
    ELECTRON_RUN_AS_NODE: "1"
  };
}
async function tryAttachService(dataDir, fetchImpl = fetch, currentSessionId, currentSessionToken, currentExternalKey) {
  return discoverAuthenticatedServiceEndpoint(dataDir, async (endpoint, signal) => {
    const url = serviceBaseUrl(endpoint.host, endpoint.port);
    const client = createServiceClient({
      baseUrl: url,
      token: endpoint.token,
      fetchImpl,
      currentSessionId,
      currentSessionToken,
      currentExternalKey
    });
    const health = await client.call(
      "service.health",
      {},
      { signal }
    );
    return { health, value: { url, endpoint, client } };
  });
}
async function resolveDefaultServiceEntry(packageRootHint) {
  const roots = [];
  if (packageRootHint) roots.push(packageRootHint);
  roots.push(process.cwd());
  try {
    const here = path7.dirname(fileURLToPath(import.meta.url));
    if (path7.basename(here) === "cli" && path7.basename(path7.dirname(here)) === "src") {
      roots.push(path7.resolve(here, "../.."));
    } else {
      roots.push(here);
    }
  } catch {
  }
  const relativeCandidates = [
    "service.mjs",
    path7.join("dist", "service.mjs"),
    path7.join("desktop", "service.mjs"),
    path7.join("src", "service", "cli.ts")
  ];
  for (const root of roots) {
    for (const rel of relativeCandidates) {
      const candidate = path7.join(root, rel);
      try {
        await fs8.access(candidate);
        return candidate;
      } catch {
      }
    }
  }
  return path7.join(roots[0] ?? process.cwd(), "service.mjs");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// src/cli/workspace-context.ts
import * as path8 from "node:path";
async function ensureMountedWorkspace(client, options = {}) {
  const { workspaceRoot, systemRoot } = await resolveWorkspacePaths(options);
  const listed = await client.listWorkspaces();
  const existing = (listed.workspaces ?? []).find(
    (w) => path8.resolve(w.workspaceRoot) === path8.resolve(workspaceRoot)
  );
  if (existing) {
    return {
      workspaceRoot,
      systemRoot,
      workspaceId: existing.workspaceId
    };
  }
  const mounted = await client.mount(workspaceRoot);
  return {
    workspaceRoot: mounted.workspaceRoot ?? workspaceRoot,
    systemRoot: mounted.systemRoot ?? systemRoot,
    workspaceId: mounted.workspaceId
  };
}
async function resolveWorkspacePaths(options) {
  const start = path8.resolve(options.workspace || options.cwd || process.cwd());
  const systemRoot = await findTentSystemRoot(start);
  if (!systemRoot) {
    throw new Error(
      NOT_INSIDE_TENT_MESSAGE + (options.workspace ? ` (searched from --workspace ${start})` : "")
    );
  }
  const workspaceRoot = workspaceRootFromSystemRoot(systemRoot);
  if (!workspaceRoot) {
    throw new Error(
      `Tent system root is not an in-workspace .tent layout: ${systemRoot}. Service path requires <workspace>/.tent/ (architecture \xA73.1). Legacy pure-system-root fixtures still use direct CLI commands, not task RPC.`
    );
  }
  return { workspaceRoot: path8.resolve(workspaceRoot), systemRoot: path8.resolve(systemRoot) };
}

// src/cli/task-rpc.ts
async function runTaskCommand(sub, args, globals = {}) {
  try {
    const { positionals, flags, repeatable } = parseTaskFlags(args);
    const json = globals.json === true || flags.json === "true";
    if (sub === "claim" && (Object.prototype.hasOwnProperty.call(flags, "session") || Object.prototype.hasOwnProperty.call(flags, "session-id"))) {
      return failUsage(
        "tent task claim does not accept --session or --session-id; Session binding is owned by Tent host integration"
      );
    }
    if (sub === "accept" && Object.prototype.hasOwnProperty.call(flags, "commits")) {
      return failUsage(
        "tent task accept does not accept --commits; the ready Delivery is the sole commit source"
      );
    }
    if (sub === "accept" || sub === "reject") {
      const allowed = sub === "accept" ? /* @__PURE__ */ new Set(["delivery-id", "actor", "by", "outputs", "output-ids", ...TASK_COMMON_FLAGS]) : /* @__PURE__ */ new Set(["delivery-id", "actor", "by", "note", "resume", "no-resume", ...TASK_COMMON_FLAGS]);
      const unknown = findUnknownFlag(flags, allowed);
      if (unknown) return failUsage(`Unknown option --${unknown} for task ${sub}`);
      if (!flags["delivery-id"]) {
        return failUsage(`tent task ${sub} requires --delivery-id <deliveryId>`);
      }
    }
    const workspaceFlag = flags.workspace || globals.workspace;
    const attachOpts = {
      dataDir: flags["data-dir"] || globals.dataDir,
      attachOnly: globals.attachOnly === true || flags["attach-only"] === "true",
      serviceEntry: flags["service-entry"] || globals.serviceEntry,
      packageRoot: globals.packageRoot,
      env: globals.env
    };
    const client = globals.client ?? (await attachOrBootstrapService(attachOpts)).client;
    const ctx = await ensureMountedWorkspace(client, {
      cwd: globals.cwd,
      workspace: workspaceFlag
    });
    const workspaceId = ctx.workspaceId;
    switch (sub) {
      case "list": {
        if (positionals.length > 0) {
          return failUsage("Usage: tent task list [--workspace <path>] [--json]");
        }
        const result = await client.taskList(workspaceId);
        return okPrint(result, json, formatTaskList);
      }
      case "get": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage("Usage: tent task get <taskPath> [--workspace <path>] [--json]");
        }
        const result = await client.taskGet(workspaceId, taskPath);
        return okPrint(result, json, (r) => formatTaskGet(r));
      }
      case "claim": {
        const taskPath = positionals[0];
        const hasDirectClaimInput = (repeatable["work-node"]?.length ?? 0) > 0 || (repeatable["context-node"]?.length ?? 0) > 0 || Object.prototype.hasOwnProperty.call(flags, "prompt") || Object.prototype.hasOwnProperty.call(flags, "from-task");
        if (taskPath && hasDirectClaimInput) {
          return failUsage(
            "tent task claim: <taskPath> cannot be combined with --work-node, --context-node, --prompt, or --from-task"
          );
        }
        if (taskPath) {
          if (positionals.length > 1) {
            return failUsage(
              "Usage: tent task claim <taskPath> [--workspace <path>] [--json]"
            );
          }
          const result2 = await client.taskClaim(workspaceId, taskPath);
          return okPrint(result2, json, (r) => {
            const row = r;
            return `\u2713 Claimed via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "running"}
` + (row.sessionId ? `sessionId: ${row.sessionId}
` : "");
          });
        }
        if (!hasDirectClaimInput || positionals.length > 0) {
          return failUsage(
            "Usage: tent task claim --work-node <nodeId> [--work-node <nodeId> ...] [--context-node <nodeId> ...] --prompt <text>|- [--from-task <taskPath>] [--workspace <path>] [--json]"
          );
        }
        const rawWorkNodes = repeatable["work-node"] ?? [];
        const rawContextNodes = repeatable["context-node"] ?? [];
        if ([...rawWorkNodes, ...rawContextNodes].some((value) => !String(value ?? "").trim())) {
          return failUsage("tent task claim: every Node value must be a non-empty nodeId");
        }
        const workNodeIds = collectTaskNodeIds(rawWorkNodes);
        const contextNodeIds = collectTaskNodeIds(rawContextNodes);
        if (workNodeIds.length === 0) {
          return failUsage("tent task claim: direct Role claim requires at least one --work-node");
        }
        if (!Object.prototype.hasOwnProperty.call(flags, "prompt")) {
          return failUsage("tent task claim: direct Role claim requires --prompt <text> or --prompt -");
        }
        let prompt = flags.prompt ?? "";
        if (prompt === "-") prompt = await readStdinText();
        if (!prompt.trim()) {
          return failUsage("tent task claim: --prompt must be non-empty");
        }
        const env = globals.env ?? process.env;
        const roleId = String(env.TENT_ROLE_ID ?? "").trim();
        if (!/^rl-[a-z0-9]+$/i.test(roleId)) {
          return failUsage(
            "tent task claim: direct claim requires a canonical durable Role id in TENT_ROLE_ID"
          );
        }
        const sourceSessionId = String(env.TENT_SESSION_ID ?? "").trim();
        const sourceSessionToken = String(env.TENT_SESSION_TOKEN ?? "").trim();
        const nativeSessionContext = String(env.TENT_EXTERNAL_SESSION_KEY ?? "").trim() || String(env.CODEX_THREAD_ID ?? "").trim() || String(env.CLAUDE_SESSION_ID ?? "").trim();
        if ((!sourceSessionId || !sourceSessionToken) && !nativeSessionContext) {
          return failUsage(
            "tent task claim: direct claim requires the current trusted Role Session context"
          );
        }
        const sourceTaskPath = String(flags["from-task"] ?? "").trim() || void 0;
        const result = await client.taskClaimDirect(workspaceId, {
          roleId,
          workNodeIds,
          contextNodeIds,
          prompt,
          sourceTaskPath
        });
        return okPrint(result, json, (r) => {
          const row = r;
          return `\u2713 Created and claimed via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "running"}
` + (row.sessionId ? `sessionId: ${row.sessionId}
` : "");
        });
      }
      case "deliver": {
        const taskPath = positionals[0];
        if (!taskPath) {
          return failUsage(
            "Usage: tent task deliver <taskPath> --summary <text>|- [--commits sha,sha] [--workspace <path>] [--json]"
          );
        }
        if (positionals.length > 1) {
          return failUsage(
            "Usage: tent task deliver <taskPath> --summary <text>|- [--commits sha,sha] [--workspace <path>] [--json]"
          );
        }
        if (!Object.prototype.hasOwnProperty.call(flags, "summary")) {
          return failUsage("tent task deliver requires --summary <text> or --summary -");
        }
        let summary = flags.summary ?? "";
        if (summary === "-") summary = await readStdinText();
        if (!summary.trim()) {
          return failUsage("tent task deliver: --summary must be non-empty");
        }
        const commits = parseCommitsFlag(flags.commits);
        const result = await client.taskDeliver(workspaceId, taskPath, {
          summary,
          commits,
          decision: flags.decision
        });
        return okPrint(result, json, (r) => {
          const row = r;
          return `\u2713 Delivered via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "delivered"}
` + (row.delivery?.id ? `deliveryId: ${row.delivery.id}
` : "") + (row.delivery?.status ? `deliveryStatus: ${row.delivery.status}
` : "") + (row.autoIntegrated != null ? `autoIntegrated: ${row.autoIntegrated}
` : "");
        });
      }
      case "dispatch": {
        const usage2 = "Usage: tent task dispatch --target role:<roleId>|connection:<connectionId> --work-node <nodeId> [--work-node <nodeId> ...] [--context-node <nodeId> ...] --prompt <text>|- [--workspace <path>] [--json]";
        const unknownFlag = findUnknownFlag(flags, DISPATCH_FLAGS);
        if (unknownFlag) {
          return failUsage(`Unknown option --${unknownFlag}
${usage2}`);
        }
        if (positionals.length > 0) {
          return failUsage(
            "Public ordinary dispatch no longer accepts positional <nodeId> <role> grammar; use --target, --work-node, and optional --context-node.\n" + usage2
          );
        }
        const targetRaw = String(flags.target ?? "").trim();
        if (!targetRaw) {
          return failUsage(`--target is required
${usage2}`);
        }
        const targetMatch = /^(role|connection):(.+)$/i.exec(targetRaw);
        if (!targetMatch) {
          return failUsage(
            `--target must be role:<roleId> or connection:<connectionId> (got ${JSON.stringify(targetRaw)})
` + usage2
          );
        }
        const targetKind = targetMatch[1].toLowerCase();
        const targetId = targetMatch[2].trim();
        if (!targetId) {
          return failUsage(
            `--target ${targetKind}: requires a non-empty id
${usage2}`
          );
        }
        const rawWorkNodes = repeatable["work-node"] ?? [];
        const rawContextNodes = repeatable["context-node"] ?? [];
        for (const value of [...rawWorkNodes, ...rawContextNodes]) {
          if (!String(value ?? "").trim()) {
            return failUsage(
              `Every Node value must be a non-empty nodeId (got empty/whitespace)
${usage2}`
            );
          }
        }
        const workNodeIds = collectTaskNodeIds(rawWorkNodes);
        const contextNodeIds = collectTaskNodeIds(rawContextNodes);
        if (workNodeIds.length === 0) {
          return failUsage(
            `At least one --work-node <nodeId> is required in this batch
${usage2}`
          );
        }
        if (!Object.prototype.hasOwnProperty.call(flags, "prompt")) {
          return failUsage(`--prompt is required (<text> or -)
${usage2}`);
        }
        let prompt = flags.prompt ?? "";
        if (prompt === "-") prompt = await readStdinText();
        if (!prompt.trim()) {
          return failUsage("tent task dispatch: --prompt must be non-empty");
        }
        const envRole = String(
          globals.env?.TENT_ROLE_ID ?? globals.env?.TENT_ROLE ?? process.env.TENT_ROLE_ID ?? process.env.TENT_ROLE ?? ""
        ).trim();
        const roleCaller = Boolean(envRole && envRole !== "user");
        const parentActor = roleCaller ? { kind: "role", id: envRole } : { kind: "user", id: "user" };
        const callerKind = roleCaller ? "role" : "user";
        const asSub = roleCaller ? true : void 0;
        const common = {
          workNodeIds,
          contextNodeIds,
          prompt,
          parentActor,
          reviewer: parentActor,
          callerKind,
          ...asSub ? { asSub: true } : {}
        };
        const dispatchArgs = targetKind === "role" ? {
          ...common,
          roleId: targetId
        } : {
          ...common,
          connectionId: targetId
        };
        const result = await client.taskDispatch(workspaceId, dispatchArgs);
        return okPrint(result, json, (r) => formatTaskDispatch(r));
      }
      case "accept": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage(
            "Usage: tent task accept <taskPath> --delivery-id <deliveryId> --actor <user|role> [--outputs id,id] [--workspace <path>] [--json]"
          );
        }
        const actor = flags.actor || flags.by || process.env.TENT_ROLE;
        if (!actor) return failUsage("tent task accept requires --actor <user|role>");
        const deliveryId = flags["delivery-id"];
        if (!deliveryId) return failUsage("tent task accept requires --delivery-id <deliveryId>");
        const outputNodeIds = parseCommitsFlag(flags.outputs) ?? parseCommitsFlag(flags["output-ids"]);
        const result = await client.taskAccept(workspaceId, taskPath, deliveryId, actor, {
          outputNodeIds
        });
        return okPrint(result, json, (r) => {
          const row = r;
          const bound = row.boundOutputIds && row.boundOutputIds.length ? `boundOutputs: ${row.boundOutputIds.join(",")}
` : "";
          return `\u2713 Accepted via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "accepted"}
` + bound;
        });
      }
      case "reject": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage(
            "Usage: tent task reject <taskPath> --delivery-id <deliveryId> --actor <user|role> [--note <text>] [--resume|--no-resume] [--workspace <path>] [--json]"
          );
        }
        const actor = flags.actor || flags.by || process.env.TENT_ROLE;
        if (!actor) return failUsage("tent task reject requires --actor <user|role>");
        const deliveryId = flags["delivery-id"];
        if (!deliveryId) return failUsage("tent task reject requires --delivery-id <deliveryId>");
        const resume = flags.resume === "true" ? true : flags["no-resume"] === "true" ? false : void 0;
        const result = await client.taskReject(workspaceId, taskPath, deliveryId, actor, {
          note: flags.note,
          resume
        });
        return okPrint(result, json, (r) => {
          const row = r;
          return `\u2713 Rejected via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "?"}
`;
        });
      }
      case "cancel": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage("Usage: tent task cancel <taskPath> [--workspace <path>] [--json]");
        }
        const result = await client.taskCancel(workspaceId, taskPath);
        return okPrint(result, json, (r) => {
          const row = r;
          return `\u2713 Cancelled via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "interrupted"}
`;
        });
      }
      case "interrupt": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage("Usage: tent task interrupt <taskPath> [--workspace <path>] [--json]");
        }
        const result = await client.taskInterrupt(workspaceId, taskPath);
        return okPrint(result, json, (r) => {
          const row = r;
          return `\u2713 Interrupted via service RPC
taskPath: ${row.taskPath}
state: ${row.task?.state ?? row.state ?? "interrupted"}
`;
        });
      }
      case "worktree-reclaim": {
        const action = positionals[0];
        const taskPath = positionals[1];
        const usage2 = "Usage: tent task worktree-reclaim <preview|reconcile> <taskPath> [--workspace <path>] [--json]";
        if (action !== "preview" && action !== "reconcile" || !taskPath || positionals.length > 2) {
          return failUsage(usage2);
        }
        const result = action === "preview" ? await client.taskWorktreeReclaimPreview(workspaceId, taskPath) : await client.taskWorktreeReclaimReconcile(
          workspaceId,
          taskPath,
          String(globals.env?.TENT_ROLE ?? process.env.TENT_ROLE ?? "user").trim() || "user"
        );
        return okPrint(
          result,
          json,
          (r) => formatTaskWorktreeReclaim(r, action)
        );
      }
      case "request-decision": {
        const unknown = findUnknownFlag(
          flags,
          /* @__PURE__ */ new Set(["question", "options", ...TASK_COMMON_FLAGS])
        );
        if (unknown) return failUsage(`Unknown option --${unknown} for task request-decision`);
        const taskPath = positionals[0];
        if (!taskPath || positionals.length !== 1) {
          return failUsage(
            "Usage: tent task request-decision <taskPath> --question <text>|- [--options id=label,id=label] [--workspace <path>] [--json]"
          );
        }
        if (!Object.prototype.hasOwnProperty.call(flags, "question")) {
          return failUsage("tent task request-decision requires --question <text> or --question -");
        }
        let question = flags.question ?? "";
        if (question === "-") question = await readStdinText();
        if (!question.trim()) {
          return failUsage("tent task request-decision: --question must be non-empty");
        }
        const options = parseDecisionOptionsFlag(flags.options);
        const result = await client.taskRequestDecision(workspaceId, taskPath, {
          question,
          options
        });
        return okPrint(result, json, (r) => {
          const row = r;
          return `\u2713 Decision Request created via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "waiting"}
` + (row.request?.id ? `requestId: ${row.request.id}
` : "") + (row.request?.status ? `requestStatus: ${row.request.status}
` : "");
        });
      }
      case "decision": {
        const action = positionals[0];
        if (!action || action === "list") {
          const unknown = findUnknownFlag(flags, TASK_COMMON_FLAGS);
          if (unknown) return failUsage(`Unknown option --${unknown} for task decision list`);
          if (positionals.length > 1) {
            return failUsage("Usage: tent task decision list [--workspace <path>] [--json]");
          }
          const result = await client.decisionRequestListPending(workspaceId);
          return okPrint(result, json, (r) => formatDecisionRequestList(r));
        }
        if (action === "get") {
          const unknown = findUnknownFlag(flags, TASK_COMMON_FLAGS);
          if (unknown) return failUsage(`Unknown option --${unknown} for task decision get`);
          const taskPath = positionals[1];
          const requestId = positionals[2];
          if (!taskPath || !requestId || positionals.length !== 3) {
            return failUsage(
              "Usage: tent task decision get <taskPath> <requestId> [--workspace <path>] [--json]"
            );
          }
          const result = await client.decisionRequestGet(workspaceId, taskPath, requestId);
          return okPrint(result, json, (r) => formatDecisionRequestGet(r));
        }
        if (action === "respond") {
          const unknown = findUnknownFlag(
            flags,
            /* @__PURE__ */ new Set(["option", "text", "deny", ...TASK_COMMON_FLAGS])
          );
          if (unknown) return failUsage(`Unknown option --${unknown} for task decision respond`);
          const taskPath = positionals[1];
          const requestId = positionals[2];
          if (!taskPath || !requestId || positionals.length !== 3) {
            return failUsage(
              "Usage: tent task decision respond <taskPath> <requestId> (--option <id> | --text <text>|- | --deny) [--workspace <path>] [--json]"
            );
          }
          let text = flags.text;
          if (text === "-") text = await readStdinText();
          const optionId = flags.option;
          const deny = flags.deny === "true" || flags.deny === "1" || flags.deny === "yes";
          const selected = Number(Boolean(optionId?.trim())) + Number(Boolean(text?.trim())) + Number(deny);
          if (selected !== 1) {
            return failUsage(
              "tent task decision respond requires exactly one of --option, --text, or --deny"
            );
          }
          const response = optionId?.trim() ? { kind: "option", optionId: optionId.trim() } : text?.trim() ? { kind: "custom", text } : { kind: "deny" };
          const result = await client.decisionRequestRespond(
            workspaceId,
            taskPath,
            requestId,
            response
          );
          return okPrint(result, json, (r) => {
            const row = r;
            return `\u2713 Decision Request answered via service RPC
` + (row.request?.id ? `requestId: ${row.request.id}
` : "") + (row.request?.status ? `requestStatus: ${row.request.status}
` : "") + (row.state ? `taskState: ${row.state}
` : "") + (row.enqueued != null ? `enqueued: ${row.enqueued}
` : "");
          });
        }
        if (action === "escalate") {
          const unknown = findUnknownFlag(flags, TASK_COMMON_FLAGS);
          if (unknown) return failUsage(`Unknown option --${unknown} for task decision escalate`);
          const taskPath = positionals[1];
          const requestId = positionals[2];
          if (!taskPath || !requestId || positionals.length !== 3) {
            return failUsage(
              "Usage: tent task decision escalate <taskPath> <requestId> [--workspace <path>] [--json]"
            );
          }
          const result = await client.decisionRequestEscalate(
            workspaceId,
            taskPath,
            requestId
          );
          return okPrint(result, json, (r) => {
            const row = r;
            return `\u2713 Decision Request escalated to user
` + (row.request?.id ? `requestId: ${row.request.id}
` : "");
          });
        }
        return failUsage(
          "Usage: tent task decision list|get|respond|escalate \u2026\n" + taskHelpText()
        );
      }
      case "send-input":
      case "sendInput": {
        const taskPath = positionals[0];
        if (!taskPath) {
          return failUsage(
            "Usage: tent task send-input <taskPath> [--text <text>|-] [--refs id,id] [--workspace <path>] [--json]"
          );
        }
        let text = flags.text;
        if (text === "-") text = await readStdinText();
        const contextRefs = parseRefsFlag(
          flags.refs || flags["context-refs"] || flags.contextRefs
        );
        if (!(text?.trim() || contextRefs && contextRefs.length > 0)) {
          return failUsage(
            "tent task send-input requires --text and/or --refs (stable entity ids)"
          );
        }
        const result = await client.taskSendInput(workspaceId, taskPath, {
          text,
          contextRefs,
          actor: flags.actor || "user"
        });
        return okPrint(result, json, (r) => {
          const row = r;
          return `\u2713 TaskInput accepted via service RPC
taskPath: ${row.taskPath ?? taskPath}
` + (row.state ? `state: ${row.state}
` : "") + (row.input?.id ? `inputId: ${row.input.id}
` : "") + (row.input?.status ? `inputStatus: ${row.input.status}
` : "") + (row.accepted != null ? `accepted: ${row.accepted}
` : "") + (row.enqueued != null ? `enqueued: ${row.enqueued}
` : "") + (row.continued != null ? `continued: ${row.continued}
` : "") + (row.continueError ? `continueError: ${row.continueError}
` : "");
        });
      }
      case "task-input":
      case "taskInput": {
        const action = positionals[0];
        if (!action || action === "list") {
          const taskPathFilter = flags.task || flags["task-path"] || flags.taskPath || positionals[1];
          if (!taskPathFilter) {
            return failUsage(
              "Usage: tent task task-input list <taskPath> | --task <taskPath> [--workspace <path>] [--json]"
            );
          }
          const result = await client.taskInputListPending(
            workspaceId,
            taskPathFilter
          );
          return okPrint(result, json, (r) => formatTaskInputList(r));
        }
        if (action === "get") {
          const inputId = positionals[1];
          const taskPathFilter = flags.task || flags["task-path"] || flags.taskPath;
          if (!inputId || !taskPathFilter) {
            return failUsage(
              "Usage: tent task task-input get <inputId> --task <taskPath> [--workspace <path>] [--json]"
            );
          }
          const result = await client.taskInputGet(
            workspaceId,
            taskPathFilter,
            inputId
          );
          return okPrint(result, json, (r) => formatTaskInputGet(r));
        }
        if (action === "ack") {
          const inputId = positionals[1];
          const taskPathFilter = flags.task || flags["task-path"] || flags.taskPath;
          if (!inputId || !taskPathFilter) {
            return failUsage(
              "Usage: tent task task-input ack <inputId> --task <taskPath> [--actor <role|sessionId>] [--workspace <path>] [--json]"
            );
          }
          const result = await client.taskInputAck(
            workspaceId,
            taskPathFilter,
            inputId,
            flags.actor
          );
          return okPrint(result, json, (r) => {
            const row = r;
            return `\u2713 TaskInput acked via service RPC
` + (row.input?.id ? `inputId: ${row.input.id}
` : "") + (row.input?.status ? `status: ${row.input.status}
` : "") + (row.input?.taskPath ? `taskPath: ${row.input.taskPath}
` : "");
          });
        }
        return failUsage(
          "Usage: tent task task-input list|get|ack \u2026\n" + taskHelpText()
        );
      }
      case "help":
      case "--help":
      case "-h":
        return { exitCode: 0, stdout: taskHelpText(), stderr: "" };
      default:
        return failUsage(
          `Unknown task subcommand: ${sub || "(empty)"}
` + taskHelpText()
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}
function formatTaskDispatch(result) {
  const row = result;
  const nested = row.session && "session" in row.session ? row.session.session : void 0;
  const sessionView = nested ?? row.session ?? void 0;
  const sessionId = sessionView && (sessionView.sessionId || sessionView.id) ? String(sessionView.sessionId || sessionView.id) : void 0;
  const sessionState = sessionView?.state ? String(sessionView.state) : void 0;
  const sessionConnectionId = sessionView?.connectionId ? String(sessionView.connectionId) : void 0;
  const parentLabel = row.parentActor?.kind && row.parentActor?.id ? `${row.parentActor.kind}:${row.parentActor.id}` : void 0;
  const reviewerLabel = row.reviewer?.kind && row.reviewer?.id ? `${row.reviewer.kind}:${row.reviewer.id}` : void 0;
  return `\u2713 Dispatched via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "queued"}
` + (row.roleId ? `roleId: ${row.roleId}
` : "") + (parentLabel ? `parentActor: ${parentLabel}
` : "") + (reviewerLabel ? `reviewer: ${reviewerLabel}
` : "") + (sessionId ? `sessionId: ${sessionId}
` : "") + (sessionState ? `sessionState: ${sessionState}
` : "") + (sessionConnectionId ? `sessionConnectionId: ${sessionConnectionId}
` : "") + (row.relayPrompt ? `
--- Relay prompt ---
${row.relayPrompt}` : "");
}
function formatTaskList(result) {
  const row = result;
  const tasks = row.tasks ?? [];
  if (tasks.length === 0) {
    return `workspaceId: ${row.workspaceId ?? "?"}
tasks: (none)
`;
  }
  const lines = [`workspaceId: ${row.workspaceId ?? "?"}`, `tasks: ${tasks.length}`, ""];
  for (const t of tasks) {
    lines.push(
      `- ${t.path ?? t.id ?? "?"}	state=${t.state ?? t.status ?? "?"}` + (t.roleId ? `	role=${t.roleId}` : "") + `	work=${(t.workNodeIds ?? []).join(",") || "-"}	context=${(t.contextNodeIds ?? []).join(",") || "-"}` + (t.sessionId ? `	session=${t.sessionId}` : "")
    );
  }
  return lines.join("\n") + "\n";
}
function formatTaskGet(result) {
  const t = result.task;
  const lines = [
    `path: ${t.path ?? "?"}`,
    `id: ${t.id ?? "?"}`,
    `roleId: ${t.roleId ?? "-"}`,
    `state: ${t.state ?? t.status ?? "?"}`,
    `status: ${t.status ?? "?"}`,
    `workNodeIds: ${(t.workNodeIds ?? []).join(", ") || "-"}`,
    `contextNodeIds: ${(t.contextNodeIds ?? []).join(", ") || "-"}`
  ];
  if (t.sessionId) lines.push(`sessionId: ${t.sessionId}`);
  if (t.prompt) {
    lines.push("", "--- prompt ---", t.prompt.trimEnd());
  }
  return lines.join("\n") + "\n";
}
function formatTaskWorktreeReclaim(result, action) {
  const row = result;
  return `\u2713 Task worktree reclaim ${action}
taskPath: ${row.taskPath ?? "?"}
` + (row.taskId ? `taskId: ${row.taskId}
` : "") + `code: ${row.code ?? "?"}
` + (row.eligible != null ? `eligible: ${row.eligible}
` : "") + (row.reclaimed != null ? `reclaimed: ${row.reclaimed}
` : "") + (row.alreadyGone != null ? `alreadyGone: ${row.alreadyGone}
` : "") + (row.worktree ? `worktree: ${row.worktree}
` : "") + (row.reason ? `reason: ${row.reason}
` : "");
}
function okPrint(result, json, human) {
  const stdout = json ? JSON.stringify(result, null, 2) + "\n" : human(result);
  return { exitCode: 0, stdout, stderr: "" };
}
function failUsage(msg) {
  return { exitCode: 1, stdout: "", stderr: msg + "\n" };
}
function parseCommitsFlag(raw) {
  if (raw === void 0) return void 0;
  const commits = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return commits;
}
function parseDecisionOptionsFlag(raw) {
  if (raw === void 0 || !raw.trim()) return void 0;
  const choices = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid --options entry (expected id=label): ${trimmed}`);
    }
    const id = trimmed.slice(0, eq).trim();
    const label = trimmed.slice(eq + 1).trim();
    if (!id || !label) {
      throw new Error(`Invalid --options entry (empty id/label): ${trimmed}`);
    }
    choices.push({ id, label });
  }
  return choices.length ? choices : void 0;
}
function parseRefsFlag(raw) {
  if (raw === void 0 || !raw.trim()) return void 0;
  const refs = [];
  const seen = /* @__PURE__ */ new Set();
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    refs.push(id);
  }
  return refs.length ? refs : void 0;
}
function formatDecisionRequestList(result) {
  const row = result;
  const requests = row.requests ?? [];
  if (requests.length === 0) return "decisionRequests: (none)\n";
  const lines = [`decisionRequests: ${requests.length}`, ""];
  for (const a of requests) {
    lines.push(
      `- ${a.id ?? "?"}	task=${a.taskPath ?? "?"}	status=${a.status ?? "?"}	q=${(a.question ?? "").slice(0, 80)}`
    );
  }
  return lines.join("\n") + "\n";
}
function formatDecisionRequestGet(result) {
  const row = result;
  const a = row.request ?? {};
  const lines = [
    `id: ${a.id ?? "?"}`,
    `taskPath: ${a.taskPath ?? "?"}`,
    `status: ${a.status ?? "?"}`,
    `question: ${a.question ?? ""}`
  ];
  if (a.target) lines.push(`target: ${a.target.kind ?? "?"}:${a.target.id ?? "?"}`);
  if (a.response?.kind) lines.push(`response: ${a.response.kind}`);
  if (a.response?.optionId) lines.push(`optionId: ${a.response.optionId}`);
  if (a.response?.text) lines.push(`text: ${a.response.text}`);
  if (a.options?.length) {
    lines.push("options:");
    for (const c of a.options) lines.push(`  - ${c.id}=${c.label}`);
  }
  return lines.join("\n") + "\n";
}
function formatTaskInputList(result) {
  const row = result;
  const inputs = row.inputs ?? [];
  if (inputs.length === 0) return "inputs: (none)\n";
  const lines = [`inputs: ${inputs.length}`, ""];
  for (const i of inputs) {
    const preview = (i.text ?? "").slice(0, 60) || (i.contextRefs?.length ? `refs=${i.contextRefs.join(",")}` : "");
    lines.push(
      `- ${i.id ?? "?"}	task=${i.taskPath ?? "?"}	status=${i.status ?? "?"}` + (i.uncertainAt ? `	uncertainAt=${i.uncertainAt}` : "") + (i.lastError ? `	error=${i.lastError.slice(0, 80)}` : "") + (preview ? `	${preview}` : "")
    );
  }
  return lines.join("\n") + "\n";
}
function formatTaskInputGet(result) {
  const row = result;
  const i = row.input ?? {};
  const lines = [
    `id: ${i.id ?? "?"}`,
    `workspaceId: ${i.workspaceId ?? "?"}`,
    `taskPath: ${i.taskPath ?? "?"}`,
    `status: ${i.status ?? "?"}`
  ];
  if (i.text) lines.push(`text: ${i.text}`);
  if (i.contextRefs?.length) lines.push(`contextRefs: ${i.contextRefs.join(", ")}`);
  if (i.deliveredAt) lines.push(`deliveredAt: ${i.deliveredAt}`);
  if (i.consumedAt) lines.push(`consumedAt: ${i.consumedAt}`);
  if (i.cancelledAt) lines.push(`cancelledAt: ${i.cancelledAt}`);
  return lines.join("\n") + "\n";
}
var BOOLEAN_FLAGS = /* @__PURE__ */ new Set([
  "json",
  "attach-only",
  "resume",
  "no-resume",
  "yes",
  "as-sub",
  "deny"
]);
var REPEATABLE_FLAGS = /* @__PURE__ */ new Set(["work-node", "context-node"]);
var DISPATCH_FLAGS = /* @__PURE__ */ new Set([
  "target",
  "work-node",
  "context-node",
  "prompt",
  "workspace",
  "json",
  "data-dir",
  "attach-only",
  "service-entry"
]);
var TASK_COMMON_FLAGS = /* @__PURE__ */ new Set([
  "workspace",
  "json",
  "data-dir",
  "attach-only",
  "service-entry"
]);
function findUnknownFlag(flags, allowed) {
  for (const name of Object.keys(flags)) {
    if (!allowed.has(name)) return name;
  }
  return null;
}
function collectTaskNodeIds(raw) {
  const nodes = [];
  const seen = /* @__PURE__ */ new Set();
  for (const value of raw ?? []) {
    const id = String(value ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    nodes.push(id);
  }
  return nodes;
}
function parseTaskFlags(args) {
  const positionals = [];
  const flags = {};
  const repeatable = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = "true";
      } else if (REPEATABLE_FLAGS.has(name)) {
        const value = args[i + 1] ?? "";
        i++;
        if (!repeatable[name]) repeatable[name] = [];
        repeatable[name].push(value);
        flags[name] = value;
      } else {
        flags[name] = args[i + 1] ?? "";
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags, repeatable };
}
function readStdinText() {
  return new Promise((resolve10, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve10(data));
    process.stdin.on("error", reject);
  });
}
function taskHelpText() {
  return `tent task \u2014 collaboration lifecycle via Local Service (RPC)

New-architecture path: attach \u2192 mount workspace \u2192 task.* RPC.
Local Service is the sole mutation entry; CLI does not kill the service on exit.

Commands:
  tent task list [--workspace <path>] [--json]
  tent task get <taskPath> [--workspace <path>] [--json]
  tent task claim <taskPath> [--workspace <path>] [--json]
  tent task claim --work-node <nodeId> [--work-node <nodeId> ...] [--context-node <nodeId> ...] --prompt <text>|- [--from-task <taskPath>] [--workspace <path>] [--json]
      # direct Role execution: create + claim atomically; no --target and no downstream dispatch
      # Role comes from TENT_ROLE_NAME/TENT_ROLE; Service derives parent/reviewer from durable facts
  tent task deliver <taskPath> --summary <text>|- [--commits sha,sha] [--workspace <path>] [--json]
  tent task dispatch --target role:<roleId>|connection:<connectionId> --work-node <nodeId> [--work-node <nodeId> ...] [--context-node <nodeId> ...] --prompt <text>|- [--workspace <path>] [--json]
      # --target role:*  durable Role handoff (queued; never starts managed ACP at dispatch)
      # --target connection:* machine Settings Connection + exact managed Session
      # --work-node      repeatable writable Nodes (at least one; exact occupation)
      # --context-node   repeatable shared read-only context Nodes
      # parentActor/reviewer derive from the durable Role or local user boundary
      # Any flag outside this command's canonical grammar is rejected
  tent task accept <taskPath> --delivery-id <deliveryId> --actor <user|role> [--outputs id,id] [--workspace <path>] [--json]
  tent task reject <taskPath> --delivery-id <deliveryId> --actor <user|role> [--note <text>] [--resume|--no-resume] [--workspace <path>] [--json]
  tent task cancel <taskPath> [--workspace <path>] [--json]
  tent task interrupt <taskPath> [--workspace <path>] [--json]
  tent task worktree-reclaim preview <taskPath> [--workspace <path>] [--json]
  tent task worktree-reclaim reconcile <taskPath> [--workspace <path>] [--json]
  tent task request-decision <taskPath> --question <text>|- [--options id=label,\u2026] [--workspace <path>] [--json]
  tent task decision list|get|respond|escalate [\u2026] [--workspace <path>] [--json]
  tent task send-input <taskPath> [--text <text>|-] [--refs id,id] [--workspace <path>] [--json]
  tent task task-input list <taskPath>|get <inputId>|ack <inputId> --task <taskPath> [--actor <role|sessionId>] [--workspace <path>] [--json]

Service options:
  --data-dir <path>       Machine-local service data area (default: %APPDATA%/Tent)
  --attach-only           Fail if no healthy service (do not bootstrap)
  --service-entry <path>  Path to service.mjs when bootstrapping

Task mutations are Local Service RPC only. Formal delivery is Delivery-only
via tent task deliver (no direct-core or report compatibility path).
Derived role-init remains available because it regenerates bootstrap context only.
`;
}

// src/cli/session-rpc.ts
async function runSessionCommand(sub, args, globals = {}) {
  const normalized = normalizeSessionSub(sub);
  if (!normalized) {
    return failUsage2(
      `Unknown session subcommand: ${sub || "(empty)"}
` + sessionHelpText()
    );
  }
  const hookAlias = isHookAlias(sub);
  try {
    const { positionals, flags } = parseSessionFlags(args);
    const json = globals.json === true || flags.json === "true";
    const silent = globals.silentOutsideTent === true || flags.silent === "true" || flags["silent-outside"] === "true";
    const hookMeta = hookAlias ? await loadHookMeta(flags, globals) : { stdin: null, host: void 0 };
    const cwd = pathResolve(globals.cwd) || pathResolve(
      typeof hookMeta.stdin?.cwd === "string" ? hookMeta.stdin.cwd : void 0
    ) || pathResolve(
      typeof hookMeta.stdin?.workspace === "string" ? hookMeta.stdin.workspace : void 0
    ) || pathResolve(
      typeof hookMeta.stdin?.workspace_root === "string" ? hookMeta.stdin.workspace_root : void 0
    ) || pathResolve(
      typeof hookMeta.stdin?.workspaceRoot === "string" ? hookMeta.stdin.workspaceRoot : void 0
    );
    const workspaceFlag = flags.workspace || globals.workspace || (typeof hookMeta.stdin?.workspace === "string" ? hookMeta.stdin.workspace : void 0) || (typeof hookMeta.stdin?.workspace_root === "string" ? hookMeta.stdin.workspace_root : void 0) || (typeof hookMeta.stdin?.workspaceRoot === "string" ? hookMeta.stdin.workspaceRoot : void 0);
    const tentProbe = await probeTentPresence({
      cwd,
      workspace: workspaceFlag
    });
    if (!tentProbe.ok) {
      if (silent || hookAlias) {
        return silentOutsideResult(normalized, json);
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: tentProbe.message + "\n"
      };
    }
    const attachOpts = {
      dataDir: flags["data-dir"] || globals.dataDir,
      attachOnly: globals.attachOnly === true || flags["attach-only"] === "true",
      serviceEntry: flags["service-entry"] || globals.serviceEntry,
      packageRoot: globals.packageRoot,
      env: globals.env
    };
    const client = globals.client ?? (await attachOrBootstrapService(attachOpts)).client;
    const ctx = await ensureMountedWorkspace(client, {
      cwd,
      workspace: workspaceFlag
    });
    const workspaceId = ctx.workspaceId;
    const explicitKey = flags.key || flags["external-key"] || flags.externalKey || flags.external;
    const host = flags.host || flags.agent || hookMeta.host || process.env.TENT_HOOK_HOST || process.env.TENT_AGENT_HOST;
    const nativeSessionId = pickNativeSessionId(hookMeta.stdin, flags);
    const derivedKey = hookAlias ? buildHookExternalKey({
      host,
      nativeSessionId,
      workspaceRoot: ctx.workspaceRoot,
      workspaceId
    }) : void 0;
    const externalKey = explicitKey || derivedKey;
    switch (normalized) {
      case "enter": {
        if (positionals.length > 0) {
          return failUsage2(
            "Usage: tent session enter [--session <ss-\u2026>] [--role-id <rl-\u2026>] [--key <externalKey>] [--host <agent>] [--task <taskId>] [--json]"
          );
        }
        if (hookAlias && !externalKey) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "session-start requires --host <host> (or native session id + host) to form a stable externalKey; refusing to create an orphan host binding\n"
          };
        }
        const sessionId = flags.session || flags["session-id"] || flags.sessionId;
        const tentSessionId = sessionId && isTentSessionId(sessionId) ? sessionId : void 0;
        const roleId = flags["role-id"] || flags.roleId || process.env.TENT_ROLE_ID;
        const lastTaskId = flags.task || flags["task-id"] || flags.taskId || flags["last-task-id"];
        const result = await client.call("session.enter", {
          workspaceId,
          sessionId: tentSessionId,
          roleId,
          externalKey,
          lastTaskId,
          cwd: ctx.workspaceRoot
        });
        return okPrint2(result, json, (r) => formatEnter(r));
      }
      case "status": {
        if (positionals.length > 1) {
          return failUsage2(
            "Usage: tent session status [sessionId] [--key <externalKey>] [--host <agent>] [--workspace <path>] [--json]"
          );
        }
        const sessionIdPos = positionals[0] || flags.session || flags["session-id"] || flags.sessionId;
        const tentSessionId = sessionIdPos && isTentSessionId(sessionIdPos) ? sessionIdPos : void 0;
        const keyFromPos = sessionIdPos && !isTentSessionId(sessionIdPos) ? sessionIdPos : void 0;
        const result = await client.sessionStatus({
          workspaceId,
          sessionId: tentSessionId,
          externalKey: explicitKey || keyFromPos || derivedKey
        });
        return okPrint2(result, json, (r) => formatStatus(r));
      }
      case "leave": {
        const sessionIdPos = positionals[0] || flags.session || flags["session-id"] || flags.sessionId;
        const tentSessionId = sessionIdPos && isTentSessionId(sessionIdPos) ? sessionIdPos : void 0;
        const keyFromPos = sessionIdPos && !isTentSessionId(sessionIdPos) ? sessionIdPos : void 0;
        const leaveKey = explicitKey || keyFromPos || derivedKey;
        if (!tentSessionId && !leaveKey) {
          if (hookAlias) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "session-end requires --host <agent> (with native stdin session id or workspace fallback) or --key <externalKey>; cannot leave without a stable identity\n"
            };
          }
          return failUsage2(
            "Usage: tent session leave [<sessionId>] [--key <externalKey>] [--host <agent>] [--workspace <path>] [--json]"
          );
        }
        const result = await client.sessionLeave({
          sessionId: tentSessionId,
          externalKey: leaveKey,
          workspaceId
        });
        return okPrint2(result, json, (r) => formatLeave(r));
      }
      default:
        return failUsage2(sessionHelpText());
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (hookAlias && /Not inside a Tent/i.test(message)) {
      return silentOutsideResult("status", globals.json === true);
    }
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}
function sessionHelpText() {
  return `tent session \u2014 host integration binding (Local Service RPC)

Usage:
  tent session enter   [--session <ss-\u2026>] [--role-id <rl-\u2026>] [--key <externalKey>]
                       [--host <agent>] [--task <taskId>] [--json]
  tent session status  [sessionId|externalKey] [--key <externalKey>] [--json]
  tent session leave   [sessionId|externalKey] [--key <externalKey>] [--json]

Semantics:
  enter   Register or reuse the host's SessionRegistry binding.
          Does not start ACP or any provider process. Idempotent.
  status  Probe session + list incomplete (active) tasks bound to it.
  leave   End the host binding only. Never deliver or accept.
          Reports incompleteTasks still open for the caller to handle.

Hook aliases (host integration contract):
  tent session session-start --host <agent>   \u2192 enter via stable externalKey
  tent session session-end   --host <agent>   \u2192 leave via same externalKey
  tent session session-status --host <agent>  \u2192 status via same externalKey

  Reads native hook stdin JSON when present (session_id / sessionId / cwd /
  workspace). externalKey = host + ":" + nativeSessionId, or host + ":ws:" +
  workspaceRoot when no native id (explicit, testable fallback \u2014 not silent orphans).
  Outside a Tent workspace: silent exit 0. Inside a real Tent: other errors fail loud.

Common flags:
  --workspace <path>   Workspace root (default: resolve from cwd / stdin)
  --host <host>        Host integration name used in the stable externalKey
  --key <externalKey>  Explicit externalKey (overrides derived)
  --data-dir <path>    Service data area override
  --attach-only        Do not bootstrap Local Service
  --json               Machine-readable result
`;
}
function normalizeSessionSub(sub) {
  const s = (sub || "").trim().toLowerCase();
  if (s === "enter" || s === "session-start" || s === "sessionstart" || s === "start") {
    return "enter";
  }
  if (s === "status" || s === "session-status" || s === "sessionstatus") {
    return "status";
  }
  if (s === "leave" || s === "session-end" || s === "sessionend" || s === "end") {
    return "leave";
  }
  return null;
}
function isHookAlias(sub) {
  const s = (sub || "").trim().toLowerCase();
  return s === "session-start" || s === "sessionstart" || s === "session-status" || s === "sessionstatus" || s === "session-end" || s === "sessionend";
}
function buildHookExternalKey(opts) {
  const host = normalizeHostToken(opts.host);
  if (!host) return void 0;
  const native = (opts.nativeSessionId || "").trim();
  if (native) {
    return `${host}:${native}`;
  }
  const ws = (opts.workspaceRoot || "").trim() || (opts.workspaceId || "").trim();
  if (!ws) return void 0;
  return `${host}:ws:${normalizeWorkspaceToken(ws)}`;
}
function parseNativeHookStdin(text) {
  if (text == null) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function pickNativeSessionId(stdin, flags = {}) {
  const fromFlags = flags["native-session"] || flags.nativeSession || flags["provider-session"] || flags.providerSession;
  if (fromFlags && fromFlags.trim()) return fromFlags.trim();
  if (!stdin) return void 0;
  const candidates = [
    stdin.session_id,
    stdin.sessionId,
    stdin.SESSION_ID,
    stdin.sessionID
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return void 0;
}
function normalizeHostToken(host) {
  const h = (host || "").trim().toLowerCase();
  if (!h) return void 0;
  return h.replace(/[^a-z0-9._+-]+/g, "-").replace(/^-+|-+$/g, "") || void 0;
}
function normalizeWorkspaceToken(ws) {
  return ws.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function isTentSessionId(id) {
  return id.startsWith("ss-") && id.length > 3;
}
async function loadHookMeta(flags, globals) {
  const host = flags.host || flags.agent || process.env.TENT_HOOK_HOST || process.env.TENT_AGENT_HOST;
  let text = globals.stdinText;
  if (text === void 0 && !globals.skipStdin) {
    text = await readStdinIfAny();
  }
  return { stdin: parseNativeHookStdin(text), host };
}
function readStdinIfAny() {
  return new Promise((resolve10, reject) => {
    if (process.stdin.isTTY) {
      resolve10("");
      return;
    }
    let data = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve10(value);
    };
    const timer = setTimeout(() => done(data), 500);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      done(data);
    });
    process.stdin.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (process.stdin.readableEnded) {
      clearTimeout(timer);
      done(data);
    }
  });
}
async function probeTentPresence(options) {
  try {
    await resolveWorkspacePaths({
      cwd: options.cwd,
      workspace: options.workspace
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!options.workspace) {
      const systemRoot = await findTentSystemRoot(options.cwd || process.cwd());
      if (!systemRoot) {
        return { ok: false, message: NOT_INSIDE_TENT_MESSAGE };
      }
    }
    return { ok: false, message };
  }
}
function silentOutsideResult(kind, json) {
  const payload = kind === "enter" ? { skipped: true, reason: "not-a-tent-workspace", session: null } : kind === "status" ? {
    skipped: true,
    reason: "not-a-tent-workspace",
    sessions: [],
    incompleteTasks: []
  } : {
    skipped: true,
    reason: "not-a-tent-workspace",
    left: false,
    alreadyLeft: true,
    incompleteTasks: [],
    delivered: false,
    accepted: false
  };
  if (json) {
    return { exitCode: 0, stdout: JSON.stringify(payload) + "\n", stderr: "" };
  }
  return { exitCode: 0, stdout: "", stderr: "" };
}
function formatEnter(result) {
  const row = result;
  const s = row.session ?? {};
  return `\u2713 Host session binding entered
sessionId: ${s.sessionId ?? "?"}
state: ${s.state ?? "external"}
` + (s.externalKey ? `externalKey: ${s.externalKey}
` : "") + (s.roleId ? `roleId: ${s.roleId}
` : "") + (s.connectionId ? `connectionId: ${s.connectionId}
` : "") + (row.reused != null ? `reused: ${row.reused}
` : "");
}
function formatStatus(result) {
  const row = result;
  const lines = [];
  if (row.session) {
    const s = row.session;
    lines.push(
      `sessionId: ${s.sessionId ?? "?"}`,
      `state: ${s.state ?? "?"}`,
      `alive: ${s.alive ?? false}`,
      ...s.externalKey ? [`externalKey: ${s.externalKey}`] : [],
      ...s.connectionId ? [`connectionId: ${s.connectionId}`] : [],
      ...s.roleId ? [`roleId: ${s.roleId}`] : [],
      ...s.lastTaskId ? [`lastTaskId: ${s.lastTaskId}`] : [],
      ...row.open != null ? [`open: ${row.open}`] : []
    );
  } else if (row.sessions) {
    lines.push(`externalSessions: ${row.sessions.length}`);
    for (const s of row.sessions) {
      lines.push(
        `- ${s.sessionId ?? "?"} state=${s.state ?? "?"}` + (s.externalKey ? ` key=${s.externalKey}` : "") + (s.connectionId ? ` connection=${s.connectionId}` : "") + (s.roleId ? ` roleId=${s.roleId}` : "")
      );
    }
  }
  const tasks = row.incompleteTasks ?? [];
  lines.push("", `incompleteTasks: ${tasks.length}`);
  for (const t of tasks) {
    lines.push(
      `- ${t.path ?? t.id ?? "?"} state=${t.state ?? "?"}` + (t.roleId ? ` role=${t.roleId}` : "") + (t.sessionId ? ` session=${t.sessionId}` : "")
    );
  }
  return lines.join("\n") + "\n";
}
function formatLeave(result) {
  const row = result;
  const tasks = row.incompleteTasks ?? [];
  const lines = [
    `\u2713 Host session binding left`,
    `sessionId: ${row.sessionId ?? "?"}`,
    ...row.externalKey ? [`externalKey: ${row.externalKey}`] : [],
    `state: ${row.state ?? "stopped"}`,
    `left: ${row.left ?? false}`,
    ...row.alreadyLeft ? [`alreadyLeft: true`] : [],
    `delivered: ${row.delivered ?? false}`,
    `accepted: ${row.accepted ?? false}`,
    "",
    `incompleteTasks: ${tasks.length}`
  ];
  for (const t of tasks) {
    lines.push(
      `- ${t.path ?? "?"} state=${t.state ?? "?"}` + (t.roleId ? ` role=${t.roleId}` : "") + (t.sessionId ? ` session=${t.sessionId}` : "")
    );
  }
  if (tasks.length > 0) {
    lines.push(
      "",
      "Note: leave did not deliver/accept. Finish incomplete tasks with tent task deliver / accept as needed."
    );
  }
  return lines.join("\n") + "\n";
}
function okPrint2(result, json, human) {
  const stdout = json ? JSON.stringify(result, null, 2) + "\n" : human(result);
  return { exitCode: 0, stdout, stderr: "" };
}
function failUsage2(msg) {
  return { exitCode: 1, stdout: "", stderr: msg + "\n" };
}
function pathResolve(cwd) {
  if (!cwd) return void 0;
  return cwd;
}
function parseSessionFlags(args) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== void 0 && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
      continue;
    }
    positionals.push(a);
  }
  return { positionals, flags };
}

// src/cli/node-rpc.ts
async function runNodeCommand(sub, args, globals = {}) {
  try {
    const { positionals, flags } = parseFlags(args);
    const json = globals.json === true || flags.json === "true";
    const attachOpts = {
      dataDir: flags["data-dir"] || globals.dataDir,
      attachOnly: globals.attachOnly === true || flags["attach-only"] === "true",
      serviceEntry: flags["service-entry"] || globals.serviceEntry,
      packageRoot: globals.packageRoot,
      env: globals.env
    };
    const client = globals.client ?? (await attachOrBootstrapService(attachOpts)).client;
    const mounted = await ensureMountedWorkspace(client, {
      cwd: globals.cwd,
      workspace: flags.workspace || globals.workspace
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
          "tent node create <name> [--type goal|prompt|output[-secondary]] [--parent <nodeId|root>] [--body <text>|-] [--tags a,b] [--json]"
        );
        if (typeof name !== "string") return name;
        let body = flagValue(flags, "body");
        if (body === "-") body = await readStdin();
        const parentPath = await resolveParentPath(client, workspaceId, flags.parent);
        const created = await client.docsCreateNote(workspaceId, {
          name,
          type: flags.type || "prompt",
          parentPath,
          ...body !== void 0 ? { body } : {}
        });
        const tags = parseCsv(flags.tags);
        if (tags.length > 0) {
          for (const tag of tags) await client.registryTagCreate(workspaceId, { name: tag });
          const edit = await client.docsReadForEdit(workspaceId, created.nodeId);
          await client.docsTagsSet(workspaceId, {
            nodeId: created.nodeId,
            tags,
            baseEtag: edit.etag
          });
        }
        const result = await client.docsGet(workspaceId, created.nodeId);
        return print(result, json, (value) => `Created ${formatNode(value)}`);
      }
      case "write": {
        const target = oneTarget(positionals, "tent node write <nodeId> --body <text>|- [--json]");
        if (typeof target !== "string") return target;
        let body = flagValue(flags, "body");
        if (body === void 0) return usage("tent node write <nodeId> --body <text>|- [--json]");
        if (body === "-") body = await readStdin();
        const ref = nodeRef(target);
        const edit = await client.docsReadForEdit(workspaceId, ref);
        const result = await client.docsWrite(workspaceId, {
          nodeId: ref,
          body,
          baseEtag: edit.etag
        });
        return print(result, json, () => `Updated ${edit.nodeId} ${edit.path}`);
      }
      case "rename": {
        if (positionals.length !== 2) return usage("tent node rename <nodeId> <new-name> [--json]");
        const result = await client.docsRename(workspaceId, {
          nodeId: nodeRef(positionals[0]),
          newName: positionals[1]
        });
        return print(result, json, (value) => `Renamed ${formatNode(value)}`);
      }
      case "move": {
        const target = oneTarget(positionals, "tent node move <nodeId> --parent <nodeId|root> [--json]");
        if (typeof target !== "string" || !/^cx-[a-z0-9]+$/i.test(target)) {
          return typeof target === "string" ? usage("tent node move requires a stable cx- id") : target;
        }
        if (!Object.prototype.hasOwnProperty.call(flags, "parent")) {
          return usage("tent node move <nodeId> --parent <nodeId|root> [--json]");
        }
        const current = await client.docsGet(workspaceId, target);
        const parent = flags.parent;
        const newParentId = !parent || parent === "root" ? null : parent;
        if (newParentId && !/^cx-[a-z0-9]+$/i.test(newParentId)) {
          return usage("tent node move --parent must be root or a stable cx- id");
        }
        const result = await client.docsMove(workspaceId, {
          nodeId: target,
          expectedPath: current.node.path,
          newParentId,
          position: { mode: "inside" }
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
          mode
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
          baseEtag: edit.etag
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
        let last;
        if (action === "set") {
          for (const tag of values) await client.registryTagCreate(workspaceId, { name: tag });
          const edit = await client.docsReadForEdit(workspaceId, ref);
          last = await client.docsTagsSet(workspaceId, {
            nodeId: ref,
            tags: values,
            baseEtag: edit.etag
          });
        } else {
          for (const tag of values) {
            if (action === "add") await client.registryTagCreate(workspaceId, { name: tag });
            const edit = await client.docsReadForEdit(workspaceId, ref);
            last = action === "add" ? await client.docsTagAdd(workspaceId, { nodeId: ref, tag, baseEtag: edit.etag }) : await client.docsTagRemove(workspaceId, { nodeId: ref, tag, baseEtag: edit.etag });
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
function nodeHelpText() {
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
function nodeRef(value) {
  if (!/^cx-[a-z0-9]+$/i.test(value)) throw new Error(`Expected canonical Node id (cx-*): ${value}`);
  return value;
}
async function resolveParentPath(client, workspaceId, value) {
  if (!value || value === "root") return "";
  const result = await client.docsGet(workspaceId, nodeRef(value));
  return result.node.path;
}
function oneTarget(positionals, help) {
  return positionals.length === 1 ? positionals[0] : usage(help);
}
function flagValue(flags, name) {
  return Object.prototype.hasOwnProperty.call(flags, name) ? flags[name] : void 0;
}
function parseCsv(value) {
  return [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
}
function parseFlags(args) {
  const positionals = [];
  const flags = {};
  const booleans = /* @__PURE__ */ new Set(["json", "attach-only"]);
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
function print(value, json, format) {
  return {
    exitCode: 0,
    stdout: json ? JSON.stringify(value, null, 2) + "\n" : format(value).trimEnd() + "\n",
    stderr: ""
  };
}
function usage(text) {
  return { exitCode: 1, stdout: "", stderr: text.trimEnd() + "\n" };
}
function formatNode(value) {
  const node = value.node;
  if (!node) return JSON.stringify(value);
  return `${node.nodeId}  ${node.type}  ${node.path}`;
}
function formatTree(nodes) {
  const lines = [];
  const visit = (node, depth) => {
    lines.push(`${"  ".repeat(depth)}${node.nodeId}  ${node.type}  ${node.name}`);
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  for (const node of nodes) visit(node, 0);
  return lines.length > 0 ? lines.join("\n") : "(no nodes)";
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// src/cli/role-rpc.ts
var COMMON_ROLE_FLAGS = /* @__PURE__ */ new Set(["json", "attach-only", "data-dir", "service-entry", "workspace"]);
var METADATA_ROLE_FLAGS = /* @__PURE__ */ new Set([
  "display-name",
  "displayName",
  "prompt",
  "description",
  "color"
]);
async function runRoleCommand(sub, args, globals = {}) {
  const cmd = (sub || "").trim().toLowerCase();
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    return { exitCode: 0, stdout: roleHelpText() + "\n", stderr: "" };
  }
  if (cmd !== "list" && cmd !== "show" && cmd !== "config") {
    return fail(`Unknown role subcommand: ${sub || "(empty)"}
` + roleHelpText());
  }
  try {
    const { positionals, flags } = parseFlags2(args, ["json", "attach-only"]);
    for (const key of Object.keys(flags)) {
      if (!COMMON_ROLE_FLAGS.has(key) && !METADATA_ROLE_FLAGS.has(key)) {
        return fail(`Unknown role option: --${key}`);
      }
    }
    const json = globals.json === true || flags.json === "true";
    const attach = {
      dataDir: flags["data-dir"] || globals.dataDir,
      attachOnly: globals.attachOnly === true || flags["attach-only"] === "true",
      serviceEntry: flags["service-entry"] || globals.serviceEntry,
      packageRoot: globals.packageRoot,
      env: globals.env
    };
    const client = globals.client ?? (await attachOrBootstrapService(attach)).client;
    const { workspaceId } = await ensureMountedWorkspace(client, {
      cwd: globals.cwd,
      workspace: flags.workspace || globals.workspace
    });
    if (cmd === "list") {
      if (positionals.length > 0) return fail("Usage: tent role list [--workspace <path>] [--json]");
      const result = await client.registryRoles(workspaceId);
      const roles = (result.roles ?? []).map(whitelistRole);
      return print2({ workspaceId, roles }, json, () => roles.length ? roles.map(formatRole).join("") : "(no roles)\n");
    }
    if (cmd === "show") {
      const ref = positionals[0]?.trim();
      if (!ref || positionals.length > 1) return fail("Usage: tent role show <name|roleId> [--workspace <path>] [--json]");
      const result = await client.registryRoles(workspaceId);
      const found = (result.roles ?? []).find((r) => r.name === ref || r.roleId === ref);
      if (!found) return fail(`Role not found: ${ref}`);
      const role = whitelistRole(found);
      return print2({ workspaceId, role }, json, () => formatRole(role));
    }
    return await configRole(client, workspaceId, positionals, flags, json);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
function roleHelpText() {
  return `tent role \u2014 Service-backed Role discovery and metadata configuration

Usage:
  tent role list   [--workspace <path>] [--json]
  tent role show   <name|roleId> [--workspace <path>] [--json]
  tent role config <name|roleId> [--display-name <label>] [--prompt <text>]
                   [--description <text>] [--color <value>] [--json]

list/show project Role metadata only.
config patches Role metadata via registry.role.update (actor=user).
`;
}
async function configRole(client, workspaceId, positionals, flags, json) {
  const ref = positionals[0]?.trim();
  if (!ref || positionals.length > 1) {
    return fail("Usage: tent role config <name|roleId> [metadata options]");
  }
  const hasMeta = "display-name" in flags || "displayName" in flags || "prompt" in flags || "description" in flags || "color" in flags;
  if (!hasMeta) {
    return fail("tent role config requires Role metadata options");
  }
  const listed = await client.registryRoles(workspaceId);
  const current = (listed.roles ?? []).find((r) => r.name === ref || r.roleId === ref);
  if (!current) return fail(`Role not found: ${ref}`);
  const patch = { actor: "user" };
  if (current.roleId) patch.roleId = current.roleId;
  if ("display-name" in flags) patch.displayName = flags["display-name"] === "" ? null : flags["display-name"];
  else if ("displayName" in flags) patch.displayName = flags.displayName === "" ? null : flags.displayName;
  if ("prompt" in flags) patch.prompt = flags.prompt === "" ? null : flags.prompt;
  if ("description" in flags) patch.description = flags.description === "" ? null : flags.description;
  if ("color" in flags) patch.color = flags.color === "" ? null : flags.color;
  const result = await client.registryRoleUpdate(workspaceId, current.name, patch);
  const role = whitelistRole(result.role);
  return print2({ workspaceId, role }, json, () => `Updated role ${role.name}
` + formatRole(role));
}
function whitelistRole(raw) {
  const src = raw;
  const name = typeof src.name === "string" ? src.name : "";
  if (!name) throw new Error("Role projection missing name");
  const role = {
    roleId: typeof src.roleId === "string" ? src.roleId : "",
    name,
    displayName: typeof src.displayName === "string" && src.displayName.trim() ? src.displayName : name
  };
  if (typeof src.description === "string") role.description = src.description;
  if (typeof src.color === "string") role.color = src.color;
  if (typeof src.prompt === "string") role.prompt = src.prompt;
  return role;
}
function formatRole(role) {
  const label = role.displayName && role.displayName !== role.name ? ` "${role.displayName}"` : "";
  const lines = [
    `${role.name}${label}${role.roleId ? ` ${role.roleId}` : ""}`,
    ...role.description ? [`description: ${role.description}`] : []
  ];
  return lines.join("\n") + "\n";
}
function parseFlags2(args, booleans) {
  const positionals = [];
  const flags = {};
  const bool = new Set(booleans);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 2) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    if (bool.has(key)) {
      flags[key] = "true";
      continue;
    }
    const next = args[i + 1];
    if (next !== void 0 && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else flags[key] = "true";
  }
  return { positionals, flags };
}
function print2(result, json, human) {
  return { exitCode: 0, stdout: json ? JSON.stringify(result, null, 2) + "\n" : human(), stderr: "" };
}
function fail(msg) {
  return { exitCode: 1, stdout: "", stderr: msg.trimEnd() + "\n" };
}

// src/cli/role-checkpoint-rpc.ts
import * as path9 from "node:path";

// src/core/role-checkpoint.ts
var ROLE_CHECKPOINT_TYPE = "role-checkpoint";
var ROLE_CHECKPOINT_MAX_TEXT_CHARS = 4e3;
var ROLE_CHECKPOINT_MAX_POINTERS = 32;
var ROLE_CHECKPOINT_MAX_POINTER_CHARS = 256;
var ROLE_CHECKPOINT_MAX_TAIL_CHARS = 8192;
var ROLE_CHECKPOINT_FILENAME = "checkpoint.md";
var WINDOWS_RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
function assertRoleCheckpointRoleName(role) {
  const name = typeof role === "string" ? role.trim() : "";
  if (!name) throw new Error("Role name cannot be empty.");
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Role name cannot contain control characters.");
  }
  if (/[\/\\<>:"|?*]/.test(name)) {
    throw new Error("Role name cannot contain path separators or reserved path characters.");
  }
  if (name === "." || name === ".." || name.includes("..")) {
    throw new Error("Role name cannot be a dot segment or contain path traversal.");
  }
  if (name.startsWith(".") || name.endsWith(".")) {
    throw new Error("Role name cannot start or end with a dot.");
  }
  if (WINDOWS_RESERVED_DEVICE.test(name)) {
    throw new Error(`Role name is a reserved Windows path segment: ${name}.`);
  }
  assertRoleNameAvailable(name);
  if ([ROLES_TEMP_DIR, SESSIONS_TEMP_DIR].includes(name.toLowerCase())) {
    throw new Error(`Role name is reserved by Tent: ${name}.`);
  }
  if (name.toLowerCase() === TEMP_DIR) {
    throw new Error(`Role name is reserved by Tent: ${TEMP_DIR}.`);
  }
  return name;
}
function assertRoleSegment(role) {
  return assertRoleCheckpointRoleName(role);
}
function roleCheckpointPath(role) {
  const name = assertRoleCheckpointRoleName(role);
  return join3(TEMP_DIR, name, ROLE_CHECKPOINT_FILENAME);
}
function roleCheckpointFileReadPath(role) {
  return join3(".tent", roleCheckpointPath(role));
}
function normalizePointerList(raw, label) {
  if (raw === void 0 || raw === null) return void 0;
  if (!Array.isArray(raw)) {
    throw new Error(`Role Checkpoint pointers.${label} must be an array of strings.`);
  }
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`Role Checkpoint pointers.${label} entries must be non-empty strings.`);
    }
    const normalized = item.trim();
    if (normalized.length > ROLE_CHECKPOINT_MAX_POINTER_CHARS) {
      throw new Error(
        `Role Checkpoint pointers.${label} entries cannot exceed ${ROLE_CHECKPOINT_MAX_POINTER_CHARS} characters.`
      );
    }
    out.push(normalized);
  }
  return out.length > 0 ? out : void 0;
}
function normalizePointers(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const nodes = normalizePointerList(raw.nodes, "nodes");
  const tasks = normalizePointerList(raw.tasks, "tasks");
  const deliveries = normalizePointerList(raw.deliveries, "deliveries");
  const git = normalizePointerList(raw.git, "git");
  if (!nodes && !tasks && !deliveries && !git) return void 0;
  const total = (nodes?.length ?? 0) + (tasks?.length ?? 0) + (deliveries?.length ?? 0) + (git?.length ?? 0);
  if (total > ROLE_CHECKPOINT_MAX_POINTERS) {
    throw new Error(
      `Role Checkpoint cannot contain more than ${ROLE_CHECKPOINT_MAX_POINTERS} pointers across all buckets.`
    );
  }
  return {
    ...nodes ? { nodes } : {},
    ...tasks ? { tasks } : {},
    ...deliveries ? { deliveries } : {},
    ...git ? { git } : {}
  };
}
function normalizeText(text) {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) throw new Error("Role Checkpoint text cannot be empty.");
  if (trimmed.length > ROLE_CHECKPOINT_MAX_TEXT_CHARS) {
    throw new Error(
      `Role Checkpoint text exceeds ${ROLE_CHECKPOINT_MAX_TEXT_CHARS} characters; keep a short continuation note with pointers only.`
    );
  }
  return trimmed;
}
async function readRoleCheckpoint(fs10, role) {
  const name = assertRoleSegment(role);
  const path11 = roleCheckpointPath(name);
  if (!await fs10.exists(path11)) return null;
  const raw = await fs10.readFile(path11);
  const parsed = parseFrontmatter(raw);
  const type = typeof parsed.data.type === "string" ? parsed.data.type.trim() : "";
  if (type && type !== ROLE_CHECKPOINT_TYPE) {
    throw new Error(
      `Role Checkpoint at ${path11} has unexpected type ${type}; expected ${ROLE_CHECKPOINT_TYPE}.`
    );
  }
  const fmRole = typeof parsed.data.role === "string" ? parsed.data.role.trim() : name;
  if (fmRole !== name) {
    throw new Error(`Role Checkpoint role mismatch at ${path11}: file has ${fmRole}, expected ${name}.`);
  }
  const updatedAt = typeof parsed.data.updatedAt === "string" ? parsed.data.updatedAt.trim() : "";
  if (!updatedAt) {
    throw new Error(`Role Checkpoint at ${path11} is missing updatedAt.`);
  }
  const sourceSessionId = typeof parsed.data.sourceSessionId === "string" ? parsed.data.sourceSessionId.trim() || void 0 : void 0;
  const pointers = normalizePointers({
    nodes: parsed.data.nodes,
    tasks: parsed.data.tasks,
    deliveries: parsed.data.deliveries,
    git: parsed.data.git
  });
  let text = "";
  const body = parsed.body.replace(/\r\n/g, "\n");
  const cont = body.match(/##\s*Continuation\s*\r?\n+([\s\S]*?)\s*$/i);
  if (cont) {
    text = cont[1].trim();
  } else {
    text = body.replace(/^#\s*Role Checkpoint\s*/i, "").replace(
      /^Optional cooperative continuation[\s\S]*?stable Role init\.\s*/i,
      ""
    ).trim();
  }
  const record = {
    role: name,
    text: normalizeText(text),
    updatedAt,
    ...sourceSessionId ? { sourceSessionId } : {},
    ...pointers ? { pointers } : {},
    path: path11
  };
  formatRoleCheckpointTail(record);
  return record;
}
function formatRoleCheckpointTail(record) {
  if (!record) return "";
  const role = assertRoleCheckpointRoleName(record.role);
  const text = normalizeText(record.text);
  const pointers = normalizePointers(record.pointers);
  const lines = [
    "--- Tent Role Checkpoint (dynamic tail; optional) ---",
    "This is cooperative continuation only. It is not Delivery, Task state, or stable Role init.",
    "Abnormal recovery must re-query persisted Tent Nodes, Tasks, Deliveries, and Git \u2014 never invent from this note alone.",
    `role: ${role}`,
    `updatedAt: ${record.updatedAt}`,
    `checkpointPath: ${record.path}`,
    `fileRead: ${roleCheckpointFileReadPath(role)}`
  ];
  if (record.sourceSessionId) {
    lines.push(`sourceSessionId: ${record.sourceSessionId}`);
  }
  const p = pointers;
  if (p?.nodes?.length) lines.push(`nodes: ${p.nodes.join(", ")}`);
  if (p?.tasks?.length) lines.push(`tasks: ${p.tasks.join(", ")}`);
  if (p?.deliveries?.length) lines.push(`deliveries: ${p.deliveries.join(", ")}`);
  if (p?.git?.length) lines.push(`git: ${p.git.join(", ")}`);
  lines.push("");
  lines.push("## Continuation");
  lines.push("");
  lines.push(text);
  const tail = lines.join("\n");
  if (tail.length > ROLE_CHECKPOINT_MAX_TAIL_CHARS) {
    throw new Error(
      `Role Checkpoint dynamic tail exceeds ${ROLE_CHECKPOINT_MAX_TAIL_CHARS} characters.`
    );
  }
  return tail;
}

// src/cli/role-checkpoint-rpc.ts
function isInWorkspaceSystemRoot(systemRoot) {
  return workspaceRootFromSystemRoot(systemRoot) !== void 0;
}
function roleCheckpointHelpText() {
  return `tent role-checkpoint \u2014 optional cooperative Role Session continuation note

Usage:
  tent role-checkpoint set  <role> --text <note> [--actor user|<role>]
                            [--session <ss-\u2026>] [--nodes id,id] [--tasks id,id]
                            [--deliveries id,id] [--git ref,ref]
  tent role-checkpoint show <role>
  tent role-checkpoint clear <role> [--actor user|<role>]

Semantics:
  set    Overwrite the single current note under temp/<role>/checkpoint.md
         (in-workspace: Local Service RPC + MutationBus; never direct-write)
  show   Print the note + dynamic-tail projection (or report absent; read-only)
  clear  Remove the note (idempotent; same Service mutation path as set)

Actor (set/clear):
  --actor user          User / UI path (default)
  --actor <role>        Exact target Role operational name (future tent-role Skill)
  Unrelated Role actors are refused by the Service.

Rules:
  - Dynamic tail only \u2014 never stable Role init / cache prefix.
  - Not a Delivery, Task state, Core entity, or OS-temp artifact.
  - Crash recovery must work without this note (re-query Tent/Git facts).
  - One note per Role; later writes replace earlier ones.
  - Direct core mutation of set/clear is fail-loud on in-workspace .tent.

Common flags:
  --workspace <path>   Workspace root (wins over cwd for set/show/clear)
  --data-dir <path>    Service data area
  --attach-only        Do not bootstrap Local Service
  --json               Machine-readable result
`;
}
async function runRoleCheckpointCommand(sub, args, globals = {}) {
  const normalized = (sub || "").trim().toLowerCase();
  if (!normalized || normalized === "help" || normalized === "--help" || normalized === "-h") {
    return { exitCode: 0, stdout: roleCheckpointHelpText() + "\n", stderr: "" };
  }
  if (normalized !== "set" && normalized !== "show" && normalized !== "clear") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unknown role-checkpoint subcommand: ${sub || "(empty)"}
` + roleCheckpointHelpText() + "\n"
    };
  }
  try {
    const { positionals, flags } = parseRoleCheckpointFlags(args);
    const json = globals.json === true || flags.json === "true";
    const role = positionals[0]?.trim();
    if (!role) {
      return failUsage3(
        `Usage: tent role-checkpoint ${normalized} <role> \u2026
` + roleCheckpointHelpText()
      );
    }
    if (normalized === "set" && positionals.length > 1) {
      return failUsage3(
        "Usage: tent role-checkpoint set <role> --text <note> [--actor user|<role>] \u2026"
      );
    }
    if (normalized !== "set" && positionals.length > 1) {
      return failUsage3(`Usage: tent role-checkpoint ${normalized} <role>`);
    }
    if ((normalized === "set" || normalized === "clear") && (flags.direct === "true" || flags["no-service"] === "true")) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `role-checkpoint ${normalized} refuses --direct / --no-service: in-workspace mutations must use Local Service (MutationBus).
Omit those flags; attach/bootstrap Service is the default path.
`
      };
    }
    if (normalized === "show" && !globals.client && flags.service !== "true") {
      return await runShowDirect(role, flags, json, globals);
    }
    return await runViaService(normalized, role, flags, json, globals);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}
async function runViaService(normalized, role, flags, json, globals) {
  const attachOpts = {
    dataDir: flags["data-dir"] || globals.dataDir,
    attachOnly: globals.attachOnly === true || flags["attach-only"] === "true",
    serviceEntry: flags["service-entry"] || globals.serviceEntry,
    packageRoot: globals.packageRoot,
    env: globals.env
  };
  const client = globals.client ?? (await attachOrBootstrapService(attachOpts)).client;
  const ctx = await ensureMountedWorkspace(client, {
    cwd: globals.cwd,
    workspace: flags.workspace || globals.workspace
  });
  const workspaceId = ctx.workspaceId;
  const actor = resolveActorFlag(flags);
  if (normalized === "show") {
    const result2 = await client.roleCheckpointGet(workspaceId, role);
    if (json) return okJson(result2);
    if (!result2.checkpoint) {
      return {
        exitCode: 0,
        stdout: `No Role Checkpoint for role ${role}.
`,
        stderr: ""
      };
    }
    return {
      exitCode: 0,
      stdout: (result2.tail?.trim() ? result2.tail.trim() + "\n" : "") || "",
      stderr: ""
    };
  }
  if (normalized === "clear") {
    const result2 = await client.roleCheckpointClear(workspaceId, role, {
      actor
    });
    if (json) return okJson(result2);
    return {
      exitCode: 0,
      stdout: result2.cleared ? `\u2713 Role Checkpoint cleared for ${role}
` : `No Role Checkpoint to clear for ${role}
`,
      stderr: ""
    };
  }
  const text = flags.text || flags.note || flags.body;
  if (!text?.trim()) {
    return failUsage3(
      "Usage: tent role-checkpoint set <role> --text <note> [--actor user|<role>] [--session <ss-\u2026>] [--nodes \u2026]"
    );
  }
  const pointers = pointersFromFlags(flags);
  const result = await client.roleCheckpointSet(workspaceId, {
    role,
    text,
    actor,
    sourceSessionId: flags.session || flags["session-id"] || flags.sourceSessionId,
    ...pointers ? { pointers } : {}
  });
  if (json) return okJson(result);
  const path11 = result?.checkpoint?.path || `temp/${role}/checkpoint.md`;
  return {
    exitCode: 0,
    stdout: `\u2713 Role Checkpoint written: ${path11}
`,
    stderr: ""
  };
}
async function runShowDirect(role, flags, json, globals) {
  const explicitWorkspace = (flags.workspace || globals.workspace || "").trim();
  const start = explicitWorkspace ? path9.resolve(explicitWorkspace) : path9.resolve(globals.cwd || process.cwd());
  const systemRoot = await findTentSystemRoot(start);
  if (!systemRoot) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: NOT_INSIDE_TENT_MESSAGE + (explicitWorkspace ? ` (searched from --workspace ${start})` : "") + "\n"
    };
  }
  void isInWorkspaceSystemRoot;
  const fsa = new NodeFs(systemRoot);
  try {
    const record = await readRoleCheckpoint(fsa, role);
    if (json) {
      return okJson({
        role,
        checkpoint: record,
        tail: formatRoleCheckpointTail(record)
      });
    }
    if (!record) {
      return {
        exitCode: 0,
        stdout: `No Role Checkpoint for role ${role}.
`,
        stderr: ""
      };
    }
    return {
      exitCode: 0,
      stdout: formatRoleCheckpointTail(record) + "\n",
      stderr: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}
function resolveActorFlag(flags) {
  const raw = (flags.actor || flags.by || "").trim();
  return raw || "user";
}
function pointersFromFlags(flags) {
  const split = (raw) => {
    if (!raw?.trim()) return void 0;
    const items = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    return items.length ? items : void 0;
  };
  const nodes = split(flags.nodes || flags.node);
  const tasks = split(flags.tasks || flags.task);
  const deliveries = split(flags.deliveries || flags.delivery);
  const git = split(flags.git);
  if (!nodes && !tasks && !deliveries && !git) return void 0;
  return {
    ...nodes ? { nodes } : {},
    ...tasks ? { tasks } : {},
    ...deliveries ? { deliveries } : {},
    ...git ? { git } : {}
  };
}
function parseRoleCheckpointFlags(args) {
  const positionals = [];
  const flags = {};
  const booleanFlags = /* @__PURE__ */ new Set([
    "json",
    "service",
    "via-service",
    "attach-only",
    "direct",
    "no-service"
  ]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (booleanFlags.has(name)) {
        flags[name] = "true";
      } else {
        flags[name] = args[i + 1] ?? "";
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}
function failUsage3(msg) {
  return { exitCode: 1, stdout: "", stderr: msg + "\n" };
}
function okJson(value) {
  return {
    exitCode: 0,
    stdout: JSON.stringify(value, null, 2) + "\n",
    stderr: ""
  };
}

// src/cli/proposal-rpc.ts
async function runProposalSubmit(args, globals = {}) {
  try {
    const attachOpts = {
      dataDir: globals.dataDir,
      attachOnly: globals.attachOnly === true,
      serviceEntry: globals.serviceEntry,
      packageRoot: globals.packageRoot,
      env: globals.env
    };
    const client = globals.client ?? (await attachOrBootstrapService(attachOpts)).client;
    const ctx = await ensureMountedWorkspace(client, {
      cwd: globals.cwd,
      workspace: globals.workspace
    });
    const result = await client.proposalSubmit(ctx.workspaceId, {
      nodeId: args.nodeId,
      role: args.role,
      body: args.body
    });
    const proposalPath = result.proposal?.path;
    if (!proposalPath) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "proposal.submit returned no proposal path\n"
      };
    }
    return {
      exitCode: 0,
      stdout: `\u2713 Proposal submitted for triage: ${proposalPath}
`,
      stderr: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}

// src/cli/tent.ts
function isInWorkspaceSystemRoot2(systemRoot) {
  return workspaceRootFromSystemRoot(systemRoot) !== void 0;
}
async function makeEnv() {
  const systemRoot = await findTentSystemRoot(process.cwd());
  if (!systemRoot) throw new Error(NOT_INSIDE_TENT_MESSAGE);
  const workspace = workspaceRootFromSystemRoot(systemRoot);
  if (!workspace) throw new Error("Tent requires an in-workspace <workspace>/.tent layout.");
  return {
    fs: new NodeFs(systemRoot),
    clock: new SystemClock(),
    tentName: path10.basename(workspace),
    tentRoot: systemRoot
  };
}
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(helpText());
    return;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(await packageVersion());
    return;
  }
  if (cmd === "new") {
    const { positionals, flags } = parseFlags3(args);
    if (!positionals[0]) {
      return fail2(
        "Usage: tent new <workspace-path>\n       tent new <workspace-path> --repair-existing"
      );
    }
    if (positionals.length > 1) {
      return fail2(
        "Usage: tent new <workspace-path>\n       tent new <workspace-path> --repair-existing"
      );
    }
    const repairExisting = flags["repair-existing"] === "true";
    const unknown = Object.keys(flags).filter((k) => k !== "repair-existing");
    if (unknown.length > 0) {
      return fail2(
        `Unknown flag for tent new: --${unknown[0]}
Usage: tent new <workspace-path>
       tent new <workspace-path> --repair-existing`
      );
    }
    if (repairExisting) {
      await repairExistingTent(positionals[0]);
    } else {
      await newTent(positionals[0]);
    }
    return;
  }
  if (cmd === "skill-install") {
    const { positionals, flags } = parseFlags3(args);
    if (positionals.length > 0) return fail2("Usage: tent skill-install [--target all|claude|shared-agents] [--force]");
    const target = flags.target || "all";
    const force = flags.force === "true";
    const defaultDirs = resolveCliSkillInstallDirs(target);
    const targetDirs = flags.dir ? [flags.dir] : defaultDirs;
    const results = await installSkills({
      packageRoot: packageRoot(),
      targetDirs,
      force
    });
    console.log(formatSkillInstallResults(target, results));
    return;
  }
  if (cmd === "agent-hooks") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(agentHooksHelpText());
      return;
    }
    if (sub !== "install" && sub !== "doctor" && sub !== "remove") {
      return fail2(
        `Unknown agent-hooks subcommand: ${sub}
Usage: tent agent-hooks install|doctor|remove [--agent all|claude|codex|copilot] [--json]`
      );
    }
    const { positionals, flags } = parseFlags3(rest);
    if (positionals.length > 0) {
      return fail2(
        `Usage: tent agent-hooks ${sub} [--agent all|claude|codex|copilot] [--json]`
      );
    }
    let agents;
    try {
      agents = flags.agent ? resolveAgentHookSelection([flags.agent]) : void 0;
      if (flags.agent && flags.agent !== "all") parseAgentHookId(flags.agent);
    } catch (error) {
      return fail2(error instanceof Error ? error.message : String(error));
    }
    const asJson = flags.json === "true";
    const home = flags.home || void 0;
    const tentCommand = flags["tent-command"] || flags.tentCommand || void 0;
    const runOpts = { agents, home, tentCommand };
    const batch = sub === "install" ? await installAgentHooks(runOpts) : sub === "doctor" ? await doctorAgentHooks(runOpts) : await removeAgentHooks(runOpts);
    if (asJson) {
      console.log(JSON.stringify(batch, null, 2));
    } else {
      console.log(formatAgentHooksResults(batch));
    }
    return;
  }
  if (cmd === "task") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(taskHelpText());
      return;
    }
    const result = await runTaskCommand(sub, rest, { packageRoot: packageRoot() });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  if (cmd === "session") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(sessionHelpText());
      return;
    }
    const result = await runSessionCommand(sub, rest, { packageRoot: packageRoot() });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  if (cmd === "role") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(roleHelpText());
      return;
    }
    const result = await runRoleCommand(sub, rest, { packageRoot: packageRoot() });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  if (cmd === "node") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(nodeHelpText());
      return;
    }
    const result = await runNodeCommand(sub, rest, { packageRoot: packageRoot() });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  if (cmd === "role-checkpoint") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(roleCheckpointHelpText());
      return;
    }
    const result = await runRoleCheckpointCommand(sub, rest, {
      packageRoot: packageRoot()
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  if (cmd === "propose") {
    const { positionals } = parseFlags3(args);
    const [nodeId, bodySource] = positionals;
    if (!nodeId || !bodySource || positionals.length > 2) {
      return fail2("Usage: tent propose <nodeId> <bodyFile|->");
    }
    const role = process.env.TENT_ROLE;
    if (!role) return fail2("tent propose requires TENT_ROLE to identify the submitting role");
    const body = bodySource === "-" ? await readStdin2() : await readBodyFile(bodySource);
    const systemRoot = await findTentSystemRoot(process.cwd());
    if (!systemRoot) return fail2(NOT_INSIDE_TENT_MESSAGE);
    const workspace = workspaceRootFromSystemRoot(systemRoot);
    if (!workspace) return fail2("tent propose requires an in-workspace <workspace>/.tent layout");
    const result = await runProposalSubmit(
      { nodeId, role, body },
      { cwd: workspace, workspace, packageRoot: packageRoot() }
    );
    if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");
    if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : result.stderr + "\n");
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  const tentCommands = /* @__PURE__ */ new Set(["role-init", "status", "tags", "find", "tree"]);
  if (!tentCommands.has(cmd)) {
    return fail2(
      `Unknown command: ${cmd || "(empty)"}
Commands: new node task role propose role-init role-checkpoint status tags find tree skill-install agent-hooks`
    );
  }
  const env = await makeEnv();
  switch (cmd) {
    case "role-init": {
      const roleName = args[0];
      if (!roleName) return fail2("Usage: tent role-init <role>");
      if (args.length > 1) return fail2("Usage: tent role-init <role>");
      const roles = await loadRolesRegistry(env.fs);
      const role = roles.roles.find((item) => item.name === roleName) ?? { name: roleName };
      const initPath = await withTentMutation(
        env.fs,
        () => ensureRoleInit(env.fs, role, env.tentName)
      );
      console.log(`Read ${initPath} to complete role initialization.`);
      break;
    }
    case "status": {
      if (args.length > 0) return fail2("Usage: tent status");
      try {
        process.stdout.write(
          await renderTentStatus(process.cwd(), process.env.TENT_ROLE, (root) => new NodeFs(root))
        );
      } catch (error) {
        if (error instanceof Error && error.message === NOT_INSIDE_TENT_MESSAGE) return fail2(error.message);
        throw error;
      }
      break;
    }
    case "tags": {
      if (args.length > 0) return fail2("Usage: tent tags");
      const registry = await loadTagRegistry(env.fs);
      if (registry.tags.length === 0) console.log("(no tags)");
      else for (const tag of registry.tags) console.log(tag);
      break;
    }
    case "find": {
      if (!args[0]) return fail2("Usage: tent find <name>");
      if (args.length > 1) return fail2("Usage: tent find <name>");
      try {
        normalizeTagName(args[0]);
      } catch (error) {
        return fail2(error instanceof Error ? error.message : String(error));
      }
      const tent = await loadTent(env.fs);
      const nodes = findNodesByTag(tent, args[0]);
      if (nodes.length === 0) {
        console.log("(no matches)");
        break;
      }
      for (const node of nodes) {
        const pointer = outputPointer(node.fm, node.body);
        console.log(`${node.id}	${node.path}	${node.type}${pointer ? `	${pointer}` : ""}`);
      }
      break;
    }
    case "tree": {
      if (args.length > 0) return fail2("Usage: tent tree");
      const tent = await loadTent(env.fs);
      for (const root of tent.roots) printNode(root, 0);
      break;
    }
    default:
      return fail2(`Unknown command: ${cmd || "(empty)"}`);
  }
}
function readStdin2() {
  return new Promise((resolve10, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve10(data));
    process.stdin.on("error", reject);
  });
}
async function readBodyFile(bodySource) {
  const resolved = path10.resolve(bodySource);
  if (!await existsPath2(resolved)) throw new Error(`Body file not found: ${bodySource}.`);
  return fs9.readFile(resolved, "utf8");
}
function printNode(node, depth) {
  const ind = "  ".repeat(depth);
  const mode = node.archived ? " archived" : "";
  const type = node.type;
  const id = node.id || "missing-id";
  const invalid = node.invalid ? ` invalid:${node.invalidReason || "invalid"}` : "";
  console.log(`${ind}${node.name} [${type} ${id}]${mode}${invalid}`);
  for (const child of node.children) printNode(child, depth + 1);
}
function outputPointer(fm, body) {
  const { workspace, ref } = parseOutputPointer(fm, body);
  return [workspace ? `workspace=${workspace}` : "", ref ? `ref=${ref}` : ""].filter(Boolean).join(" ");
}
function fail2(msg) {
  console.error(msg);
  process.exitCode = 1;
}
function parseFlags3(args) {
  const positionals = [];
  const flags = {};
  const booleanFlags = /* @__PURE__ */ new Set(["force", "json", "repair-existing"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (booleanFlags.has(name)) {
        flags[name] = "true";
      } else {
        flags[name] = args[i + 1] ?? "";
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}
function agentHooksHelpText() {
  return `tent agent-hooks \u2014 machine-local native hook/config projection (V0.2)

Usage:
  tent agent-hooks install [--agent all|claude|codex|copilot] [--json]
  tent agent-hooks doctor  [--agent all|claude|codex|copilot] [--json]
  tent agent-hooks remove  [--agent all|claude|codex|copilot] [--json]

Behavior:
  - SessionStart \u2192 tent session session-start --host <agent>
  - Stop         \u2192 tent session session-end --host <agent>
  - CLI hook aliases parse session identity/cwd from native hook stdin and
    silently skip non-Tent workspaces (leave never needs a sessionId positional).
  - Merges into existing agent configs; never rewrites permissions or MCP.
  - install / doctor / remove are idempotent; remove only Tent-managed handlers.
  - Installation rewrites only Tent-managed hook entries; runtime never depends
    on stale host configuration.
  - Copilot reports unsupported while no verified lifecycle hook surface exists.
  - Projection only writes under --home (tests) or os.homedir(); never smoke real user configs.

Options:
  --agent <id>     Target agent (default: all).
  --json           Machine-readable result.
  --home <path>    Override home for config roots (tests / isolated fixtures only).
  --tent-command <cmd>  Override tent entry used in projected commands (tests).
`;
}
function formatSkillInstallResults(target, results) {
  const byDir = /* @__PURE__ */ new Map();
  for (const item of results) {
    const list = byDir.get(item.targetDir) ?? [];
    list.push(item);
    byDir.set(item.targetDir, list);
  }
  const lines = [`\u2713 skill-install (${target})`];
  for (const [dir, items] of byDir) {
    lines.push(`  ${dir}`);
    for (const item of items) {
      const suffix = item.status === "skipped" && item.reason ? ` (${item.reason})` : "";
      lines.push(`    - ${item.skill}: ${item.status}${suffix}`);
    }
  }
  return lines.join("\n");
}
function packageRoot() {
  const here = path10.dirname(fileURLToPath2(import.meta.url));
  if (path10.basename(here) === "cli" && path10.basename(path10.dirname(here)) === "src") {
    return path10.resolve(here, "../..");
  }
  return here;
}
async function existsPath2(target) {
  try {
    await fs9.access(target);
    return true;
  } catch {
    return false;
  }
}
async function packageVersion() {
  const pkg = JSON.parse(await fs9.readFile(path10.join(packageRoot(), "package.json"), "utf8"));
  return String(pkg.version ?? "0.0.0");
}
function helpText() {
  return `Tent CLI

Usage:
  tent <command> [args]

Run commands from a workspace with <workspace>/.tent/ unless noted.

Node, Role, Task, Delivery, and Agent Connection:
  tent role list|show|config          Durable Role discovery + metadata config (Service-backed)
  tent role --help                    Role subcommand help
  tent task list|get|claim|deliver|\u2026  Attach Local Service \u2192 mount \u2192 task.* RPC
  tent task --help                    Full task subcommand help

Service-backed workspace operations:
  tent node list|get|create|write|\u2026 Agent-facing Node operations through Local Service
  tent node --help                   Full Node subcommand help
  tent role-checkpoint set|show|clear Optional cooperative Role continuation note
  tent role-checkpoint --help         set/clear \u2192 Service; show read-only; --actor
  propose <nodeId> <file|->           Submit a Node proposal (in-workspace \u2192 proposal.submit RPC)
  CLI exit does not stop Local Service. Token stays in machine-local endpoint records.

Initialization and machine config:
  new <workspace-path>               Create <workspace>/.tent without touching project files.
                                     Use "tent new ." to adopt an existing project.
  new <workspace-path> --repair-existing
                                     One-shot re-adopt of an orphan <workspace>/.tent
                                     (missing index + Tent evidence). Never runs genesis.
  skill-install [--target all|claude|shared-agents] [--force]
                                     Install bundled skills to selected machine roots.
  agent-hooks install|doctor|remove [--agent all|claude|codex|copilot]
                                     Project Tent-managed SessionStart/Stop hooks into
                                     verified agent configs (no permissions / MCP).
  role-init <role>                   Regenerate the derived stable role init document.
  role-checkpoint set|show|clear     Continuation note: set/clear via Local Service; show read-only.
                                     set/clear accept --actor user|<role> (default user).

Read-only:
  status                             Print a read-only Tent status summary.
  tags                               List registered tags.
  find <tag>                         Find Nodes by tag.
  tree                               Print the Node tree.

Options:
  -h, --help                         Show this help.
  -v, --version                      Show the package version.
`;
}
async function newTent(target) {
  const fsmod = await import("node:fs/promises");
  const workspaceRoot = path10.resolve(target);
  const fsa = new NodeFs(workspaceRoot);
  if (await fsa.exists(".tent")) return fail2(`Target is already a Tent: ${workspaceRoot}`);
  await fsmod.mkdir(workspaceRoot, { recursive: true });
  const name = path10.basename(workspaceRoot);
  await scaffoldInWorkspace(fsa, { name });
  console.log(
    `\u2713 Created Tent: ${path10.join(workspaceRoot, ".tent")}
In-workspace layout: collaboration facts live under <workspace>/.tent/.
The Node tree starts empty; use tent-init to propose and approve its initial structure.`
  );
}
async function repairExistingTent(target) {
  const workspaceRoot = path10.resolve(target);
  const fsa = new NodeFs(workspaceRoot);
  let result;
  try {
    result = await reAdoptOrphanTent(fsa);
  } catch (error) {
    return fail2(error instanceof Error ? error.message : String(error));
  }
  const created = [];
  if (result.createdIndex) created.push("index.md");
  for (const dir of result.createdDirs) created.push(`${dir}/`);
  for (const reg of result.createdRegistries) created.push(reg);
  if (result.gitignoreUpdated) created.push(".gitignore (.tent/ entry)");
  const createdLine = created.length > 0 ? `Created structural pieces: ${created.join(", ")}` : "Created structural pieces: (none beyond index)";
  console.log(
    `\u2713 Re-adopted orphan Tent: ${path10.join(workspaceRoot, ".tent")}
${createdLine}
Existing Node/registry/temp bytes were preserved; no genesis scaffold ran.`
  );
}
var entry = process.argv[1] ? path10.resolve(process.argv[1]) : "";
var thisFile = path10.resolve(fileURLToPath2(import.meta.url));
var normalizeEntryPath = (value) => process.platform === "win32" ? value.toLowerCase() : value;
void (async () => {
  if (!entry) return;
  const realEntry = await fs9.realpath(entry).catch(() => entry);
  const realThisFile = await fs9.realpath(thisFile).catch(() => thisFile);
  const isDirectEntry = normalizeEntryPath(realEntry) === normalizeEntryPath(realThisFile) || normalizeEntryPath(realEntry) === normalizeEntryPath(realThisFile.replace(/\.ts$/i, ".js"));
  if (!isDirectEntry) return;
  await main();
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
export {
  isInWorkspaceSystemRoot2 as isInWorkspaceSystemRoot
};
