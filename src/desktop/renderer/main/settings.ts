// Settings secondary surface: one primary entry, secondary nav for
// Workspace · Roles · Agent Profiles · Credentials · Skills/MCP · Maintenance.
// All mutations via Service RPC. Credentials never echo secrets.

import { escapeHtml } from "../../../markdown/render.js";
import type {
  AgentProfileProjection,
  ProviderCatalogEntry,
  RoleRegistryEntryProjection,
} from "../../../service/types.js";
import type { CredentialProjection } from "../../../service/credential-store.js";
import type { BundledSkillListEntry } from "../../../machine/skills.js";
import {
  buildMcpServersPayload,
  buildSkillsPayload,
  credentialListRow,
  CREDENTIAL_VAULT_TYPE,
  DELIVERY_POLICY_OPTIONS,
  formatRosterText,
  mapProviderCatalogRows,
  mcpCredentialStatusLine,
  mcpDraftsFromProjection,
  mcpSourceLine,
  PROFILE_NEXT_SESSION_TIP,
  PROFILE_SKILLS_METADATA_TIP,
  profileDisplayLabel,
  removeMcpDraft,
  removeSkillDraft,
  retentionSummaryLine,
  setMcpEnabled,
  setSkillEnabled,
  skillDraftsFromProjection,
  skillSourceLine,
  validateCredentialSet,
  validateMcpAddDraft,
  validateProfileCreate,
  validateProfileUpdate,
  validateRoleCreate,
  validateRoleUpdate,
  validateSkillAddDraft,
  type DeliveryPolicy,
  type McpServerDraft,
  type ProviderRow,
  type SkillRefDraft,
} from "../../workbench/settings-model.js";
import { DESKTOP_CONTRACT_GAPS } from "./contract-gaps.js";
import { el, setError } from "./elements.js";
import {
  reloadProfiles,
  reloadRegistry,
  setRoles,
  workspaceId,
} from "./state.js";

export type SettingsSection =
  | "workspace"
  | "roles"
  | "profiles"
  | "credentials"
  | "skills"
  | "maintenance";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "workspace", label: "工作区" },
  { id: "roles", label: "角色" },
  { id: "profiles", label: "Agent Profiles" },
  { id: "credentials", label: "凭证" },
  { id: "skills", label: "Skills / MCP" },
  { id: "maintenance", label: "维护" },
];

let section: SettingsSection = "workspace";
let providers: ProviderRow[] = [];
let credentials: CredentialProjection[] = [];
let skills: BundledSkillListEntry[] = [];
let fullRoles: RoleRegistryEntryProjection[] = [];
let fullProfiles: AgentProfileProjection[] = [];
let settingsPolicy: DeliveryPolicy = "review";
let agentsContent = "";
let agentsEtag = "";
let agentsExists = false;
let retentionPreview: {
  candidateTaskCount?: number;
  candidateDeliveryCount?: number;
  keepTerminalTasksDays?: number;
  warnings?: string[];
  candidates?: unknown[];
} | null = null;
let loadError: string | null = null;
let loading = false;
/** Profile editor: skills/mcp drafts (next session; id/ref only). */
let profileEditId: string | null = null;
/** Working copies while a profile is open for edit — never secrets. */
let skillDrafts: SkillRefDraft[] = [];
let mcpDrafts: McpServerDraft[] = [];
/** Unsaved basic fields while skills/mcp list re-renders. */
let profileFieldDraft: {
  displayName: string;
  model: string;
  executable: string;
  envKey: string;
  credentialRef: string;
  baseUrl: string;
} | null = null;
/** Role editor: operational name of the role being edited. */
let roleEditName: string | null = null;

function openProfileEditor(id: string | null): void {
  profileEditId = id;
  profileFieldDraft = null;
  if (!id) {
    skillDrafts = [];
    mcpDrafts = [];
    return;
  }
  const p = fullProfiles.find((x) => x.id === id);
  skillDrafts = skillDraftsFromProjection(p?.skills);
  mcpDrafts = mcpDraftsFromProjection(p?.mcpServers);
}

/** Preserve basic form inputs across skill/mcp list re-renders. */
function captureProfileFieldDraft(): void {
  if (!profileEditId) return;
  profileFieldDraft = {
    displayName:
      (document.getElementById("prof-edit-name") as HTMLInputElement | null)?.value ?? "",
    model: (document.getElementById("prof-edit-model") as HTMLInputElement | null)?.value ?? "",
    executable:
      (document.getElementById("prof-edit-exe") as HTMLInputElement | null)?.value ?? "",
    envKey: (document.getElementById("prof-edit-env") as HTMLInputElement | null)?.value ?? "",
    credentialRef:
      (document.getElementById("prof-edit-cred") as HTMLInputElement | null)?.value ?? "",
    baseUrl: (document.getElementById("prof-edit-base") as HTMLInputElement | null)?.value ?? "",
  };
}

function configuredCredentialIds(): Set<string> {
  return new Set(credentials.map((c) => c.id));
}

export function getSettingsSection(): SettingsSection {
  return section;
}

export function setSettingsSection(next: SettingsSection): void {
  section = next;
  renderSettings();
  void loadSectionData(next);
}

export async function reloadSettings(): Promise<void> {
  loading = true;
  loadError = null;
  renderSettings();
  try {
    await Promise.all([
      loadProviders(),
      loadCredentials(),
      loadSkills(),
      workspaceId ? loadWorkspaceSettings() : Promise.resolve(),
      workspaceId ? loadRolesFull() : Promise.resolve(),
      loadProfilesFull(),
    ]);
    loading = false;
    renderSettings();
    await loadSectionData(section);
  } catch (err) {
    loading = false;
    loadError = err instanceof Error ? err.message : String(err);
    renderSettings();
  }
}

async function loadSectionData(s: SettingsSection): Promise<void> {
  try {
    if (s === "workspace" && workspaceId) {
      await Promise.all([loadWorkspaceSettings(), loadAgents()]);
    } else if (s === "roles" && workspaceId) {
      await loadRolesFull();
    } else if (s === "profiles") {
      await Promise.all([loadProfilesFull(), loadProviders(), loadCredentials()]);
    } else if (s === "credentials") {
      await loadCredentials();
    } else if (s === "skills") {
      await Promise.all([loadSkills(), loadProfilesFull(), loadCredentials()]);
    } else if (s === "maintenance" && workspaceId) {
      await loadRetentionPreview();
    }
    renderSettings();
  } catch (err) {
    setError(err);
  }
}

