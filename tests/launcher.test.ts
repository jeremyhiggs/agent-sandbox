import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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

test("directory mounts preserve multiple explicit destinations and access modes", () =>
  fixture((root) => {
    const home = join(root, "home"),
      a = join(root, "repo a"),
      b = join(root, "data");
    for (const path of [home, a, b]) mkdirSync(path);
    const options = parseInvocation([
      "run",
      "--name",
      "test",
      "--mount-codex-auth",
      "--mount-skills",
      "--mount",
      `${a}:/workspace/repo:rw`,
      "--mount",
      `${b}:/data:ro`,
    ]).options;
    assert.equal(options["mount-codex-auth"], true);
    assert.equal(options["mount-skills"], true);
    const plan = mountPlan(undefined, home, { mount: options.mount });
    assert.deepEqual(
      [...plan.entries()],
      [
        ["/data", { source: b, readonly: true }],
        ["/workspace/repo", { source: a, readonly: false }],
      ],
    );
    for (const spec of [
      a,
      `${a}:/data`,
      `${a}:relative:rw`,
      `${a}:/data:bad`,
    ]) {
      assert.throws(
        () => parseInvocation(["run", "--name", "test", "--mount", spec]),
        /mount/i,
      );
    }
    assert.throws(
      () =>
        mountPlan(undefined, home, {
          mount: [`${a}:/data:ro`, `${b}:/data/child:rw`],
        }),
      /overlap|conflict/i,
    );
    assert.throws(
      () => mountPlan(undefined, home, { mount: [`${home}:/data:ro`] }),
      /host home/i,
    );
    assert.throws(
      () => mountPlan(undefined, home, { mount: [`${homedir()}:/data:ro`] }),
      /host home/i,
    );
    writeFileSync(join(root, "file"), "file");
    assert.throws(
      () => mountPlan(undefined, home, { mount: [`${root}/file:/data:ro`] }),
      /directory/i,
    );
    assert.throws(
      () => mountPlan(undefined, home, { mount: [`${a}:/proc:rw`] }),
      /reserved|runtime/i,
    );
  }));

test("Codex auth sharing mounts only the read-only credential file", () =>
  fixture((root) => {
    const codex = join(root, ".codex"),
      bin = join(root, "bin"),
      log = join(root, "container.jsonl");
    mkdirSync(codex);
    mkdirSync(bin);
    writeFileSync(join(codex, "auth.json"), "{}\n");
    writeFileSync(join(codex, "auth.json.lock"), "");
    writeFileSync(join(codex, "config.toml"), "# host only\n");
    writeFileSync(join(codex, "history.jsonl"), "private history\n");
    mkdirSync(join(codex, "sessions"));
    writeFileSync(
      join(bin, "container"),
      `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');\n`,
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      createSandbox({
        name: "auth-file",
        home: root,
        "mount-codex-auth": true,
        herdr: false,
      });
    } finally {
      process.env.PATH = path;
    }
    const calls: string[][] = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const launch = calls.find((args) => args[0] === "run")!;
    const auth = join(codex, "auth.json");
    const volumes = launch.flatMap((arg, index) =>
      arg === "--volume" ? [launch[index + 1]] : [],
    );
    assert.deepEqual(volumes, [`${auth}:${auth}:ro`]);
    assert.ok(launch.includes(`CODEX_HOME=${codex}`));
    assert.ok(!launch.includes("--masked-path"));
    assert.ok(!calls.some((args) => args.includes("ln")));
  }));

test("directory targets normalize trailing slashes before home and overlap checks", () =>
  fixture((root) => {
    const home = join(root, "home"),
      data = join(root, "data");
    mkdirSync(home);
    mkdirSync(data);
    for (const target of [home, home + "/"]) {
      assert.throws(
        () => mountPlan(undefined, home, { mount: [`${data}:${target}:rw`] }),
        /reserved/,
      );
    }
    assert.deepEqual(
      [
        ...mountPlan(undefined, home, {
          mount: [`${data}:/reference/:ro`],
        }).keys(),
      ],
      ["/reference"],
    );
    assert.throws(
      () =>
        mountPlan(undefined, home, {
          mount: [`${data}:/reference/:ro`, `${data}:/reference:rw`],
        }),
      /overlap/,
    );
  }));

