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
  DELIVERY_POLICY_OPTIONS,
  formatAllowedProfilesText,
  mapProviderCatalogRows,
  retentionSummaryLine,
  validateCredentialSet,
  validateProfileCreate,
  validateRoleCreate,
  validateRoleUpdate,
  type DeliveryPolicy,
  type ProviderRow,
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
let settingsPolicy: DeliveryPolicy = "manual";
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
/** Profile editor: skills/mcp JSON drafts (next session). */
let profileEditId: string | null = null;
/** Role editor: operational name of the role being edited. */
let roleEditName: string | null = null;

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
      await Promise.all([loadProfilesFull(), loadProviders()]);
    } else if (s === "credentials") {
      await loadCredentials();
    } else if (s === "skills") {
      await Promise.all([loadSkills(), loadProfilesFull()]);
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
  settingsPolicy = result.settings?.defaultDeliveryPolicy || "manual";
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
            const profilesBit =
              r.allowedProfiles && r.allowedProfiles.length
                ? ` · profiles ${r.allowedProfiles.length}`
                : "";
            const editing = roleEditName === r.name;
            return `<li class="settings-list-item${editing ? " is-editing" : ""}">
              <div class="settings-list-main">
                <strong>${escapeHtml(label)}</strong>
                <span class="muted">a2a ${escapeHtml(pol)}${escapeHtml(profilesBit)}</span>
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
  const profilesText = formatAllowedProfilesText(role.allowedProfiles);
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
        <label class="settings-label" for="role-edit-profiles">allowedProfiles（逗号分隔 profile id；空=清空）</label>
        <input id="role-edit-profiles" class="field" value="${escapeHtml(profilesText)}" placeholder="例如 grok-acp-default" />
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
            return `<li class="settings-list-item">
              <div class="settings-list-main">
                <strong>${escapeHtml(p.displayName || p.id)}</strong>
                <span class="muted">${escapeHtml(p.adapterId)}${p.model ? " · " + escapeHtml(p.model) : ""}</span>
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
        <div class="settings-form">
          <input id="prof-id" class="field" placeholder="id" />
          <input id="prof-adapter" class="field" placeholder="adapterId" list="adapter-list" />
          <datalist id="adapter-list">${providers.map((p) => `<option value="${escapeHtml(p.adapterId)}">`).join("")}</datalist>
          <input id="prof-name" class="field" placeholder="displayName" />
          <input id="prof-model" class="field" placeholder="model" />
          <input id="prof-env" class="field" placeholder="envKey" />
          <input id="prof-cred" class="field" placeholder="credentialRef" />
          <button type="button" id="btn-prof-create" class="btn btn-primary">创建</button>
        </div>
      </div>`;

  return `
    <div class="settings-block">
      <div class="surface-section-head">Provider 验证级别</div>
      <p class="faint">权威来源 provider.catalog · 非全部 live E2E</p>
      ${providerNote}
    </div>
    <div class="settings-block">
      <div class="surface-section-head">Profiles</div>
      ${list}
    </div>
    ${editor}`;
}

function renderProfileEditor(p: AgentProfileProjection): string {
  const skillsJson = JSON.stringify(p.skills || [], null, 2);
  const mcpJson = JSON.stringify(p.mcpServers || [], null, 2);
  return `
    <div class="settings-block">
      <div class="surface-section-head">编辑 · ${escapeHtml(p.id)}
        <button type="button" class="btn btn-ghost" id="btn-prof-edit-close">关闭</button>
      </div>
      <div class="settings-form">
        <input id="prof-edit-name" class="field" value="${escapeHtml(p.displayName || "")}" placeholder="displayName" />
        <input id="prof-edit-model" class="field" value="${escapeHtml(p.model || "")}" placeholder="model" />
        <input id="prof-edit-exe" class="field" value="${escapeHtml(p.executable || "")}" placeholder="executable" />
        <input id="prof-edit-env" class="field" value="${escapeHtml(p.envKey || "")}" placeholder="envKey" />
        <input id="prof-edit-cred" class="field" value="${escapeHtml(p.credentialRef || "")}" placeholder="credentialRef" />
        <input id="prof-edit-base" class="field" value="${escapeHtml(p.baseUrl || "")}" placeholder="baseUrl" />
        <label class="settings-label">skills（JSON · 下次 session 生效）</label>
        <textarea id="prof-edit-skills" class="line-input" rows="4" spellcheck="false">${escapeHtml(skillsJson)}</textarea>
        <label class="settings-label">mcpServers（JSON · 下次 session 生效 · 勿写 secret）</label>
        <textarea id="prof-edit-mcp" class="line-input" rows="6" spellcheck="false">${escapeHtml(mcpJson)}</textarea>
        <div class="settings-row">
          <button type="button" id="btn-prof-save" class="btn btn-primary">保存</button>
        </div>
      </div>
    </div>`;
}

function renderCredentials(): string {
  const list =
    credentials.length === 0
      ? `<p class="muted">无已配置凭证</p>`
      : `<ul class="settings-list">${credentials
          .map((c) => {
            const label = c.label || c.metadata?.label || c.id;
            return `<li class="settings-list-item">
              <div class="settings-list-main">
                <strong>${escapeHtml(label)}</strong>
                <span class="muted"><code>${escapeHtml(c.id)}</code> · 已配置</span>
                <span class="faint">${escapeHtml(c.updatedAt || "")}</span>
              </div>
              <div class="settings-list-actions">
                <button type="button" class="btn btn-ghost" data-cred-delete="${escapeHtml(c.id)}">删除</button>
              </div>
            </li>`;
          })
          .join("")}</ul>`;

  return `
    <div class="settings-block">
      <div class="surface-section-head">凭证</div>
      <p class="faint">仅显示配置状态 · 不读回 secret</p>
      ${list}
    </div>
    <div class="settings-block">
      <div class="surface-section-head">设置 / 更新</div>
      <div class="settings-form">
        <input id="cred-id" class="field" placeholder="id" autocomplete="off" />
        <input id="cred-label" class="field" placeholder="label（可选）" autocomplete="off" />
        <input id="cred-secret" class="field" type="password" placeholder="secret" autocomplete="new-password" />
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

  const mcpNote = `
    <p class="muted">MCP 挂在 Agent Profile 上编辑（Skills / MCP 分区或 Profiles 编辑器）。配置在<strong>下次 session</strong>生效。</p>
    <p class="faint">无全局 mcp.* RPC · 见契约缺口 mcp.global-config</p>
    <ul class="settings-list">${fullProfiles
      .map((p) => {
        const n = p.mcpServers?.length ?? 0;
        const sk = p.skills?.length ?? 0;
        return `<li class="settings-list-item">
          <div class="settings-list-main">
            <strong>${escapeHtml(p.displayName || p.id)}</strong>
            <span class="muted">skills ${sk} · mcp ${n}</span>
          </div>
          <div class="settings-list-actions">
            <button type="button" class="btn btn-ghost" data-profile-edit="${escapeHtml(p.id)}">编辑</button>
          </div>
        </li>`;
      })
      .join("") || `<li class="muted">无 profile</li>`}</ul>`;

  return `
    <div class="settings-block">
      <div class="surface-section-head">Bundled Skills</div>
      ${skillList}
      <div class="settings-row">
        <button type="button" id="btn-skill-install-all" class="btn btn-secondary">安装全部</button>
      </div>
    </div>
    <div class="settings-block">
      <div class="surface-section-head">MCP（per profile）</div>
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
      profileEditId = null;
      renderSettings();
    });
    root.querySelectorAll<HTMLElement>("[data-profile-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        profileEditId = btn.getAttribute("data-profile-edit");
        section = "profiles";
        renderSettings();
      });
    });
    root.querySelectorAll<HTMLElement>("[data-profile-delete]").forEach((btn) => {
      btn.addEventListener("click", () => void onProfileDelete(btn.getAttribute("data-profile-delete")!));
    });
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
  const value = (sel?.value || "manual") as DeliveryPolicy;
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
  const allowedProfilesText =
    (document.getElementById("role-edit-profiles") as HTMLInputElement | null)?.value || "";
  const built = validateRoleUpdate({
    name: roleEditName,
    roleId: role?.roleId,
    displayName,
    description,
    prompt,
    color,
    a2aPolicy,
    allowedProfilesText,
  });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
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
  try {
    await window.tentDesktop.rpc("profile.create", built.payload);
    el.status.textContent = `已创建 profile ${draft.id.trim()}`;
    await loadProfilesFull();
    renderSettings();
  } catch (err) {
    setError(err);
  }
}

async function onProfileSave(): Promise<void> {
  if (!profileEditId) return;
  const patch: Record<string, unknown> = { id: profileEditId };
  const name = (document.getElementById("prof-edit-name") as HTMLInputElement | null)?.value;
  const model = (document.getElementById("prof-edit-model") as HTMLInputElement | null)?.value;
  const exe = (document.getElementById("prof-edit-exe") as HTMLInputElement | null)?.value;
  const envKey = (document.getElementById("prof-edit-env") as HTMLInputElement | null)?.value;
  const cred = (document.getElementById("prof-edit-cred") as HTMLInputElement | null)?.value;
  const base = (document.getElementById("prof-edit-base") as HTMLInputElement | null)?.value;
  if (name !== undefined) patch.displayName = name.trim() || null;
  if (model !== undefined) patch.model = model.trim() || null;
  if (exe !== undefined) patch.executable = exe.trim() || null;
  if (envKey !== undefined) patch.envKey = envKey.trim() || null;
  if (cred !== undefined) patch.credentialRef = cred.trim() || null;
  if (base !== undefined) patch.baseUrl = base.trim() || null;

  const skillsRaw = (document.getElementById("prof-edit-skills") as HTMLTextAreaElement | null)
    ?.value;
  const mcpRaw = (document.getElementById("prof-edit-mcp") as HTMLTextAreaElement | null)?.value;
  try {
    if (skillsRaw !== undefined) {
      patch.skills = JSON.parse(skillsRaw || "[]");
    }
    if (mcpRaw !== undefined) {
      patch.mcpServers = JSON.parse(mcpRaw || "[]");
    }
  } catch {
    el.status.textContent = "skills / mcpServers 须为合法 JSON";
    return;
  }
  try {
    await window.tentDesktop.rpc("profile.update", patch);
    el.status.textContent = "Profile 已保存（MCP/Skills 下次 session 生效）";
    await loadProfilesFull();
    renderSettings();
  } catch (err) {
    setError(err);
  }
}

async function onProfileDelete(id: string): Promise<void> {
  if (!window.confirm(`删除 profile「${id}」？`)) return;
  try {
    await window.tentDesktop.rpc("profile.delete", { id });
    if (profileEditId === id) profileEditId = null;
    el.status.textContent = `已删除 profile ${id}`;
    await loadProfilesFull();
    renderSettings();
  } catch (err) {
    setError(err);
  }
}

async function onCredSet(): Promise<void> {
  const id = (document.getElementById("cred-id") as HTMLInputElement | null)?.value || "";
  const label = (document.getElementById("cred-label") as HTMLInputElement | null)?.value || "";
  const secretEl = document.getElementById("cred-secret") as HTMLInputElement | null;
  const secret = secretEl?.value || "";
  const built = validateCredentialSet({ id, secret, label });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    await window.tentDesktop.rpc("credential.set", built.payload);
    // Clear secret from DOM immediately — never re-display.
    if (secretEl) secretEl.value = "";
    el.status.textContent = `凭证 ${built.payload.id} 已配置`;
    await loadCredentials();
    renderSettings();
  } catch (err) {
    setError(err);
  }
}

async function onCredDelete(id: string): Promise<void> {
  if (!window.confirm(`删除凭证「${id}」？`)) return;
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
  }
}


