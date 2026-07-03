import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export async function makeTent(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-"));
  const box = (relativePath: string, frontmatter: string, body = "") => {
    const folderName = relativePath.split("/").pop() || relativePath;
    return fs
      .mkdir(path.join(dir, relativePath), { recursive: true })
      .then(() =>
        fs.writeFile(
          path.join(dir, relativePath, `${folderName}.md`),
          `---\n${frontmatter}\n---\n${body}\n`
        )
      );
  };
  await box("goal", "id: bx-goalzone\ntype: goal");
  await box("goal/挖新alpha", "id: bx-g1\ntype: goal\nstatus: doing");
  await box(
    "goal/挖新alpha/写表达式",
    "id: bx-g2\ntype: goal\nowner: executor\nstatus: doing"
  );
  await box("prompt", "id: bx-promptzone\ntype: prompt");
  await box(
    "prompt/表达式任务书",
    "id: bx-p1\ntype: prompt",
    "给 executor 的任务"
  );
  await box(
    "prompt/表达式任务书/草稿",
    "id: bx-p2\ntype: prompt\nwritable: true"
  );
  await box("output", "id: bx-outzone\ntype: output");
  await box("output/alpha仓库指针", "id: bx-o1\ntype: output");
  await fs.mkdir(path.join(dir, "temp"), { recursive: true });
  await box("prompt/旧站资料", "id: bx-a1\ntype: asset");
  return dir;
}

export function git(dir: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "The Tent Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "The Tent Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `git ${args.join(" ")} exit ${code}`));
    });
  });
}

export async function configureTestGitIdentity(dir: string): Promise<void> {
  await git(dir, "config", "user.name", "The Tent Test");
  await git(dir, "config", "user.email", "test@example.invalid");
}