async function loadProviders(): Promise<void> {
  const result = (await window.tentDesktop.rpc("provider.catalog", {})) as {
    providers: ProviderCatalogEntry[];
  };
  providers = mapProviderCatalogRows(result.providers || []);
}

async function loadCredentials(): Promise<void> {
  const result = (await window.tentDesktop.rpc("credential.list", {})) as {
    credentials: CredentialProjection[];
  };
  credentials = result.credentials || [];
}

async function loadSkills(): Promise<void> {
  const result = (await window.tentDesktop.rpc("skill.list", {})) as {
    skills: BundledSkillListEntry[];
  };
  skills = result.skills || [];
}

async function loadWorkspaceSettings(): Promise<void> {
  if (!workspaceId) return;
  const result = (await window.tentDesktop.rpc("workspace.settings", {
    workspaceId,
  })) as { settings?: { defaultDeliveryPolicy?: DeliveryPolicy } };
  settingsPolicy = result.settings?.defaultDeliveryPolicy || "review";
}

async function loadAgents(): Promise<void> {
  if (!workspaceId) return;
  const result = (await window.tentDesktop.rpc("workspace.agents", {
    workspaceId,
  })) as { content?: string; etag?: string; exists?: boolean };
  agentsContent = result.content ?? "";
  agentsEtag = result.etag ?? "";
  agentsExists = result.exists === true;
}

async function loadRolesFull(): Promise<void> {
  if (!workspaceId) return;
  const result = (await window.tentDesktop.rpc("registry.roles", {
    workspaceId,
  })) as { roles: RoleRegistryEntryProjection[] };
  fullRoles = result.roles || [];
  setRoles(
    fullRoles.map((r) => ({
      name: r.name,
      description: r.displayName || r.description,
    }))
  );
}

async function loadProfilesFull(): Promise<void> {
  const result = (await window.tentDesktop.rpc("profile.list", {})) as {
    profiles: AgentProfileProjection[];
  };
  fullProfiles = result.profiles || [];
  await reloadProfiles();
}

async function loadRetentionPreview(): Promise<void> {
  if (!workspaceId) return;
  retentionPreview = (await window.tentDesktop.rpc("operationalRetention.preview", {
    workspaceId,
    actor: "user",
  })) as typeof retentionPreview;
}

export function renderSettings(): void {
  const hostEl = el.settingsHost;
  if (!hostEl) return;

  const nav = SECTIONS.map((s) => {
    const active = s.id === section ? " is-active" : "";
    return `<button type="button" class="settings-nav-item${active}" data-settings-nav="${s.id}">${escapeHtml(s.label)}</button>`;
  }).join("");

  let body = "";
  if (loading && !providers.length && !fullProfiles.length) {
    body = `<p class="muted">加载中…</p>`;
  } else if (loadError) {
    body = `<p class="muted">${escapeHtml(loadError)}</p>`;
  } else {
    body = renderSectionBody(section);
  }

  hostEl.innerHTML = `
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置分区">${nav}</nav>
      <div class="settings-body" id="settings-body">${body}</div>
    </div>`;

  hostEl.querySelectorAll<HTMLElement>("[data-settings-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-settings-nav") as SettingsSection | null;
      if (id) setSettingsSection(id);
    });
  });
  wireSection(section, hostEl);
}

function renderSectionBody(s: SettingsSection): string {
  switch (s) {
    case "workspace":
      return renderWorkspace();
    case "roles":
      return renderRoles();
    case "profiles":
      return renderProfiles();
    case "credentials":
      return renderCredentials();
    case "skills":
      return renderSkills();
    case "maintenance":
      return renderMaintenance();
    default:
      return "";
  }
}

function renderWorkspace(): string {
  if (!workspaceId) {
    return `<div class="empty"><p class="empty-title">打开工作区</p></div>`;
  }
  const opts = DELIVERY_POLICY_OPTIONS.map(
    (o) =>
      `<option value="${o.value}"${o.value === settingsPolicy ? " selected" : ""}>${escapeHtml(o.label)}</option>`
  ).join("");
  return `
    <div class="settings-block">
      <div class="surface-section-head">交付策略</div>
      <div class="settings-row">
        <select id="set-delivery-policy" class="field">${opts}</select>
        <button type="button" id="btn-save-policy" class="btn btn-secondary">保存</button>
      </div>
    </div>
    <div class="settings-block">
      <div class="surface-section-head">AGENTS.md ${agentsExists ? "" : `<span class="faint">（尚未创建）</span>`}</div>
      <textarea id="set-agents" class="line-input settings-agents" rows="12" spellcheck="false">${escapeHtml(agentsContent)}</textarea>
      <div class="settings-row">
        <button type="button" id="btn-save-agents" class="btn btn-primary">保存 AGENTS.md</button>
      </div>
    </div>`;
}

function renderRoles(): string {
  if (!workspaceId) {
    return `<div class="empty"><p class="empty-title">打开工作区</p></div>`;
  }
  const list =
    fullRoles.length === 0
      ? `<p class="muted">暂无角色</p>`
      : `<ul class="settings-list">${fullRoles
          .map((r) => {
            const label = r.displayName && r.displayName !== r.name ? `${r.displayName} · ${r.name}` : r.name;
            const pol = r.a2aPolicy || "deny";
            const rosterBit =
              r.roster && r.roster.length ? ` · roster ${r.roster.length}` : "";
            const editing = roleEditName === r.name;
            return `<li class="settings-list-item${editing ? " is-editing" : ""}">
              <div class="settings-list-main">
                <strong>${escapeHtml(label)}</strong>
                <span class="muted">a2a ${escapeHtml(pol)}${escapeHtml(rosterBit)}</span>
                ${r.roleId ? `<span class="faint"><code>${escapeHtml(r.roleId)}</code></span>` : ""}
                ${r.description ? `<span class="muted">${escapeHtml(r.description)}</span>` : ""}
              </div>
              <div class="settings-list-actions">
                <button type="button" class="btn btn-ghost" data-role-edit="${escapeHtml(r.name)}" title="编辑">编辑</button>
                <button type="button" class="btn btn-ghost" data-role-delete="${escapeHtml(r.name)}" title="删除">删除</button>
              </div>
            </li>`;
          })
          .join("")}</ul>`;

  const editing = roleEditName ? fullRoles.find((r) => r.name === roleEditName) : null;
  const editor = editing
    ? renderRoleEditor(editing)
    : `<div class="settings-block">
      <div class="surface-section-head">新建</div>
      <div class="settings-form">
        <input id="role-name" class="field" placeholder="name（运营键，创建后不可改）" autocomplete="off" />
        <input id="role-display" class="field" placeholder="显示名（可选）" />
        <input id="role-description" class="field" placeholder="描述（可选）" />
        <textarea id="role-prompt" class="field settings-role-prompt" rows="3" placeholder="prompt（可选）"></textarea>
        <input id="role-color" class="field" placeholder="颜色 token（可选，如 gray）" />
        <select id="role-a2a" class="field">
          <option value="deny">a2a: deny</option>
          <option value="ask">a2a: ask</option>
          <option value="allow">a2a: allow</option>
        </select>
        <button type="button" id="btn-role-create" class="btn btn-primary">创建</button>
      </div>
    </div>`;

  return `
    <div class="settings-block">
      <div class="surface-section-head">角色</div>
      <p class="muted">运营键 name 不可改；显示名 / prompt / a2a / 白名单经 registry.role.update。</p>
      ${list}
    </div>
    ${editor}`;
}

