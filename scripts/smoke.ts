import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
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
import { parseArgs } from "node:util";
import { ROOT, run } from "./sandbox.ts";

const { values } = parseArgs({ options: { cli: { type: "string" } } });
const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-smoke-")));
const coreHome = mkdtempSync("/tmp/ac-hc-");
const home = join(root, "home"),
  main = join(root, "main"),
  work = join(root, "linked worktree");
const binary = values.cli ?? process.execPath;
const prefix = values.cli ? [] : [join(ROOT, "scripts", "sandbox.ts")];
const names = new Set<string>();
let coreStarted = false;
function invoke(args: string[], input?: string) {
  return execFileSync(binary, [...prefix, ...args], {
    cwd: work,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "inherit"],
  });
}
function launch(suffix: string, args: string[], input?: string) {
  const name = `ac-smoke-${process.pid}-${suffix}`;
  names.add(name);
  return invoke(["--name", name, "--home", home, ...args], input);
}
try {
  mkdirSync(join(home, ".codex", "skills"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills", "example"), { recursive: true });
  const skill = join(home, ".agents", "skills", "example", "SKILL.md");
  writeFileSync(skill, "# Smoke skill\n");
  symlinkSync(
    join(home, ".agents", "skills", "example"),
    join(home, ".codex", "skills", "example"),
  );
  const sentinel = join(home, "private-host-file");
  writeFileSync(sentinel, "not mounted");
  run("git", ["init", "-q", main]);
  run("git", ["-C", main, "worktree", "add", "--orphan", "-qb", "smoke", work]);
  // Ordinary execution must never call hc, even with an unusable hc on PATH.
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "hc"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
  const normalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${normalPath}`;
  assert.match(
    launch(
      "shell",
      [],
      "printf 'base-shell-ready\\n'\ncommand -v google-chrome\nexit\n",
    ),
    /base-shell-ready/,
  );
  const probe = `
    const fs = require('node:fs'), assert = require('node:assert/strict');
    assert.equal(process.cwd(), ${JSON.stringify(work)});
    assert.equal(fs.existsSync(${JSON.stringify(sentinel)}), false);
    assert.equal(fs.existsSync(${JSON.stringify(join(home, ".codex"))}), false);
    assert.throws(() => fs.writeFileSync(${JSON.stringify(skill)}, 'fail'), e => ['EROFS','EACCES'].includes(e.code));
    fs.writeFileSync(${JSON.stringify(join(work, "from-guest.txt"))}, 'shared checkout\\n');
    require('node:child_process').execFileSync('git', ['add', 'from-guest.txt']);
    console.log('literal argument:', process.argv[1]);
  `;
  assert.match(
    launch("literal", ["--exec", "node", "-e", probe, "a b; $(not-shell)"]),
    /a b; \$\(not-shell\)/,
  );
  const failedName = `ac-smoke-${process.pid}-exit`;
  names.add(failedName);
  const failed = spawnSync(
    binary,
    [
      ...prefix,
      "--name",
      failedName,
      "--home",
      home,
      "--exec",
      "sh",
      "-c",
      "exit 42",
    ],
    { cwd: work, encoding: "utf8" },
  );
  assert.equal(failed.status, 42, failed.stderr);
  for (const agent of ["codex", "opencode", "claude"]) {
    const stateProbe = `const fs=require('node:fs'); fs.writeFileSync((process.env.CODEX_HOME || process.env.HOME) + '/agent-state', '${agent}'); console.log(process.env.HOME)`;
    launch(agent, ["--agent", agent, "--exec", "node", "-e", stateProbe]);
    const guestHome =
      agent === "codex"
        ? join(home, ".codex")
        : join(home, ".local", "share", "agent-container", agent, "home");
    assert.equal(readFileSync(join(guestHome, "agent-state"), "utf8"), agent);
    assert.ok(
      launch(`${agent}-version`, [
        "--agent",
        agent,
        "--exec",
        agent,
        "--version",
      ]).trim(),
    );
  }
  process.env.PATH = normalPath;
  // A separate core cannot disturb the user's active Herdr session.
  process.env.HC_SESSION = "smoke";
  process.env.XDG_CONFIG_HOME = join(coreHome, "config");
  process.env.XDG_STATE_HOME = join(coreHome, "state");
  delete process.env.HC_SOCKET;
  delete process.env.HC_TERMINAL_ID;
  run("hc", ["server", "start"]);
  coreStarted = true;
  const noninteractive = spawnSync(
    binary,
    [...prefix, "--herdr", "--exec", "cat"],
    { cwd: work, input: "must not be dropped\n", encoding: "utf8" },
  );
  assert.equal(noninteractive.status, 1);
  assert.match(noninteractive.stderr, /require interactive stdin and stdout/);
  const registered = JSON.parse(run("hc", ["machine", "ls", "--json"]));
  assert.equal(
    registered.machines.length,
    0,
    "rejected noninteractive launch must not register a guest",
  );
  const retained = `ac-smoke-${process.pid}-retained`;
  names.add(retained);
  assert.equal(
    invoke(["start", "--name", retained, "--home", home, "--herdr"]).trim(),
    retained,
  );
  const machine = JSON.parse(
    run("hc", ["machine", "ls", "--json"]),
  ).machines.find((m: { name: string }) => m.name === retained);
  assert.equal(machine.temporary, false, "Herdr hides temporary machines");
  const guestMachines = JSON.parse(
    run("container", ["exec", retained, "hc", "machine", "ls", "--json"]),
  );
  assert.equal(
    guestMachines.machines.length,
    0,
    "guest must not inherit host hc connections",
  );
  run("hc", [
    "run",
    "--bg",
    "--on",
    retained,
    "--name",
    "probe",
    "--no-parent",
    "--outlive-parent",
    "--",
    "sh",
    "-c",
    "printf 'herdr-guest-ready\\n'",
  ]);
  run("hc", ["wait", `${retained}/probe`, "--timeout", "30"]);
  assert.match(run("hc", ["read", `${retained}/probe`]), /herdr-guest-ready/);
  invoke(["stop", retained]);
  const guests = JSON.parse(
    run("container", ["ls", "--all", "--format", "json"]),
  );
  assert.equal(
    guests.some((g: { configuration: { id: string } }) =>
      names.has(g.configuration.id),
    ),
    false,
  );
  assert.match(
    run("git", ["-C", work, "status", "--porcelain"]),
    /A  from-guest.txt/,
  );
  assert.equal(
    readFileSync(join(work, "from-guest.txt"), "utf8"),
    "shared checkout\n",
  );
  assert.ok(existsSync(sentinel));
  console.log(
    "Base shell, literal argv, exit status, agent state, worktree, isolation, optional Herdr and teardown passed",
  );
} finally {
  try {
    const guests = JSON.parse(
      run("container", ["ls", "--all", "--format", "json"]),
    );
    for (const guest of guests)
      if (names.has(guest.configuration.id))
        invoke(["stop", guest.configuration.id]);
  } finally {
    try {
      if (coreStarted) run("hc", ["server", "stop"]);
    } finally {
      rmSync(root, { recursive: true });
      rmSync(coreHome, { recursive: true });
    }
  }
}
