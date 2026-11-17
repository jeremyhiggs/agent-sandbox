import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CODEX_SQLITE_HOME,
  createSandbox,
  mountPlan,
  parseInvocation,
  ROOT,
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
    const common = process.env.GIT_COMMON_DIR;
    process.env.GIT_COMMON_DIR = join(root, "not-a-git-store");
    try {
      assert.deepEqual(
        new Set(repositoryMounts(work)),
        new Set([work, join(main, ".git")]),
      );
    } finally {
      if (common === undefined) delete process.env.GIT_COMMON_DIR;
      else process.env.GIT_COMMON_DIR = common;
    }
    assert.deepEqual([...mountPlan(undefined, root).keys()], []);
    assert.deepEqual(
      new Set(mountPlan(work, root).keys()),
      new Set([work, join(main, ".git")]),
    );
    const git = readFileSync(join(work, ".git"), "utf8").trim().slice(8);
    const head = readFileSync(join(git, "HEAD"), "utf8");
    writeFileSync(join(git, "HEAD"), "invalid HEAD");
    assert.throws(() => mountPlan(work, root), /Invalid Git metadata/);
    writeFileSync(join(git, "HEAD"), head);
    const unrelated = join(root, "unrelated");
    execFileSync("git", ["init", "-q", unrelated]);
    writeFileSync(join(git, "commondir"), join(unrelated, ".git"));
    assert.throws(() => mountPlan(work, root), /registered.*common Git store/);
  }));

test("invalid Git selections fail before looking for the container runtime", () =>
  fixture((root) => {
    const empty = join(root, "empty"),
      malformed = join(root, "malformed"),
      badHead = join(root, "bad-head"),
      special = join(root, "special"),
      outside = join(root, "outside"),
      linked = join(root, "linked");
    mkdirSync(join(empty, ".git"), { recursive: true });
    mkdirSync(malformed);
    writeFileSync(join(malformed, ".git"), "not a gitfile");
    mkdirSync(outside);
    mkdirSync(linked);
    symlinkSync(join(empty, ".git"), join(linked, ".git"));
    execFileSync("git", ["init", "-q", badHead]);
    writeFileSync(join(badHead, ".git", "HEAD"), "invalid HEAD");
    mkdirSync(special);
    execFileSync("mkfifo", [join(special, ".git")]);
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(
      execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
      join(bin, "git"),
    );
    const path = process.env.PATH;
    process.env.PATH = bin;
    try {
      for (const git of [
        empty,
        malformed,
        badHead,
        special,
        outside,
        linked,
        join(malformed, ".git"),
      ])
        assert.throws(
          () =>
            createSandbox({ git, home: root, name: "invalid", herdr: false }),
          /Invalid Git metadata|Unrecognized Git pointer|No Git checkout|Git metadata cannot be a symlink|--git requires a directory/,
        );
    } finally {
      process.env.PATH = path;
    }
  }));

test("Git sharing does not resolve .jj links into additional host mounts", () =>
  fixture((root) => {
    const work = join(root, "work"),
      unrelated = join(root, "private");
    mkdirSync(join(work, ".jj"), { recursive: true });
    mkdirSync(unrelated);
    symlinkSync(unrelated, join(work, ".jj", "repo"));
    assert.deepEqual([...mountPlan(work, root).keys()], [work]);
  }));

test("agent skills remain read-only when Codex skills link to the same directory", () =>
  fixture((root) => {
    const work = join(root, "work"),
      skills = join(root, ".agents", "skills");
    mkdirSync(work);
    mkdirSync(join(root, ".codex"));
    mkdirSync(skills, { recursive: true });
    symlinkSync(skills, join(root, ".codex", "skills"));
    assert.equal(mountPlan(work, root, ["codex", "skills"]).get(skills), true);
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
    assert.equal(mountPlan(work, root, ["codex", "skills"]).get(target), true);
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
    assert.throws(() => mountPlan(work, root, ["codex"]), /atomic updates/);
  }));