function renderRoleEditor(role: RoleRegistryEntryProjection): string {
  const pol = role.a2aPolicy || "deny";
  const rosterText = formatRosterText(role.roster);
  return `
    <div class="settings-block">
      <div class="surface-section-head">编辑角色 · ${escapeHtml(role.name)}
        <button type="button" id="btn-role-edit-close" class="btn btn-ghost">关闭</button>
      </div>
      <p class="muted">id <code>${escapeHtml(role.roleId || "—")}</code> · 运营键 <code>${escapeHtml(role.name)}</code>（不可改名）</p>
      <div class="settings-form">
        <label class="settings-label" for="role-edit-display">显示名</label>
        <input id="role-edit-display" class="field" value="${escapeHtml(role.displayName || "")}" placeholder="留空则回退到运营键" />
        <label class="settings-label" for="role-edit-description">描述</label>
        <input id="role-edit-description" class="field" value="${escapeHtml(role.description || "")}" />
        <label class="settings-label" for="role-edit-prompt">prompt</label>
        <textarea id="role-edit-prompt" class="field settings-role-prompt" rows="5">${escapeHtml(role.prompt || "")}</textarea>
        <label class="settings-label" for="role-edit-color">颜色</label>
        <input id="role-edit-color" class="field" value="${escapeHtml(role.color || "")}" placeholder="gray / blue …" />
        <label class="settings-label" for="role-edit-a2a">a2aPolicy</label>
        <select id="role-edit-a2a" class="field">
          <option value="deny"${pol === "deny" ? " selected" : ""}>deny</option>
          <option value="ask"${pol === "ask" ? " selected" : ""}>ask</option>
          <option value="allow"${pol === "allow" ? " selected" : ""}>allow</option>
        </select>
        <label class="settings-label" for="role-edit-roster">roster（逗号分隔 agentId；空=清空）</label>
        <input id="role-edit-roster" class="field" value="${escapeHtml(rosterText)}" placeholder="例如 core-worker" />
        <div class="settings-row">
          <button type="button" id="btn-role-save" class="btn btn-primary">保存</button>
        </div>
      </div>
    </div>`;
}

function renderProfiles(): string {
  const providerNote =
    providers.length === 0
      ? `<p class="muted">provider.catalog 不可用</p>`
      : `<ul class="settings-provider-list">${providers
          .map(
            (p) =>
              `<li><code>${escapeHtml(p.adapterId)}</code>
              <span class="badge-level" data-level="${escapeHtml(String(p.verificationLevel))}">${escapeHtml(p.levelLabel)}</span>
              ${p.canResume ? `<span class="faint">resume</span>` : ""}
              ${p.notes ? `<span class="muted">${escapeHtml(p.notes)}</span>` : ""}</li>`
          )
          .join("")}</ul>`;

  const list =
    fullProfiles.length === 0
      ? `<p class="muted">暂无 profile</p>`
      : `<ul class="settings-list">${fullProfiles
          .map((p) => {
            const level = providers.find((x) => x.adapterId === p.adapterId);
            const levelBit = level
              ? `<span class="badge-level" data-level="${escapeHtml(String(level.verificationLevel))}">${escapeHtml(level.levelLabel)}</span>`
              : `<span class="faint">未收录 catalog</span>`;
            const cred =
              p.credentialRef != null
                ? p.credentialExists
                  ? `凭证已配置`
                  : `凭证缺失`
                : "";
            const label = profileDisplayLabel(p);
            return `<li class="settings-list-item">
              <div class="settings-list-main">
                <strong>${escapeHtml(label)}</strong>
                <span class="faint"><code>${escapeHtml(p.id)}</code> · <code>${escapeHtml(p.adapterId)}</code></span>
                <span class="muted">${p.model ? escapeHtml(p.model) : ""}</span>
                ${levelBit}
                ${cred ? `<span class="faint">${escapeHtml(cred)}</span>` : ""}
              </div>
              <div class="settings-list-actions">
                <button type="button" class="btn btn-ghost" data-profile-edit="${escapeHtml(p.id)}">编辑</button>
                <button type="button" class="btn btn-ghost" data-profile-delete="${escapeHtml(p.id)}">删除</button>
              </div>
            </li>`;
          })
          .join("")}</ul>`;

  const editing = profileEditId
    ? fullProfiles.find((p) => p.id === profileEditId)
    : null;
  const editor = editing
    ? renderProfileEditor(editing)
    : `<div class="settings-block">
        <div class="surface-section-head">新建 profile</div>
        <p class="muted">${escapeHtml(PROFILE_NEXT_SESSION_TIP)}</p>
        <div class="settings-form">
          <label class="settings-label" for="prof-id">id（创建后不可改）</label>
          <input id="prof-id" class="field" placeholder="id" autocomplete="off" />
          <label class="settings-label" for="prof-adapter">adapterId（创建后不可改）</label>
          <input id="prof-adapter" class="field" placeholder="adapterId" list="adapter-list" autocomplete="off" />
          <datalist id="adapter-list">${providers.map((p) => `<option value="${escapeHtml(p.adapterId)}">`).join("")}</datalist>
          <label class="settings-label" for="prof-name">显示名</label>
          <input id="prof-name" class="field" placeholder="displayName" />
          <input id="prof-model" class="field" placeholder="model" />
          <input id="prof-env" class="field" placeholder="envKey（环境变量名，非 secret）" />
          <input id="prof-cred" class="field" placeholder="credentialRef（凭证 id，非 secret）" />
          <button type="button" id="btn-prof-create" class="btn btn-primary">创建</button>
        </div>
      </div>`;

  return `
    <div class="settings-block">
      <div class="surface-section-head">Provider 验证级别</div>
      <p class="faint">权威来源 provider.catalog · 忠实区分 mock-tested / opt-in-live-probe / live-verified · 「有脚本」≠ 全面认证 · live-verified 仅指本机已证</p>
      ${providerNote}
    </div>
    <div class="settings-block">
      <div class="surface-section-head">Profiles</div>
      <p class="muted">${escapeHtml(PROFILE_NEXT_SESSION_TIP)}</p>
      ${list}
    </div>
    ${editor}`;
}

