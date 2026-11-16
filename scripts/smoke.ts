import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { DEFAULT_DNS, IMAGE, run, start, stop } from "./sandbox.ts";

const { values } = parseArgs({
  options: {
    image: { type: "string", default: IMAGE },
    browser: { type: "boolean", default: false },
    cli: { type: "string" },
  },
});

// Fake Codex state makes this test independent of credentials and account access.
const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-smoke-")));
// Keep Unix socket paths short on macOS, whose usual temp directory is long.
const coreHome = mkdtempSync("/tmp/cc-hc-");
process.env.HC_SESSION = "smoke";
process.env.XDG_CONFIG_HOME = join(coreHome, "config");
process.env.XDG_STATE_HOME = join(coreHome, "state");
delete process.env.HC_SOCKET;
delete process.env.HC_TERMINAL_ID;
const home = join(root, "home"),
  main = join(root, "main"),
  work = join(root, "linked worktree");
let guest: string | undefined;
let coreStarted = false;
function stopGuest(name: string): void {
  if (values.cli) run(values.cli, ["stop", name]);
  else stop(name);
}
try {
  run("hc", ["server", "start"]);
  coreStarted = true;
  mkdirSync(join(home, ".codex", "skills"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills", "example"), { recursive: true });
  writeFileSync(
    join(home, ".agents", "skills", "example", "SKILL.md"),
    "# Smoke skill\n",
  );
  symlinkSync(
    join(home, ".agents", "skills", "example"),
    join(home, ".codex", "skills", "example"),
  );
  const sentinel = join(home, "private-host-file");
  const externalSkill = join(root, "shared-skill.md");
  writeFileSync(externalSkill, "# External file skill\n");
  symlinkSync(
    externalSkill,
    join(home, ".agents", "skills", "example", "REFERENCE.md"),
  );
  writeFileSync(sentinel, "not mounted");
  run("git", ["init", "-q", main]);
  run("git", ["-C", main, "worktree", "add", "--orphan", "-qb", "smoke", work]);
  guest = values.cli
    ? execFileSync(
        values.cli,
        ["start", "--home", home, "--image", values.image!],
        { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      ).trim()
    : start({
        checkout: work,
        home,
        dns: process.env.CONTAINER_DNS,
        image: values.image,
      }).name;
  const registered = JSON.parse(run("hc", ["machine", "ls", "--json"]));
  assert.equal(
    registered.machines.find(
      (machine: { name: string }) => machine.name === guest,
    )?.temporary,
    false,
    "Herdr hides machines marked temporary; registration must remain visible until stop",
  );
  execFileSync(
    "container",
    [
      "exec",
      guest,
      "node",
      "/opt/codex-container/check.ts",
      ...(values.browser ? ["--browser"] : []),
    ],
    { stdio: "inherit" },
  );
  const probe = `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    assert.ok(fs.readFileSync('/etc/resolv.conf', 'utf8').includes('nameserver ' + ${JSON.stringify(DEFAULT_DNS)}));
    assert.equal(fs.existsSync(${JSON.stringify(sentinel)}), false);
    assert.match(fs.readFileSync(${JSON.stringify(join(home, ".agents", "skills", "example", "REFERENCE.md"))}, 'utf8'), /External file skill/);
    assert.match(fs.readFileSync(${JSON.stringify(join(home, ".codex", "skills", "example", "SKILL.md"))}, 'utf8'), /Smoke skill/);
    for (const skill of ${JSON.stringify([externalSkill, join(home, ".codex", "skills", "example", "SKILL.md")])}) {
      assert.throws(() => fs.writeFileSync(skill, 'must stay read-only'), error => error.code === 'EROFS' || error.code === 'EACCES');
    }
    fs.writeFileSync(${JSON.stringify(join(work, "from-guest.txt"))}, 'shared checkout\\n');
    fs.writeFileSync(${JSON.stringify(join(home, ".codex", "guest-state"))}, 'persistent state');
  `;
  run("container", ["exec", guest, "node", "-e", probe]);
  run("container", ["exec", guest, "git", "-C", work, "add", "from-guest.txt"]);
  assert.match(
    run("git", ["-C", work, "status", "--porcelain"]),
    /A  from-guest.txt/,
  );
  const guestMachines = JSON.parse(
    run("container", ["exec", guest, "hc", "machine", "ls", "--json"]),
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
    guest,
    "--name",
    "probe",
    "--cwd",
    work,
    "--no-parent",
    "--outlive-parent",
    "--",
    "sh",
    "-c",
    "printf 'hc-guest-ready\\n'; sleep 120",
  ]);
  let screen = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    screen = run("hc", ["read", `${guest}/probe`]);
    if (screen.includes("hc-guest-ready")) break;
    await setTimeout(250);
  }
  assert.match(
    screen,
    /hc-guest-ready/,
    "host must read a terminal managed by the guest core",
  );
  const name = guest;
  stopGuest(name);
  guest = undefined;
  assert.equal(
    readFileSync(join(work, "from-guest.txt"), "utf8"),
    "shared checkout\n",
  );
  assert.equal(
    readFileSync(join(home, ".codex", "guest-state"), "utf8"),
    "persistent state",
  );
  assert.equal(existsSync(sentinel), true);
  const machines = JSON.parse(run("hc", ["machine", "ls", "--json"]));
  assert.equal(
    machines.machines.some(
      (machine: { name: string }) => machine.name === name,
    ),
    false,
  );
  const containers = JSON.parse(
    run("container", ["ls", "--all", "--format", "json"]),
  );
  assert.equal(
    containers.some(
      (item: { configuration: { id: string } }) =>
        item.configuration.id === name,
    ),
    false,
  );
  console.log(
    "Worktree, skills, host isolation, hc registration, image checks, and teardown passed",
  );
} finally {
  try {
    if (guest) stopGuest(guest);
  } finally {
    try {
      if (coreStarted) run("hc", ["server", "stop"]);
    } finally {
      rmSync(root, { recursive: true });
      rmSync(coreHome, { recursive: true });
    }
  }
}