test("directory aliases cannot widen Codex auth or write through shared skills", () =>
  fixture((root) => {
    const home = join(root, "home"),
      codex = join(home, ".codex"),
      skills = join(home, ".agents", "skills"),
      data = join(root, "data");
    for (const path of [codex, skills, data])
      mkdirSync(path, { recursive: true });
    writeFileSync(join(codex, "auth.json"), "{}");
    const auth = { "mount-codex-auth": true };
    assert.throws(
      () =>
        mountPlan(undefined, home, { ...auth, mount: [`${codex}:/alias:ro`] }),
      /Codex state/,
    );
    const link = join(root, "auth-alias");
    symlinkSync(codex, link);
    assert.throws(
      () =>
        mountPlan(undefined, home, { ...auth, mount: [`${link}:/alias:rw`] }),
      /Codex state/,
    );
    assert.throws(
      () =>
        mountPlan(undefined, home, { ...auth, mount: [`${data}:${codex}:rw`] }),
      /reserved/,
    );
    assert.throws(
      () =>
        mountPlan(undefined, home, {
          "mount-skills": true,
          mount: [`${join(home, ".agents")}:/alias:rw`],
        }),
      /read-only shared skills/,
    );
    const normal = mountPlan(undefined, home, {
      ...auth,
      "mount-skills": true,
      mount: [`${data}:/data:rw`],
    });
    assert.equal(normal.get(join(codex, "auth.json"))?.readonly, true);
    assert.equal(normal.get("/data")?.readonly, false);
  }));

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
            createSandbox({
              "mount-git": git,
              home: root,
              name: "invalid",
              herdr: false,
            }),
          /Invalid Git metadata|Unrecognized Git pointer|No Git checkout|Git metadata cannot be a symlink|--mount-git requires a directory/,
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
    writeFileSync(join(root, ".codex", "auth.json"), "{}\n");
    mkdirSync(skills, { recursive: true });
    symlinkSync(skills, join(root, ".codex", "skills"));
    assert.equal(
      mountPlan(work, root, {
        "mount-codex-auth": true,
        "mount-skills": true,
      }).get(skills)?.readonly,
      true,
    );
  }));

test("read-only skill aliases into Codex keep a read-only overlay", () =>
  fixture((root) => {
    const work = join(root, "work"),
      target = join(root, ".codex", "shared-skill"),
      skills = join(root, ".agents", "skills");
    mkdirSync(work);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(root, ".codex", "auth.json"), "{}\n");
    mkdirSync(skills, { recursive: true });
    symlinkSync(target, join(skills, "example"));
    assert.equal(
      mountPlan(work, root, {
        "mount-codex-auth": true,
        "mount-skills": true,
      }).get(target)?.readonly,
      true,
    );
    unlinkSync(join(skills, "example"));
    symlinkSync(join(root, ".codex"), join(skills, "example"));
    assert.throws(
      () =>
        mountPlan(work, root, {
          "mount-codex-auth": true,
          "mount-skills": true,
        }),
      /Codex directory cannot also be a shared skill root/,
    );
  }));

test("Codex auth must be an existing regular file", () =>
  fixture((root) => {
    const work = join(root, "work"),
      codex = join(root, ".codex"),
      other = join(root, "dotfiles");
    mkdirSync(work);
    mkdirSync(codex);
    mkdirSync(other);
    assert.throws(
      () => mountPlan(work, root, { "mount-codex-auth": true }),
      /existing regular file/,
    );
    for (const name of ["auth.json"]) {
      const target = join(other, name);
      writeFileSync(target, "fixture");
      symlinkSync(target, join(codex, name));
      assert.throws(
        () => mountPlan(work, root, { "mount-codex-auth": true }),
        /must be an existing regular file/,
      );
      unlinkSync(join(codex, name));
    }
  }));