function renderProfileEditor(p: AgentProfileProjection): string {
  const label = profileDisplayLabel(p);
  const fields = profileFieldDraft ?? {
    displayName: p.displayName || "",
    model: p.model || "",
    executable: p.executable || "",
    envKey: p.envKey || "",
    credentialRef: p.credentialRef || "",
    baseUrl: p.baseUrl || "",
  };
  const credIds = configuredCredentialIds();
  const skillList =
    skillDrafts.length === 0
      ? `<p class="muted">无 skill 引用</p>`
      : `<ul class="settings-list">${skillDrafts
          .map((s) => {
            const src = skillSourceLine(s);
            return `<li class="settings-list-item">
              <div class="settings-list-main">
                <label class="settings-check">
                  <input type="checkbox" data-skill-toggle="${escapeHtml(s.name)}"${s.enabled ? " checked" : ""} />
                  <strong><code>${escapeHtml(s.name)}</code></strong>
                </label>
                <span class="muted">${escapeHtml(src)}</span>
              </div>
              <div class="settings-list-actions">
                <button type="button" class="btn btn-ghost" data-skill-remove="${escapeHtml(s.name)}" title="移除引用">移除</button>
              </div>
            </li>`;
          })
          .join("")}</ul>`;

  const mcpList =
    mcpDrafts.length === 0
      ? `<p class="muted">无 MCP 服务器</p>`
      : `<ul class="settings-list">${mcpDrafts
          .map((m) => {
            const src = mcpSourceLine(m);
            const credLine = mcpCredentialStatusLine(m, credIds);
            return `<li class="settings-list-item">
              <div class="settings-list-main">
                <label class="settings-check">
                  <input type="checkbox" data-mcp-toggle="${escapeHtml(m.name)}"${m.enabled ? " checked" : ""} />
                  <strong><code>${escapeHtml(m.name)}</code></strong>
                </label>
                <span class="muted">${escapeHtml(src)}</span>
                ${
                  credLine
                    ? `<span class="faint">凭证 ${escapeHtml(credLine)}</span>`
                    : ""
                }
              </div>
              <div class="settings-list-actions">
                <button type="button" class="btn btn-ghost" data-mcp-remove="${escapeHtml(m.name)}" title="移除">移除</button>
              </div>
            </li>`;
          })
          .join("")}</ul>`;

  const credOptions = credentials
    .map((c) => `<option value="${escapeHtml(c.id)}">`)
    .join("");

  return `
    <div class="settings-block">
      <div class="surface-section-head">编辑 · ${escapeHtml(label)}
        <button type="button" class="btn btn-ghost" id="btn-prof-edit-close">关闭</button>
      </div>
      <p class="muted">id <code>${escapeHtml(p.id)}</code> · adapterId <code>${escapeHtml(p.adapterId)}</code>（均不可改）</p>
      <p class="faint">${escapeHtml(PROFILE_NEXT_SESSION_TIP)} · 运行中 session 不热更新 · 勿写 secret</p>
      <div class="settings-form">
        <label class="settings-label" for="prof-edit-name">显示名</label>
        <input id="prof-edit-name" class="field" value="${escapeHtml(fields.displayName)}" placeholder="留空则回退到 id" />
        <label class="settings-label" for="prof-edit-model">model</label>
        <input id="prof-edit-model" class="field" value="${escapeHtml(fields.model)}" placeholder="model" />
        <label class="settings-label" for="prof-edit-exe">executable</label>
        <input id="prof-edit-exe" class="field" value="${escapeHtml(fields.executable)}" placeholder="executable" />
        <label class="settings-label" for="prof-edit-env">envKey（环境变量名）</label>
        <input id="prof-edit-env" class="field" value="${escapeHtml(fields.envKey)}" placeholder="envKey" />
        <label class="settings-label" for="prof-edit-cred">credentialRef（凭证 id）</label>
        <input id="prof-edit-cred" class="field" value="${escapeHtml(fields.credentialRef)}" placeholder="credentialRef" list="cred-ref-list" />
        <datalist id="cred-ref-list">${credOptions}</datalist>
        <label class="settings-label" for="prof-edit-base">baseUrl</label>
        <input id="prof-edit-base" class="field" value="${escapeHtml(fields.baseUrl)}" placeholder="baseUrl" />
      </div>
    </div>
    <div class="settings-block">
      <div class="surface-section-head">Skills</div>
      <p class="faint">只保存 name/path/enabled · 不存 displayName · ${escapeHtml(PROFILE_SKILLS_METADATA_TIP)} · ${escapeHtml(PROFILE_NEXT_SESSION_TIP)}</p>
      ${skillList}
      <div class="settings-form settings-form-inline">
        <input id="skill-add-name" class="field" placeholder="skill name（id）" autocomplete="off" list="bundled-skill-list" />
        <datalist id="bundled-skill-list">${skills.map((s) => `<option value="${escapeHtml(s.name)}">`).join("")}</datalist>
        <input id="skill-add-path" class="field" placeholder="绝对 path（可选）" autocomplete="off" />
        <button type="button" id="btn-skill-add" class="btn btn-secondary">添加引用</button>
      </div>
    </div>
    <div class="settings-block">
      <div class="surface-section-head">MCP Servers</div>
      <p class="faint">只保存 id/ref · credential 仅显示已配置 · ${escapeHtml(PROFILE_NEXT_SESSION_TIP)}</p>
      ${mcpList}
      <div class="settings-form">
        <div class="settings-form-inline">
          <input id="mcp-add-name" class="field" placeholder="name" autocomplete="off" />
          <select id="mcp-add-transport" class="field field-compact">
            <option value="stdio">stdio</option>
            <option value="http">http</option>
          </select>
        </div>
        <input id="mcp-add-command" class="field" placeholder="command（stdio）" autocomplete="off" />
        <input id="mcp-add-url" class="field" placeholder="url（http）" autocomplete="off" />
        <div class="settings-form-inline">
          <input id="mcp-add-env-name" class="field" placeholder="env/header 名（可选）" autocomplete="off" />
          <input id="mcp-add-env-ref" class="field" placeholder="credential vault id（可选）" list="cred-ref-list" autocomplete="off" />
        </div>
        <button type="button" id="btn-mcp-add" class="btn btn-secondary">添加 MCP</button>
      </div>
    </div>
    <div class="settings-block">
      <div class="settings-row">
        <button type="button" id="btn-prof-save" class="btn btn-primary">保存（下次会话生效）</button>
      </div>
    </div>`;
}

