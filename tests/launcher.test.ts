import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  mountPlan,
  parseOptions,
  repositoryMounts,
  withSymlinkTargets,
} from "../scripts/sandbox.ts";

function fixture(fn: (root: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-test-")));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true });
  }
}

function jjStore(path: string) {
  for (const dir of ["store", "op_store", "op_heads"])
    mkdirSync(join(path, dir), { recursive: true });
  writeFileSync(join(path, "store", "type"), "git");
  writeFileSync(join(path, "op_store", "type"), "simple");
}

test("linked worktree mounts checkout and common Git directory without main checkout", () =>
  fixture((root) => {
    const main = join(root, "main"),
      work = join(root, "linked worktree");
    execFileSync("git", ["init", "-q", main]);
    execFileSync("git", [
      "-C",
      main,
      "worktree",
      "add",
      "--orphan",
      "-qb",
      "test",
      work,
    ]);
    assert.deepEqual(
      new Set(repositoryMounts(work)),
      new Set([work, join(main, ".git")]),
    );
  }));

test("arbitrary host directories cannot masquerade as shared JJ metadata", () =>
  fixture((root) => {
    const work = join(root, "work"),
      unrelated = join(root, "private");
    mkdirSync(join(work, ".jj"), { recursive: true });
    mkdirSync(unrelated);
    symlinkSync(unrelated, join(work, ".jj", "repo"));
    assert.throws(() => repositoryMounts(work), /JJ repository/);
  }));

test("JJ backing Git pointer must name a Git metadata directory", () =>
  fixture((root) => {
    const work = join(root, "work"),
      repo = join(work, ".jj", "repo"),
      unrelated = join(root, "private");
    jjStore(repo);
    mkdirSync(unrelated);
    writeFileSync(join(repo, "store", "git_target"), unrelated);
    assert.throws(() => repositoryMounts(work), /Git metadata/);
  }));

test("agent skills remain read-only when Codex skills link to the same directory", () =>
  fixture((root) => {
    const work = join(root, "work"),
      skills = join(root, ".agents", "skills");
    mkdirSync(work);
    mkdirSync(join(root, ".codex"));
    mkdirSync(skills, { recursive: true });
    symlinkSync(skills, join(root, ".codex", "skills"));
    assert.equal(mountPlan(work, root).get(skills), true);
  }));

test("read-only skill aliases into Codex keep a read-only overlay", () =>
  fixture((root) => {
    const work = join(root, "work"),
      target = join(root, ".codex", "shared-skill"),
      skills = join(root, ".agents", "skills");
    mkdirSync(work);
    mkdirSync(target, { recursive: true });
    mkdirSync(skills, { recursive: true });
    symlinkSync(target, join(skills, "example"));
    assert.equal(mountPlan(work, root).get(target), true);
  }));

test("external writable state file links require a shared parent for atomic updates", () =>
  fixture((root) => {
    const work = join(root, "work"),
      codex = join(root, ".codex"),
      other = join(root, "dotfiles");
    mkdirSync(work);
    mkdirSync(codex);
    mkdirSync(other);
    for (const name of ["config.toml", "auth.json"]) {
      const target = join(other, name);
      writeFileSync(target, "fixture");
      symlinkSync(target, join(codex, name));
    }
    assert.throws(() => mountPlan(work, root), /atomic updates/);
  }));

test("a symlinked Codex home is rejected before creating writable aliases", () =>
  fixture((root) => {
    const work = join(root, "work"),
      target = join(root, "state", "codex");
    mkdirSync(work);
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(root, ".codex"));
    assert.throws(() => mountPlan(work, root), /Codex directory.*symlink/);
  }));

test("chained skill symlinks fail clearly before VM creation", () =>
  fixture((root) => {
    const skills = join(root, "skills"),
      target = join(root, "actual");
    mkdirSync(skills);
    mkdirSync(target);
    symlinkSync(target, join(root, "intermediate"));
    symlinkSync(join(root, "intermediate"), join(skills, "example"));
    assert.throws(() => withSymlinkTargets([skills]), /chained symlink/);
  }));

test("JJ shared repository symlink is mounted without host parent", () =>
  fixture((root) => {
    const work = join(root, "work"),
      shared = join(root, "shared");
    mkdirSync(join(work, ".jj"), { recursive: true });
    jjStore(shared);
    symlinkSync(shared, join(work, ".jj", "repo"));
    assert.deepEqual(new Set(repositoryMounts(work)), new Set([work, shared]));
  }));

test("skill symlink targets are explicit mounts", () =>
  fixture((root) => {
    const skills = join(root, "skills"),
      target = join(root, "elsewhere", "skill");
    mkdirSync(skills);
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(skills, "example"));
    assert.deepEqual(
      new Set(withSymlinkTargets([skills])),
      new Set([skills, target]),
    );
  }));

test("skill symlink cannot expose host home", () =>
  fixture((root) => {
    const skills = join(root, ".agents", "skills");
    mkdirSync(skills, { recursive: true });
    mkdirSync(join(root, ".codex"));
    mkdirSync(join(root, "project"));
    symlinkSync(root, join(skills, "unsafe"));
    assert.throws(() => mountPlan(join(root, "project"), root), /host home/);
  }));

test("unrelated dangling Codex cache symlinks do not block the mount plan", () =>
  fixture((root) => {
    const work = join(root, "project");
    mkdirSync(work);
    mkdirSync(join(root, ".codex", ".tmp"), { recursive: true });
    symlinkSync(
      join(root, "missing-cache-file"),
      join(root, ".codex", ".tmp", "old"),
    );
    assert.deepEqual(
      new Set(mountPlan(work, root).keys()),
      new Set([work, join(root, ".codex")]),
    );
  }));

test("dangling skill symlinks stay dangling without preventing other skill mounts", () =>
  fixture((root) => {
    const skills = join(root, "skills");
    mkdirSync(skills);
    symlinkSync(join(root, "deleted-skill"), join(skills, "old"));
    assert.deepEqual(withSymlinkTargets([skills]), [skills]);
  }));

test("Codex arguments survive mise consuming the option separator", () => {
  assert.deepEqual(
    parseOptions("run", [
      "--checkout",
      "/work",
      "--model",
      "model-name",
      "--version",
    ]),
    {
      values: { checkout: "/work" },
      extra: ["--model", "model-name", "--version"],
    },
  );
});