test("Git sharing cannot also expose host Codex state", () =>
  fixture((root) => {
    mkdirSync(join(root, ".codex"));
    assert.throws(
      () => mountPlan(root, root, { "mount-codex-auth": true }),
      /Git sharing cannot also expose/,
    );
    mkdirSync(join(root, ".codex", "repo"));
    assert.throws(
      () =>
        mountPlan(join(root, ".codex", "repo"), root, {
          "mount-codex-auth": true,
        }),
      /Git sharing cannot also expose/,
    );
    const main = join(root, ".codex", "repo"),
      work = join(root, "work");
    execFileSync("git", ["init", "-q", main]);
    execFileSync("git", [
      "-C",
      main,
      "worktree",
      "add",
      "--orphan",
      "-qb",
      "auth-file",
      work,
    ]);
    assert.throws(
      () => mountPlan(work, root, { "mount-codex-auth": true }),
      /Git sharing cannot also expose/,
    );
  }));

test("a symlinked Codex home is rejected before mounting credentials", () =>
  fixture((root) => {
    const work = join(root, "work"),
      target = join(root, "state", "codex");
    mkdirSync(work);
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(root, ".codex"));
    assert.throws(
      () => mountPlan(work, root, { "mount-codex-auth": true }),
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

test("nested links in a checkout-backed skill cannot add host mounts", () =>
  fixture((root) => {
    const work = join(root, "work"),
      skills = join(root, ".agents", "skills"),
      target = join(work, "skills", "review"),
      secret = join(root, ".ssh");
    mkdirSync(skills, { recursive: true });
    mkdirSync(target, { recursive: true });
    mkdirSync(secret);
    symlinkSync(target, join(skills, "review"));
    symlinkSync(secret, join(target, "secrets"));
    assert.throws(
      () => mountPlan(work, root, { "mount-skills": true }),
      /outside approved skill roots/,
    );
  }));

test("nested skill links inside approved roots need no additional mounts", () =>
  fixture((root) => {
    const skills = join(root, "skills"),
      target = join(root, "elsewhere", "review"),
      assets = join(target, "assets");
    mkdirSync(skills);
    mkdirSync(assets, { recursive: true });
    symlinkSync(target, join(skills, "review"));
    symlinkSync(assets, join(target, "asset-link"));
    symlinkSync(target, join(target, "self"));
    assert.deepEqual(
      new Set(withSymlinkTargets([skills])),
      new Set([skills, target]),
    );
  }));

test("a linked skills directory does not approve links inside its target", () =>
  fixture((root) => {
    const skills = join(root, "skills"),
      target = join(root, "work", "skills"),
      secret = join(root, ".ssh");
    mkdirSync(target, { recursive: true });
    mkdirSync(secret);
    symlinkSync(target, skills);
    assert.deepEqual(
      new Set(withSymlinkTargets([skills], root)),
      new Set([skills, target]),
    );
    symlinkSync(secret, join(target, "secrets"));
    assert.throws(
      () => withSymlinkTargets([skills], root),
      /outside approved skill roots/,
    );
  }));

test("skill roots reject symlinked ancestors before approving their contents", () =>
  fixture((root) => {
    const work = join(root, "work"),
      secret = join(root, ".ssh");
    mkdirSync(join(work, "skills"), { recursive: true });
    mkdirSync(secret);
    symlinkSync(work, join(root, ".agents"));
    symlinkSync(secret, join(work, "skills", "secrets"));
    assert.throws(
      () => mountPlan(work, root, { "mount-skills": true }),
      /symlinked ancestors/,
    );
  }));

test("skill symlink cannot expose host home", () =>
  fixture((root) => {
    const skills = join(root, ".agents", "skills");
    mkdirSync(skills, { recursive: true });
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".codex", "auth.json"), "{}\n");
    mkdirSync(join(root, "project"));
    symlinkSync(root, join(skills, "unsafe"));
    assert.throws(
      () =>
        mountPlan(join(root, "project"), root, {
          "mount-codex-auth": true,
          "mount-skills": true,
        }),
      /host home/,
    );
  }));

test("unrelated dangling Codex cache symlinks do not block the mount plan", () =>
  fixture((root) => {
    const work = join(root, "project");
    mkdirSync(work);
    mkdirSync(join(root, ".codex", ".tmp"), { recursive: true });
    writeFileSync(join(root, ".codex", "auth.json"), "{}\n");
    symlinkSync(
      join(root, "missing-cache-file"),
      join(root, ".codex", ".tmp", "old"),
    );
    assert.deepEqual(
      new Set(mountPlan(work, root, { "mount-codex-auth": true }).keys()),
      new Set([work, join(root, ".codex", "auth.json")]),
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

test("--mount-git opts into sharing the current or specified checkout", () => {
  const args = ["run", "--name", "feature"];
  assert.equal(parseInvocation(args).options["mount-git"], undefined);
  assert.deepEqual(parseInvocation(args).options.mount, []);
  assert.equal(
    parseInvocation([...args, "--mount-git"]).options["mount-git"],
    ".",
  );
  assert.equal(
    parseInvocation([...args, "--mount-git", "/a worktree"]).options[
      "mount-git"
    ],
    "/a worktree",
  );
  assert.equal(
    parseInvocation([...args, "--mount-git=../work"]).options["mount-git"],
    "../work",
  );
  assert.equal(
    parseInvocation([...args, "--mount-git", "--mount-skills"]).options[
      "mount-git"
    ],
    ".",
  );
  const custom = parseInvocation([
    ...args,
    "--mount-git",
    "--exec",
    "echo",
    "--mount-git",
    "literal",
  ]);
  assert.equal(custom.options["mount-git"], ".");
  assert.deepEqual(custom.argv, ["echo", "--mount-git", "literal"]);
  assert.throws(
    () => parseInvocation([...args, "--checkout", "."]),
    /Unknown option/,
  );
  assert.throws(
    () => parseInvocation([...args, "--mount", "git"]),
    /--mount requires/,
  );
  assert.throws(
    () => parseInvocation([...args, "--mount-git="]),
    /nonempty path/,
  );
  assert.throws(
    () => parseInvocation(["shell", "--name", "feature", "--mount-git"]),
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

test("unverified agent state mounts are rejected while agent launches remain available", () => {
  for (const agent of ["claude", "opencode"] as const) {
    assert.throws(
      () => parseInvocation(["run", "--name", "test", "--mount", agent]),
      /--mount requires/,
    );
    assert.equal(
      parseInvocation(["run", "--name", "test", "--agent", agent]).options
        .agent,
      agent,
    );
  }
});

test("host state and skills are opt-in independently of agent selection", () =>
  fixture((root) => {
    const work = join(root, "work");
    const codex = join(root, ".codex");
    const skills = join(root, ".agents", "skills");
    for (const path of [work, codex, skills])
      mkdirSync(path, { recursive: true });
    symlinkSync(skills, join(codex, "skills"));
    const auth = join(codex, "auth.json");
    writeFileSync(auth, "{}\n");
    assert.deepEqual(
      [...mountPlan(undefined, root, { "mount-codex-auth": true }).keys()],
      [auth],
    );
    assert.deepEqual([...mountPlan(work, root).keys()], [work]);
    assert.deepEqual(
      new Set(mountPlan(work, root, { "mount-codex-auth": true }).keys()),
      new Set([work, auth]),
    );
    const selected = mountPlan(work, root, {
      "mount-codex-auth": true,
      "mount-skills": true,
    });
    assert.deepEqual(new Set(selected.keys()), new Set([work, auth, skills]));
    assert.equal(selected.get(skills)?.readonly, true);
    assert.deepEqual(
      parseInvocation(["run", "--name", "test", "--agent", "codex"]).options
        .mount,
      [],
    );
    const explicit = parseInvocation([
      "run",
      "--name",
      "test",
      "--agent",
      "codex",
      "--mount-codex-auth",
      "--mount-skills",
    ]).options;
    assert.equal(explicit["mount-codex-auth"], true);
    assert.equal(explicit["mount-skills"], true);
    assert.throws(
      () => parseInvocation(["run", "--name", "test", "--mount", "all"]),
      /--mount requires/,
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