function renderCredentials(): string {
  const list =
    credentials.length === 0
      ? `<p class="muted">无已配置凭证</p>`
      : `<ul class="settings-list">${credentials
          .map((c) => {
            const row = credentialListRow(c);
            return `<li class="settings-list-item">
              <div class="settings-list-main">
                <strong><code>${escapeHtml(row.id)}</code></strong>
                <span class="muted">${escapeHtml(row.type)} · ${escapeHtml(row.status)}</span>
                ${row.label ? `<span class="faint">${escapeHtml(row.label)}</span>` : ""}
                ${row.updatedAt ? `<span class="faint">${escapeHtml(row.updatedAt)}</span>` : ""}
              </div>
              <div class="settings-list-actions">
                <button type="button" class="btn btn-ghost" data-cred-delete="${escapeHtml(row.id)}" title="删除凭证">删除</button>
              </div>
            </li>`;
          })
          .join("")}</ul>`;

  return `
    <div class="settings-block">
      <div class="surface-section-head">凭证</div>
      <p class="faint">仅显示 ref id · ${escapeHtml(CREDENTIAL_VAULT_TYPE)} · 已配置 · 绝不读回 secret</p>
      ${list}
    </div>
    <div class="settings-block">
      <div class="surface-section-head">设置 / 更新</div>
      <div class="settings-form">
        <input id="cred-id" class="field" placeholder="id（vault ref）" autocomplete="off" />
        <input id="cred-label" class="field" placeholder="label（可选，非 secret）" autocomplete="off" />
        <input id="cred-secret" class="field" type="password" placeholder="secret（提交后立即清空）" autocomplete="new-password" />
        <button type="button" id="btn-cred-set" class="btn btn-primary">保存</button>
      </div>
    </div>`;
}

function renderSkills(): string {
  const skillList =
    skills.length === 0
      ? `<p class="muted">无 bundled skills</p>`
      : `<ul class="settings-list">${skills
          .map((s) => {
            const targets = (s.targets || [])
              .map((t) => `${t.target}${t.installed ? "✓" : "·"}`)
              .join(" ");
            return `<li class="settings-list-item">
              <div class="settings-list-main">
                <strong>${escapeHtml(s.name)}</strong>
                <span class="muted">${escapeHtml(targets)}</span>
              </div>
              <div class="settings-list-actions">
                <button type="button" class="btn btn-secondary" data-skill-install="${escapeHtml(s.name)}">安装</button>
              </div>
            </li>`;
          })
          .join("")}</ul>`;

  const credIds = configuredCredentialIds();
  const mcpNote = `
    <p class="muted">MCP / Profile Skills 在 Agent Profile 编辑器中用列表 + 启用开关管理。${escapeHtml(PROFILE_NEXT_SESSION_TIP)}。运行中 session 不热更新。</p>
    <p class="faint">无全局 mcp.* RPC · 见契约缺口 mcp.global-config · 不伪造全局目录</p>
    <ul class="settings-list">${fullProfiles
      .map((p) => {
        const skillBits = (p.skills || [])
          .map((s) => `${s.name}${s.enabled === false ? "·关" : "·开"}`)
          .join(" ");
        const mcpBits = (p.mcpServers || [])
          .map((m) => {
            const cred = mcpCredentialStatusLine(m, credIds);
            return `${m.name}${m.enabled === false ? "·关" : "·开"}${cred ? `(${cred})` : ""}`;
          })
          .join(" ");
        return `<li class="settings-list-item">
          <div class="settings-list-main">
            <strong>${escapeHtml(profileDisplayLabel(p))}</strong>
            <span class="faint"><code>${escapeHtml(p.id)}</code></span>
            <span class="muted">skills ${escapeHtml(skillBits || "—")}</span>
            <span class="muted">mcp ${escapeHtml(mcpBits || "—")}</span>
          </div>
          <div class="settings-list-actions">
            <button type="button" class="btn btn-ghost" data-profile-edit="${escapeHtml(p.id)}">编辑 Skills/MCP</button>
          </div>
        </li>`;
      })
      .join("") || `<li class="muted">无 profile</li>`}</ul>`;

  return `
    <div class="settings-block">
      <div class="surface-section-head">Bundled Skills（skill.list / skill.install）</div>
      <p class="faint">仅安装 package bundled skills 到 ~/.agents 与 ~/.claude · 无 Skill 编辑器 / 远程市场 / uninstall</p>
      ${skillList}
      <div class="settings-row">
        <button type="button" id="btn-skill-install-all" class="btn btn-secondary">安装全部</button>
      </div>
    </div>
    <div class="settings-block">
      <div class="surface-section-head">Profile Skills / MCP</div>
      ${mcpNote}
    </div>`;
}

