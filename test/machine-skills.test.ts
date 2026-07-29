/**
 * Machine-local bundled skill list/install — offline.
 * Covers list, selective install, skip, force, dual targets, traversal / unknown target rejection.
 * Does not hit network; installs only under temp home / packageRoot.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  installSkills,
  listSkills,
  parseSkillTargetId,
  resolveCliSkillInstallDirs,
  skillTargetDir,
  SKILL_TARGET_IDS,
} from "../src/machine/skills.js";
import { CLIENT_METHODS, isClientMethod } from "../src/service/types.js";
import { createServiceClient } from "../src/service/client.js";
import { startLocalTentService } from "../src/service/service.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { FAKE_DEFAULT_PROFILE_ID } from "../src/service/profiles.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function tempDir(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

test("CLIENT_METHODS includes skill.list/install", () => {
  assert.ok(isClientMethod("skill.list"));
  assert.ok(isClientMethod("skill.install"));
  assert.ok(CLIENT_METHODS.includes("skill.list"));
  assert.ok(CLIENT_METHODS.includes("skill.install"));
  assert.equal(isClientMethod("skill.delete"), false);
  assert.equal(isClientMethod("skill.market"), false);
});

test("CLI target selector matches service target ids", async () => {
  const home = await tempDir("tent-skill-cli-target-");
  assert.deepEqual(resolveCliSkillInstallDirs("all", home), [
    skillTargetDir("shared-agents", home),
    skillTargetDir("claude", home),
  ]);
  assert.deepEqual(resolveCliSkillInstallDirs("claude", home), [
    skillTargetDir("claude", home),
  ]);
  assert.deepEqual(resolveCliSkillInstallDirs("shared-agents", home), [
    skillTargetDir("shared-agents", home),
  ]);
  assert.throws(() => resolveCliSkillInstallDirs("codex", home), /Unknown skill target/);
});

test("listSkills: reports bundled names and per-target installed status", async () => {
  const home = await tempDir("tent-skill-list-");
  const listed = await listSkills({ packageRoot: repoRoot, home });
  const names = listed.skills.map((s) => s.name).sort();
  assert.deepEqual(names, ["tent-init", "tent-role", "tent-task"]);

  for (const skill of listed.skills) {
    assert.equal(skill.targets.length, SKILL_TARGET_IDS.length);
    for (const t of skill.targets) {
      assert.ok(SKILL_TARGET_IDS.includes(t.target));
      assert.equal(t.installed, false);
      assert.equal(t.path, path.join(skillTargetDir(t.target, home), skill.name));
      assert.ok(t.path.startsWith(home));
    }
  }

  // Install one skill to one target only.
  await installSkills({
    packageRoot: repoRoot,
    home,
    skills: ["tent-task"],
    targets: ["claude"],
  });
  const after = await listSkills({ packageRoot: repoRoot, home });
  const agent = after.skills.find((s) => s.name === "tent-task");
  assert.ok(agent);
  const claude = agent!.targets.find((t) => t.target === "claude");
  const agents = agent!.targets.find((t) => t.target === "shared-agents");
  assert.equal(claude?.installed, true);
  assert.equal(agents?.installed, false);
});

test("installSkills: selective, skip, force, dual targets", async () => {
  const home = await tempDir("tent-skill-install-unit-");
  const bundledAgent = await fs.readFile(
    path.join(repoRoot, "skills", "tent-task", "SKILL.md"),
    "utf8"
  );

  const first = await installSkills({
    packageRoot: repoRoot,
    home,
    skills: ["tent-task"],
  });
  // Default both targets.
  assert.equal(first.filter((r) => r.status === "installed").length, 2);
  assert.ok(first.every((r) => r.skill === "tent-task"));
  assert.ok(first.some((r) => r.target === "claude"));
  assert.ok(first.some((r) => r.target === "shared-agents"));

  for (const id of SKILL_TARGET_IDS) {
    const p = path.join(skillTargetDir(id, home), "tent-task", "SKILL.md");
    assert.equal(await fs.readFile(p, "utf8"), bundledAgent);
  }

  // Skip without force.
  const skipped = await installSkills({
    packageRoot: repoRoot,
    home,
    skills: ["tent-task"],
    targets: ["claude"],
  });
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.status, "skipped");
  assert.match(skipped[0]!.reason ?? "", /already exists/);

  // Stale content + force overwrites only selected target.
  await fs.writeFile(
    path.join(skillTargetDir("claude", home), "tent-task", "SKILL.md"),
    "# stale\n",
    "utf8"
  );
  const forced = await installSkills({
    packageRoot: repoRoot,
    home,
    skills: ["tent-task"],
    targets: ["claude"],
    force: true,
  });
  assert.equal(forced[0]!.status, "installed");
  assert.equal(
    await fs.readFile(path.join(skillTargetDir("claude", home), "tent-task", "SKILL.md"), "utf8"),
    bundledAgent
  );
});

test("installSkills: rejects traversal, unknown skill, unknown target", async () => {
  const home = await tempDir("tent-skill-reject-");

  await assert.rejects(
    () =>
      installSkills({
        packageRoot: repoRoot,
        home,
        skills: ["../evil"],
      }),
    /Invalid skill name/
  );
  await assert.rejects(
    () =>
      installSkills({
        packageRoot: repoRoot,
        home,
        skills: ["tent-task/../../etc"],
      }),
    /Invalid skill name/
  );
  await assert.rejects(
    () =>
      installSkills({
        packageRoot: repoRoot,
        home,
        skills: ["not-a-real-skill-xyz"],
      }),
    /Unknown bundled skill/
  );
  await assert.rejects(
    () =>
      installSkills({
        packageRoot: repoRoot,
        home,
        targets: ["codex" as "claude"],
      }),
    /Unknown skill target/
  );
  assert.throws(() => parseSkillTargetId("codex"), /Unknown skill target/);
  assert.throws(() => parseSkillTargetId("claude/../x"), /Unknown skill target/);
});

test("RPC skill.list / skill.install: offline dual-target + validation", async () => {
  const home = await tempDir("tent-skill-rpc-home-");
  const dataDir = await tempDir("tent-skill-rpc-data-");
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: false,
    home,
    packageRoot: repoRoot,
    profiles: [
      {
        id: FAKE_DEFAULT_PROFILE_ID,
        adapterId: FAKE_ADAPTER_ID,
        fake: { waitForSignal: true },
      },
    ],
  });
  try {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    const listed = (await client.skillList()) as {
      skills: Array<{
        name: string;
        targets: Array<{ target: string; path: string; installed: boolean }>;
      }>;
    };
    assert.deepEqual(listed.skills.map((s) => s.name), ["tent-init", "tent-role", "tent-task"]);
    for (const s of listed.skills) {
      for (const t of s.targets) {
        assert.ok(t.path.startsWith(home), `path under injected home: ${t.path}`);
        assert.equal(t.installed, false);
      }
    }

    // Selective install to one target.
    const partial = (await client.skillInstall({
      skills: ["tent-task"],
      targets: ["claude"],
    })) as { results: Array<{ skill: string; status: string; target?: string }> };
    assert.equal(partial.results.length, 1);
    assert.equal(partial.results[0]!.status, "installed");
    assert.equal(partial.results[0]!.target, "claude");

    const afterPartial = (await client.skillList()) as typeof listed;
    const agent = afterPartial.skills.find((s) => s.name === "tent-task")!;
    assert.equal(agent.targets.find((t) => t.target === "claude")!.installed, true);
    assert.equal(agent.targets.find((t) => t.target === "shared-agents")!.installed, false);

    // Skip then force.
    const skip = (await client.skillInstall({
      skills: ["tent-task"],
      targets: ["claude"],
    })) as { results: Array<{ status: string }> };
    assert.equal(skip.results[0]!.status, "skipped");

    const force = (await client.skillInstall({
      skills: ["tent-task"],
      targets: ["claude"],
      force: true,
    })) as { results: Array<{ status: string }> };
    assert.equal(force.results[0]!.status, "installed");

    // Validation: traversal / unknown target / banned path params.
    await assert.rejects(
      () => client.skillInstall({ skills: ["../etc"] }),
      /Invalid skill name/
    );
    await assert.rejects(
      () => client.skillInstall({ targets: ["codex" as "claude"] }),
      /Unknown skill target/
    );
    await assert.rejects(
      () =>
        client.call("skill.install", {
          skills: ["tent-task"],
          source: "/tmp/evil",
        } as Record<string, unknown>),
      /does not accept source/
    );
    await assert.rejects(
      () =>
        client.call("skill.install", {
          workspaceId: "ws-1",
          skills: ["tent-task"],
        } as Record<string, unknown>),
      /does not accept workspaceId/
    );

    // Paths never hard-coded to a real user home.
    const diskAgent = path.join(home, ".claude", "skills", "tent-task", "SKILL.md");
    assert.equal(await exists(diskAgent), true);
  } finally {
    await svc.stop();
  }
});