test("a symlinked Codex home is rejected before creating writable aliases", () =>
  fixture((root) => {
    const work = join(root, "work"),
      target = join(root, "state", "codex");
    mkdirSync(work);
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(root, ".codex"));
    assert.throws(
      () => mountPlan(work, root, ["codex"]),
      /Codex directory.*symlink/,
    );
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
    assert.throws(
      () => mountPlan(join(root, "project"), root, ["codex", "skills"]),
      /host home/,
    );
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
      new Set(mountPlan(work, root, ["codex"]).keys()),
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

test("Herdr names fail before filesystem or container access when too long", () =>
  fixture((root) => {
    const name = "a".repeat(33);
    assert.throws(
      () => createSandbox({ name, herdr: true, home: join(root, "missing") }),
      /at most 32 characters/,
    );
    assert.doesNotThrow(() => parseInvocation(["run", "--name", name]));
  }));

test("bare invocation prints help without creating a sandbox", () => {
  const parsed = parseInvocation([]);
  assert.equal(parsed.command, "help");
  assert.equal(parsed.options.agent, undefined);
  assert.equal(parsed.options.herdr, false);
  assert.deepEqual(parsed.argv, ["bash"]);
});

test("--skill reads the bundled guidance outside a checkout without host tools", () =>
  fixture((root) => {
    assert.equal(parseInvocation(["--skill"]).command, "skill");
    const output = execFileSync(
      process.execPath,
      [join(ROOT, "scripts", "sandbox.ts"), "--skill"],
      {
        cwd: root,
        env: { ...process.env, PATH: "" },
        encoding: "utf8",
      },
    );
    assert.equal(
      output,
      readFileSync(join(ROOT, "skills", "agent-sandbox", "SKILL.md"), "utf8"),
    );
  }));

test("--git opts into sharing the current or specified checkout", () => {
  const args = ["run", "--name", "feature"];
  assert.equal(parseInvocation(args).options.git, undefined);
  assert.deepEqual(parseInvocation(args).options.mount, []);
  assert.equal(parseInvocation([...args, "--git"]).options.git, ".");
  assert.equal(
    parseInvocation([...args, "--git", "/a worktree"]).options.git,
    "/a worktree",
  );
  assert.equal(
    parseInvocation([...args, "--git=../work"]).options.git,
    "../work",
  );
  assert.equal(
    parseInvocation([...args, "--git", "--mount", "skills"]).options.git,
    ".",
  );
  const custom = parseInvocation([
    ...args,
    "--git",
    "--exec",
    "echo",
    "--git",
    "literal",
  ]);
  assert.equal(custom.options.git, ".");
  assert.deepEqual(custom.argv, ["echo", "--git", "literal"]);
  assert.throws(
    () => parseInvocation([...args, "--checkout", "."]),
    /Unknown option/,
  );
  assert.throws(
    () => parseInvocation([...args, "--mount", "git"]),
    /Unknown mount/,
  );
  assert.throws(() => parseInvocation([...args, "--git="]), /nonempty path/);
  assert.throws(
    () => parseInvocation(["shell", "--name", "feature", "--git"]),
    /chosen at creation/,
  );
});

test("prompts require an explicit agent and remain literal", () => {
  assert.throws(
    () => parseInvocation(["run", "--name", "test", "--prompt", "Fix tests"]),
    /requires --agent/,
  );
  for (const agent of ["codex", "opencode", "claude"]) {
    const prompt = "--literal; $(not-a-shell-command)";
    const parsed = parseInvocation([
      "run",
      "--name",
      "test",
      "--agent",
      agent,
      "--prompt",
      prompt,
    ]);
    assert.equal(parsed.options.agent, agent);
    if (agent === "codex") {
      assert.ok(parsed.argv.includes(`sqlite_home="${CODEX_SQLITE_HOME}"`));
      assert.ok(parsed.argv.includes("check_for_update_on_startup=false"));
    }
    assert.ok(
      parsed.argv.includes(prompt) ||
        parsed.argv.includes("--prompt=" + prompt),
    );
  }
});

test("--exec preserves command arguments and separates launcher flags", () => {
  const parsed = parseInvocation([
    "run",
    "--name",
    "test",
    "--herdr",
    "--exec",
    "printf",
    "%s",
    "a b",
    "--help",
  ]);
  assert.equal(parsed.options.herdr, true);
  assert.deepEqual(parsed.argv, ["printf", "%s", "a b", "--help"]);
  assert.throws(
    () => parseInvocation(["run", "--name", "test", "--exec"]),
    /requires a command/,
  );
  assert.throws(
    () =>
      parseInvocation([
        "run",
        "--name",
        "test",
        "--agent",
        "codex",
        "--prompt",
        "test",
        "--exec",
        "echo",
      ]),
    /cannot combine/,
  );
});

test("management commands and help stay explicit", () => {
  assert.equal(parseInvocation(["--help"]).command, "help");
  assert.equal(parseInvocation(["stop", "--name", "ac-test"]).name, "ac-test");
  assert.equal(
    parseInvocation(["stop", "--name", "cs-legacy"]).name,
    "cs-legacy",
  );
  assert.throws(() => parseInvocation(["exec", "echo"]), /--exec/);
  assert.throws(
    () => parseInvocation(["run", "--name", "test", "--agent", "unknown"]),
    /Unknown agent/,
  );
});

test("base mount plan exposes no host checkout or agent credentials", () =>
  fixture((root) => {
    const work = join(root, "work");
    mkdirSync(work);
    assert.deepEqual([...mountPlan(undefined, root).keys()], []);
    assert.deepEqual([...mountPlan(work, root).keys()], [work]);
  }));

test("opted-in agent state never expands host mounts through contained symlinks", () =>
  fixture((root) => {
    const work = join(root, "work");
    mkdirSync(work);
    const secret = join(root, ".ssh");
    mkdirSync(secret);
    for (const agent of ["claude", "opencode"] as const) {
      const state =
        agent === "claude"
          ? join(root, ".claude")
          : join(root, ".local", "share", "opencode");
      mkdirSync(state, { recursive: true });
      symlinkSync(secret, join(state, "host-ssh"));
      assert.deepEqual(
        new Set(mountPlan(work, root, [agent]).keys()),
        new Set([work, state]),
      );
    }
  }));

test("agent state cannot redirect through a symlinked ancestor", () =>
  fixture((root) => {
    const work = join(root, "work");
    mkdirSync(work);
    const outside = join(root, "elsewhere");
    mkdirSync(join(outside, "share", "opencode"), { recursive: true });
    symlinkSync(outside, join(root, ".local"));
    assert.throws(
      () => mountPlan(work, root, ["opencode"]),
      /symlinked ancestors/,
    );
  }));

test("host state and skills are opt-in independently of agent selection", () =>
  fixture((root) => {
    const work = join(root, "work");
    const codex = join(root, ".codex");
    const claude = join(root, ".claude");
    const config = join(root, ".config", "opencode");
    const data = join(root, ".local", "share", "opencode");
    const skills = join(root, ".agents", "skills");
    for (const path of [work, codex, claude, config, data, skills])
      mkdirSync(path, { recursive: true });
    symlinkSync(skills, join(codex, "skills"));
    assert.deepEqual(
      [...mountPlan(undefined, root, ["codex"]).keys()],
      [codex],
    );
    assert.deepEqual([...mountPlan(work, root).keys()], [work]);
    assert.deepEqual(
      new Set(mountPlan(work, root, ["codex"]).keys()),
      new Set([work, codex]),
    );
    const selected = mountPlan(work, root, [
      "codex",
      "claude",
      "opencode",
      "skills",
    ]);
    assert.deepEqual(
      new Set(selected.keys()),
      new Set([work, codex, claude, config, data, skills]),
    );
    assert.equal(selected.get(skills), true);
    assert.deepEqual(
      parseInvocation(["run", "--name", "test", "--agent", "codex"]).options
        .mount,
      [],
    );
    assert.deepEqual(
      parseInvocation([
        "run",
        "--name",
        "test",
        "--agent",
        "codex",
        "--mount",
        "claude",
        "--mount",
        "opencode",
      ]).options.mount,
      ["claude", "opencode"],
    );
    assert.throws(
      () => parseInvocation(["run", "--name", "test", "--mount", "all"]),
      /Unknown mount/,
    );
  }));

test("named persistent lifecycle and independent terminals have explicit targets", () => {
  assert.throws(() => parseInvocation(["run"]), /--name is required/);
  assert.throws(
    () => parseInvocation(["--agent", "codex"]),
    /Choose a command/,
  );
  assert.throws(
    () => parseInvocation(["shell", "feature"]),
    /Unexpected argument/,
  );
  assert.throws(
    () => parseInvocation(["attach", "--name", "feature"]),
    /requires --terminal/,
  );
  assert.throws(
    () =>
      parseInvocation([
        "attach",
        "--name",
        "feature",
        "--terminal",
        "elsewhere\/t1",
      ]),
    /--terminal must/,
  );
  assert.throws(
    () => parseInvocation(["shell", "--name", "feature", "--mount", "codex"]),
    /chosen at creation/,
  );
  const parsed = parseInvocation([
    "run",
    "--name",
    "feature",
    "-d",
    "--rm",
    "--agent",
    "codex",
    "--hc-session",
    "review",
  ]);
  assert.equal(parsed.options.detach, true);
  assert.equal(parsed.options.rm, true);
  assert.equal(parsed.options.herdr, true);
  assert.equal(parsed.options["hc-session"], "review");
  assert.equal(
    parseInvocation([
      "shell",
      "--name",
      "feature",
      "--herdr-space",
      "feature/sp1",
    ]).options["herdr-space"],
    "feature/sp1",
  );
  assert.throws(
    () =>
      parseInvocation([
        "run",
        "--name",
        "feature",
        "--herdr-space",
        "other/sp1",
      ]),
    /machine-scoped space/,
  );
  assert.equal(parseInvocation(["run", "--name", "feature"]).options.rm, false);
  assert.deepEqual(
    parseInvocation([
      "shell",
      "--name",
      "feature",
      "--exec",
      "printf",
      "%s",
      "literal; $(x)",
    ]).argv,
    ["printf", "%s", "literal; $(x)"],
  );
});