function renderMaintenance(): string {
  if (!workspaceId) {
    return `<div class="empty"><p class="empty-title">打开工作区</p></div>`;
  }
  const summary = retentionPreview
    ? retentionSummaryLine(retentionPreview)
    : "尚未预览";
  const gaps = DESKTOP_CONTRACT_GAPS.map(
    (g) =>
      `<li class="settings-gap-item">
        <code>${escapeHtml(g.id)}</code>
        <span class="muted">${escapeHtml(g.need)}</span>
      </li>`
  ).join("");

  return `
    <div class="settings-block">
      <div class="surface-section-head">运营保留</div>
      <p class="muted" id="retention-summary">${escapeHtml(summary)}</p>
      <div class="settings-row">
        <label class="settings-label" for="retention-days">保留天数</label>
        <input id="retention-days" class="field field-compact" type="number" min="0" max="3650" value="${retentionPreview?.keepTerminalTasksDays ?? 30}" />
        <button type="button" id="btn-retention-preview" class="btn btn-secondary">预览</button>
        <button type="button" id="btn-retention-purge" class="btn btn-primary">清理</button>
      </div>
    </div>
    <div class="settings-block">
      <div class="surface-section-head">契约缺口</div>
      <ul class="settings-gap-list">${gaps}</ul>
    </div>`;
}

function wireSection(s: SettingsSection, root: HTMLElement): void {
  if (s === "workspace") {
    document.getElementById("btn-save-policy")?.addEventListener("click", () => void onSavePolicy());
    document.getElementById("btn-save-agents")?.addEventListener("click", () => void onSaveAgents());
  }
  if (s === "roles") {
    document.getElementById("btn-role-create")?.addEventListener("click", () => void onRoleCreate());
    document.getElementById("btn-role-save")?.addEventListener("click", () => void onRoleSave());
    document.getElementById("btn-role-edit-close")?.addEventListener("click", () => {
      roleEditName = null;
      renderSettings();
    });
    root.querySelectorAll<HTMLElement>("[data-role-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        roleEditName = btn.getAttribute("data-role-edit");
        renderSettings();
      });
    });
    root.querySelectorAll<HTMLElement>("[data-role-delete]").forEach((btn) => {
      btn.addEventListener("click", () => void onRoleDelete(btn.getAttribute("data-role-delete")!));
    });
  }
  if (s === "profiles" || s === "skills") {
    document.getElementById("btn-prof-create")?.addEventListener("click", () => void onProfileCreate());
    document.getElementById("btn-prof-save")?.addEventListener("click", () => void onProfileSave());
    document.getElementById("btn-prof-edit-close")?.addEventListener("click", () => {
      openProfileEditor(null);
      renderSettings();
    });
    root.querySelectorAll<HTMLElement>("[data-profile-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-profile-edit");
        section = "profiles";
        openProfileEditor(id);
        // Ensure credentials loaded for MCP "已配置" status.
        void loadCredentials().then(() => renderSettings());
        renderSettings();
      });
    });
    root.querySelectorAll<HTMLElement>("[data-profile-delete]").forEach((btn) => {
      btn.addEventListener("click", () => void onProfileDelete(btn.getAttribute("data-profile-delete")!));
    });
    // Profile Skills / MCP list controls (draft-only until Save).
    root.querySelectorAll<HTMLInputElement>("[data-skill-toggle]").forEach((box) => {
      box.addEventListener("change", () => {
        const name = box.getAttribute("data-skill-toggle");
        if (!name) return;
        skillDrafts = setSkillEnabled(skillDrafts, name, box.checked);
      });
    });
    root.querySelectorAll<HTMLElement>("[data-skill-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const name = btn.getAttribute("data-skill-remove");
        if (!name) return;
        captureProfileFieldDraft();
        skillDrafts = removeSkillDraft(skillDrafts, name);
        renderSettings();
      });
    });
    document.getElementById("btn-skill-add")?.addEventListener("click", () => onSkillAdd());
    root.querySelectorAll<HTMLInputElement>("[data-mcp-toggle]").forEach((box) => {
      box.addEventListener("change", () => {
        const name = box.getAttribute("data-mcp-toggle");
        if (!name) return;
        mcpDrafts = setMcpEnabled(mcpDrafts, name, box.checked);
      });
    });
    root.querySelectorAll<HTMLElement>("[data-mcp-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const name = btn.getAttribute("data-mcp-remove");
        if (!name) return;
        captureProfileFieldDraft();
        mcpDrafts = removeMcpDraft(mcpDrafts, name);
        renderSettings();
      });
    });
    document.getElementById("btn-mcp-add")?.addEventListener("click", () => onMcpAdd());
  }
  if (s === "credentials") {
    document.getElementById("btn-cred-set")?.addEventListener("click", () => void onCredSet());
    root.querySelectorAll<HTMLElement>("[data-cred-delete]").forEach((btn) => {
      btn.addEventListener("click", () => void onCredDelete(btn.getAttribute("data-cred-delete")!));
    });
  }
  if (s === "skills") {
    document.getElementById("btn-skill-install-all")?.addEventListener("click", () => void onSkillInstall());
    root.querySelectorAll<HTMLElement>("[data-skill-install]").forEach((btn) => {
      btn.addEventListener("click", () =>
        void onSkillInstall([btn.getAttribute("data-skill-install")!])
      );
    });
  }
  if (s === "maintenance") {
    document
      .getElementById("btn-retention-preview")
      ?.addEventListener("click", () => void onRetentionPreview());
    document
      .getElementById("btn-retention-purge")
      ?.addEventListener("click", () => void onRetentionPurge());
  }
}

async function onSavePolicy(): Promise<void> {
  if (!workspaceId) return;
  const sel = document.getElementById("set-delivery-policy") as HTMLSelectElement | null;
  const value = (sel?.value || "review") as DeliveryPolicy;
  try {
    await window.tentDesktop.rpc("workspace.settings.update", {
      workspaceId,
      defaultDeliveryPolicy: value,
      actor: "user",
    });
    settingsPolicy = value;
    el.status.textContent = "工作区设置已保存";
  } catch (err) {
    setError(err);
  }
}

async function onSaveAgents(): Promise<void> {
  if (!workspaceId) return;
  const ta = document.getElementById("set-agents") as HTMLTextAreaElement | null;
  const content = ta?.value ?? "";
  try {
    const result = (await window.tentDesktop.rpc("workspace.agents.write", {
      workspaceId,
      content,
      baseEtag: agentsEtag || undefined,
      actor: "user",
    })) as { etag?: string; content?: string; exists?: boolean };
    agentsContent = result.content ?? content;
    agentsEtag = result.etag ?? agentsEtag;
    agentsExists = result.exists !== false;
    el.status.textContent = "AGENTS.md 已保存";
  } catch (err) {
    setError(err);
  }
}

async function onRoleCreate(): Promise<void> {
  if (!workspaceId) return;
  const name = (document.getElementById("role-name") as HTMLInputElement | null)?.value || "";
  const displayName =
    (document.getElementById("role-display") as HTMLInputElement | null)?.value || "";
  const description =
    (document.getElementById("role-description") as HTMLInputElement | null)?.value || "";
  const prompt =
    (document.getElementById("role-prompt") as HTMLTextAreaElement | HTMLInputElement | null)
      ?.value || "";
  const color = (document.getElementById("role-color") as HTMLInputElement | null)?.value || "";
  const a2aPolicy = (document.getElementById("role-a2a") as HTMLSelectElement | null)?.value as
    | "allow"
    | "ask"
    | "deny"
    | undefined;
  const built = validateRoleCreate({ name, displayName, description, prompt, color, a2aPolicy });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  const createBtn = document.getElementById("btn-role-create") as HTMLButtonElement | null;
  if (createBtn) createBtn.disabled = true;
  try {
    await window.tentDesktop.rpc("registry.role.create", {
      workspaceId,
      ...built.payload,
    });
    el.status.textContent = `已创建角色 ${name.trim()}`;
    roleEditName = name.trim();
    await loadRolesFull();
    await reloadRegistry();
    renderSettings();
  } catch (err) {
    setError(err);
    if (createBtn) createBtn.disabled = false;
  }
}

async function onRoleSave(): Promise<void> {
  if (!workspaceId || !roleEditName) return;
  const role = fullRoles.find((r) => r.name === roleEditName);
  const displayName =
    (document.getElementById("role-edit-display") as HTMLInputElement | null)?.value || "";
  const description =
    (document.getElementById("role-edit-description") as HTMLInputElement | null)?.value || "";
  const prompt =
    (document.getElementById("role-edit-prompt") as HTMLTextAreaElement | null)?.value || "";
  const color = (document.getElementById("role-edit-color") as HTMLInputElement | null)?.value || "";
  const a2aPolicy = (document.getElementById("role-edit-a2a") as HTMLSelectElement | null)
    ?.value as "allow" | "ask" | "deny" | undefined;
  const rosterText =
    (document.getElementById("role-edit-roster") as HTMLInputElement | null)?.value || "";
  const built = validateRoleUpdate({
    name: roleEditName,
    roleId: role?.roleId,
    displayName,
    description,
    prompt,
    color,
    a2aPolicy,
    rosterText,
  });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  const saveBtn = document.getElementById("btn-role-save") as HTMLButtonElement | null;
  if (saveBtn) saveBtn.disabled = true;
  try {
    await window.tentDesktop.rpc("registry.role.update", {
      workspaceId,
      ...built.payload,
    });
    el.status.textContent = `已更新角色 ${roleEditName}`;
    await loadRolesFull();
    await reloadRegistry();
    renderSettings();
  } catch (err) {
    setError(err);
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function onRoleDelete(name: string): Promise<void> {
  if (!workspaceId) return;
  if (!window.confirm(`删除角色「${name}」？确认须等于运营键。`)) return;
  try {
    await window.tentDesktop.rpc("registry.role.delete", {
      workspaceId,
      name,
      confirmation: name,
      actor: "user",
    });
    if (roleEditName === name) roleEditName = null;
    el.status.textContent = `已删除角色 ${name}`;
    await loadRolesFull();
    await reloadRegistry();
    renderSettings();
  } catch (err) {
    setError(err);
  }
}

async function onProfileCreate(): Promise<void> {
  const draft = {
    id: (document.getElementById("prof-id") as HTMLInputElement | null)?.value || "",
    adapterId: (document.getElementById("prof-adapter") as HTMLInputElement | null)?.value || "",
    displayName: (document.getElementById("prof-name") as HTMLInputElement | null)?.value || "",
    model: (document.getElementById("prof-model") as HTMLInputElement | null)?.value || "",
    envKey: (document.getElementById("prof-env") as HTMLInputElement | null)?.value || "",
    credentialRef: (document.getElementById("prof-cred") as HTMLInputElement | null)?.value || "",
  };
  const built = validateProfileCreate(draft);
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  const createBtn = document.getElementById("btn-prof-create") as HTMLButtonElement | null;
  if (createBtn) createBtn.disabled = true;
  try {
    await window.tentDesktop.rpc("profile.create", built.payload);
    el.status.textContent = `已创建 profile ${draft.id.trim()}`;
    await loadProfilesFull();
    renderSettings();
  } catch (err) {
    setError(err);
    if (createBtn) createBtn.disabled = false;
  }
}

function onSkillAdd(): void {
  const name = (document.getElementById("skill-add-name") as HTMLInputElement | null)?.value || "";
  const path = (document.getElementById("skill-add-path") as HTMLInputElement | null)?.value || "";
  const built = validateSkillAddDraft({ name, path });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  if (skillDrafts.some((s) => s.name.toLowerCase() === built.entry.name.toLowerCase())) {
    el.status.textContent = `skill ${built.entry.name} 已在列表中`;
    return;
  }
  captureProfileFieldDraft();
  skillDrafts = [...skillDrafts, built.entry];
  renderSettings();
}

function onMcpAdd(): void {
  const name = (document.getElementById("mcp-add-name") as HTMLInputElement | null)?.value || "";
  const transport = ((document.getElementById("mcp-add-transport") as HTMLSelectElement | null)
    ?.value || "stdio") as "stdio" | "http";
  const command =
    (document.getElementById("mcp-add-command") as HTMLInputElement | null)?.value || "";
  const url = (document.getElementById("mcp-add-url") as HTMLInputElement | null)?.value || "";
  const envCredentialName =
    (document.getElementById("mcp-add-env-name") as HTMLInputElement | null)?.value || "";
  const envCredentialRef =
    (document.getElementById("mcp-add-env-ref") as HTMLInputElement | null)?.value || "";
  const built = validateMcpAddDraft({
    name,
    transport,
    command,
    url,
    envCredentialName,
    envCredentialRef,
  });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  if (mcpDrafts.some((m) => m.name.toLowerCase() === built.entry.name.toLowerCase())) {
    el.status.textContent = `MCP ${built.entry.name} 已在列表中`;
    return;
  }
  captureProfileFieldDraft();
  mcpDrafts = [...mcpDrafts, built.entry];
  renderSettings();
}

async function onProfileSave(): Promise<void> {
  if (!profileEditId) return;
  const built = validateProfileUpdate({
    id: profileEditId,
    displayName:
      (document.getElementById("prof-edit-name") as HTMLInputElement | null)?.value || "",
    model: (document.getElementById("prof-edit-model") as HTMLInputElement | null)?.value || "",
    executable:
      (document.getElementById("prof-edit-exe") as HTMLInputElement | null)?.value || "",
    envKey: (document.getElementById("prof-edit-env") as HTMLInputElement | null)?.value || "",
    credentialRef:
      (document.getElementById("prof-edit-cred") as HTMLInputElement | null)?.value || "",
    baseUrl: (document.getElementById("prof-edit-base") as HTMLInputElement | null)?.value || "",
  });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  // Skills / MCP from structured drafts only — never free-form JSON with secrets.
  const skillsPayload = buildSkillsPayload(skillDrafts);
  const mcpPayload = buildMcpServersPayload(mcpDrafts);
  const patch: Record<string, unknown> = {
    ...built.payload,
    // Empty array clears on server via parse path; use null only when intentionally empty? Backend accepts [].
    skills: skillsPayload.length ? skillsPayload : null,
    mcpServers: mcpPayload.length ? mcpPayload : null,
  };
  const saveBtn = document.getElementById("btn-prof-save") as HTMLButtonElement | null;
  if (saveBtn) saveBtn.disabled = true;
  try {
    await window.tentDesktop.rpc("profile.update", patch);
    el.status.textContent = `Profile 已保存 · 下次会话生效（运行中 session 不热更新）`;
    await loadProfilesFull();
    // Refresh drafts from server projection after save.
    openProfileEditor(profileEditId);
    renderSettings();
  } catch (err) {
    setError(err);
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function onProfileDelete(id: string): Promise<void> {
  if (!window.confirm(`删除 profile「${id}」？`)) return;
  try {
    await window.tentDesktop.rpc("profile.delete", { id });
    if (profileEditId === id) openProfileEditor(null);
    el.status.textContent = `已删除 profile ${id}`;
    await loadProfilesFull();
    renderSettings();
  } catch (err) {
    setError(err);
  }
}

async function onCredSet(): Promise<void> {
  const idEl = document.getElementById("cred-id") as HTMLInputElement | null;
  const labelEl = document.getElementById("cred-label") as HTMLInputElement | null;
  const secretEl = document.getElementById("cred-secret") as HTMLInputElement | null;
  const id = idEl?.value || "";
  const label = labelEl?.value || "";
  const secret = secretEl?.value || "";
  const built = validateCredentialSet({ id, secret, label });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  // Clear secret from DOM immediately after successful validate / before RPC —
  // never re-display. Local `built.payload.secret` is the only remaining copy for the call.
  if (secretEl) secretEl.value = "";
  const setBtn = document.getElementById("btn-cred-set") as HTMLButtonElement | null;
  if (setBtn) setBtn.disabled = true;
  try {
    // RPC: secret only on wire; response is id/metadata — never echo secret into UI state.
    await window.tentDesktop.rpc("credential.set", {
      id: built.payload.id,
      secret: built.payload.secret,
      ...(built.payload.label !== undefined ? { label: built.payload.label } : {}),
    });
    // Drop secret from local payload handle (do not keep in module state).
    (built.payload as { secret?: string }).secret = "";
    el.status.textContent = `凭证 ${built.payload.id} 已配置`;
    if (idEl) idEl.value = built.payload.id;
    await loadCredentials();
    renderSettings();
  } catch (err) {
    // Secret already cleared from DOM; user must re-enter (safer than echo).
    (built.payload as { secret?: string }).secret = "";
    setError(err);
    if (setBtn) setBtn.disabled = false;
  }
}

async function onCredDelete(id: string): Promise<void> {
  // Left-click confirm (window.confirm) — no secret shown.
  if (!window.confirm(`删除凭证「${id}」？此操作不可撤销。`)) return;
  try {
    await window.tentDesktop.rpc("credential.delete", { id });
    el.status.textContent = `已删除凭证 ${id}`;
    await loadCredentials();
    renderSettings();
  } catch (err) {
    setError(err);
  }
}

async function onSkillInstall(names?: string[]): Promise<void> {
  try {
    await window.tentDesktop.rpc("skill.install", names?.length ? { skills: names } : {});
    el.status.textContent = names?.length
      ? `已安装 skill ${names.join(", ")}`
      : "已安装全部 bundled skills";
    await loadSkills();
    renderSettings();
  } catch (err) {
    setError(err);
  }
}

async function onRetentionPreview(): Promise<void> {
  if (!workspaceId) return;
  const daysRaw = (document.getElementById("retention-days") as HTMLInputElement | null)?.value;
  const days = daysRaw !== undefined && daysRaw !== "" ? Number(daysRaw) : 30;
  try {
    retentionPreview = (await window.tentDesktop.rpc("operationalRetention.preview", {
      workspaceId,
      keepTerminalTasksDays: days,
      actor: "user",
    })) as typeof retentionPreview;
    el.status.textContent = "保留预览已更新";
    renderSettings();
  } catch (err) {
    setError(err);
  }
}

async function onRetentionPurge(): Promise<void> {
  if (!workspaceId) return;
  const daysRaw = (document.getElementById("retention-days") as HTMLInputElement | null)?.value;
  const days = daysRaw !== undefined && daysRaw !== "" ? Number(daysRaw) : 30;
  if (!window.confirm(`清理超过 ${days} 天的终端任务/交付？此操作不可撤销。`)) return;
  const purgeBtn = document.getElementById("btn-retention-purge") as HTMLButtonElement | null;
  if (purgeBtn) purgeBtn.disabled = true;
  try {
    const result = (await window.tentDesktop.rpc("operationalRetention.purge", {
      workspaceId,
      keepTerminalTasksDays: days,
      actor: "user",
    })) as { deletedCount?: number };
    el.status.textContent = `已清理 ${result.deletedCount ?? 0} 项`;
    await loadRetentionPreview();
    renderSettings();
  } catch (err) {
    setError(err);
    if (purgeBtn) purgeBtn.disabled = false;
  }
}
