import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { quote, ROOT, run } from "./sandbox.ts";

const { values } = parseArgs({ options: { cli: { type: "string" } } });
const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-smoke-")));
const coreHome = mkdtempSync("/tmp/ac-hc-");
const home = join(root, "home"),
  main = join(root, "main"),
  work = join(root, "linked worktree");
const binary = values.cli ?? process.execPath;
const prefix = values.cli ? [] : [join(ROOT, "scripts", "sandbox.ts")];
const attemptedNames = new Set<string>();
const guestName = (suffix: string) => `ac-smoke-${process.pid}-${suffix}`;
let coreStarted = false;
function track(name: string): string {
  attemptedNames.add(name);
  return name;
}
function invoke(args: string[], input?: string) {
  return execFileSync(binary, [...prefix, ...args], {
    cwd: work,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "inherit"],
  });
}
function launch(suffix: string, args: string[], input?: string) {
  const name = track(guestName(suffix));
  return invoke(["run", "--name", name, "--home", home, ...args], input);
}
function destroy(name: string) {
  invoke(["delete", "--name", name]);
}
try {
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_")) delete process.env[key];
  process.env.GIT_CONFIG_GLOBAL = join(root, "global.gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
  mkdirSync(join(home, ".codex", "skills"), { recursive: true });
  const codex = join(home, ".codex");
  writeFileSync(join(codex, "auth.json"), '{"fixture":"initial"}\n');
  writeFileSync(join(codex, "config.toml"), "# private host config\n");
  writeFileSync(join(codex, "history.jsonl"), "private host history\n");
  writeFileSync(join(codex, "unknown-state.json"), "private extra state\n");
  mkdirSync(join(codex, "sessions"));
  writeFileSync(join(codex, "sessions", "private.jsonl"), "private session\n");
  mkdirSync(join(home, ".agents", "skills", "example"), { recursive: true });
  const skill = join(home, ".agents", "skills", "example", "SKILL.md");
  writeFileSync(skill, "# Smoke skill\n");
  symlinkSync(
    join(home, ".agents", "skills", "example"),
    join(home, ".codex", "skills", "example"),
  );
  const sentinel = join(home, "private-host-file");
  writeFileSync(sentinel, "not mounted");
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), '{"smoke":true}\n');
  run("git", ["init", "-q", main]);
  run("git", ["-C", main, "config", "user.name", "Sandbox Smoke"]);
  run("git", ["-C", main, "config", "user.email", "smoke@example.invalid"]);
  run("git", ["-C", main, "worktree", "add", "--orphan", "-qb", "smoke", work]);
  const gitConfig = readFileSync(join(main, ".git", "config"), "utf8");
  const gitPointer = readFileSync(join(work, ".git"), "utf8");
  // Ordinary execution must never call hc, even with an unusable hc on PATH.
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "hc"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
  const normalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${normalPath}`;
  assert.match(invoke([]), /Usage: agent-sandbox COMMAND/);
  assert.match(
    launch(
      "shell",
      ["--exec", "bash"],
      `set -e\ntest "$PWD" = /workspace\ntest ! -e ${quote(work)}\ntest ! -e ${quote(main)}\nprintf 'base-shell-ready\\n'\ncommand -v google-chrome\nif git rev-parse --git-dir; then exit 1; fi\nexit\n`,
    ),
    /base-shell-ready/,
  );
  assert.equal(readFileSync(join(work, ".git"), "utf8"), gitPointer);
  destroy(guestName("shell"));
  const jsonGuest = guestName("json");
  const createdJSON = JSON.parse(launch("json", ["--json", "--detach"]));
  assert.equal(
    createdJSON.data.address,
    `${jsonGuest}/${createdJSON.data.terminal}`,
  );
  const listedJSON = JSON.parse(
    invoke(["terminals", "--name", jsonGuest, "--json"]),
  );
  assert.ok(
    listedJSON.data.terminals.some(
      (terminal: { address: string }) =>
        terminal.address === createdJSON.data.terminal,
    ),
  );
  const directJSON = spawnSync(
    binary,
    [
      ...prefix,
      "shell",
      "--name",
      jsonGuest,
      "--json",
      "--exec",
      "sh",
      "-c",
      "cat; printf json-stderr >&2; exit 7",
    ],
    {
      cwd: work,
      encoding: "utf8",
      input: "json-stdin",
    },
  );
  assert.equal(directJSON.status, 7);
  assert.equal(JSON.parse(directJSON.stdout).exit_code, 7);
  assert.match(directJSON.stderr, /json-stdin/);
  assert.match(directJSON.stderr, /json-stderr/);
  assert.equal(
    JSON.parse(invoke(["stop", "--name", jsonGuest, "--json"])).ok,
    true,
  );
  const restartedJSON = JSON.parse(
    invoke(["start", "--name", jsonGuest, "--json", "--detach"]),
  );
  assert.equal(restartedJSON.data.name, jsonGuest);
  assert.ok(restartedJSON.data.terminal);
  assert.equal(
    JSON.parse(invoke(["delete", "--name", jsonGuest, "--json"])).ok,
    true,
  );
  const dataRW = join(root, "data rw"),
    dataRO = join(root, "data ro");
  mkdirSync(dataRW);
  mkdirSync(dataRO);
  writeFileSync(join(dataRO, "input.txt"), "read only input");
  const directoryGuest = guestName("directories");
  launch("directories", [
    "--volume",
    `${dataRW}:/workspace/output:rw`,
    "--volume",
    `${dataRO}:/data/input/:ro`,
    "--exec",
    "node",
    "-e",
    "const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('/data/input/input.txt','utf8'),'read only input');a.throws(()=>fs.writeFileSync('/data/input/input.txt','blocked'),e=>['EROFS','EACCES'].includes(e.code));fs.writeFileSync('/workspace/output/result.txt','directory mount ready');",
  ]);
  assert.equal(
    readFileSync(join(dataRW, "result.txt"), "utf8"),
    "directory mount ready",
  );
  assert.equal(
    readFileSync(join(dataRO, "input.txt"), "utf8"),
    "read only input",
  );
  invoke(["stop", "--name", directoryGuest]);
  assert.equal(
    invoke([
      "start",
      "--name",
      directoryGuest,
      "--exec",
      "cat",
      "/workspace/output/result.txt",
    ]),
    "directory mount ready",
  );
  destroy(directoryGuest);
  launch("git-directory-visible", [
    "--mount-git",
    main,
    "--exec",
    "node",
    "-e",
    `const fs=require('node:fs'),assert=require('node:assert/strict'),cp=require('node:child_process'); assert.ok(fs.existsSync(${JSON.stringify(join(main, ".git", "HEAD"))})); for (const role of ['AUTHOR','COMMITTER']) { assert.equal(process.env['GIT_'+role+'_NAME'],'Sandbox Smoke'); assert.equal(process.env['GIT_'+role+'_EMAIL'],'smoke@example.invalid'); assert.match(cp.execFileSync('git',['var','GIT_'+role+'_IDENT'],{encoding:'utf8'}),/^Sandbox Smoke <smoke@example\\.invalid> /); } fs.writeFileSync('normal-git.txt','normal checkout'); cp.execFileSync('git',['add','normal-git.txt']);`,
  ]);
  assert.match(
    run("git", ["-C", main, "status", "--porcelain"]),
    /A  normal-git.txt/,
  );
  destroy(guestName("git-directory-visible"));
  const probe = `
    const fs = require('node:fs'), assert = require('node:assert/strict');
    assert.equal(process.cwd(), ${JSON.stringify(work)});
    for (const role of ['AUTHOR', 'COMMITTER']) {
      assert.equal(process.env['GIT_'+role+'_NAME'], 'Override Smoke');
      assert.equal(process.env['GIT_'+role+'_EMAIL'], 'override@example.invalid');
      assert.match(require('node:child_process').execFileSync('git', ['var', 'GIT_'+role+'_IDENT'], {encoding:'utf8'}), /^Override Smoke <override@example\\.invalid> /);
    }
    assert.equal(fs.existsSync(${JSON.stringify(sentinel)}), false);
    assert.equal(fs.existsSync(${JSON.stringify(join(home, ".codex"))}), false);
    assert.throws(() => fs.writeFileSync(${JSON.stringify(skill)}, 'fail'), e => ['EROFS','EACCES'].includes(e.code));
    fs.writeFileSync(${JSON.stringify(join(work, "from-guest.txt"))}, 'shared checkout\\n');
    require('node:child_process').execFileSync('git', ['add', 'from-guest.txt']);
    console.log('literal argument:', process.argv[1]);
  `;
  assert.match(
    launch("literal", [
      "--mount-git",
      "--mount-skills",
      "--git-name",
      "Override Smoke",
      "--git-email",
      "override@example.invalid",
      "--exec",
      "node",
      "-e",
      probe,
      "a b; $(not-shell)",
    ]),
    /a b; \$\(not-shell\)/,
  );
  destroy(guestName("literal"));
  const failedName = track(guestName("exit"));
  const failed = spawnSync(
    binary,
    [
      ...prefix,
      "run",
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
  assert.match(invoke(["status"]), new RegExp(`${failedName}\\trunning`));
  destroy(failedName);
  for (const agent of ["codex", "opencode", "claude"]) {
    const guestHome =
      agent === "codex"
        ? join(home, ".codex")
        : agent === "claude"
          ? join(home, ".claude")
          : join(home, ".local", "share", "opencode");
    const stateProbe = `const fs=require('node:fs'); fs.mkdirSync(${JSON.stringify(guestHome)},{recursive:true}); fs.writeFileSync(${JSON.stringify(join(guestHome, "agent-state"))}, '${agent}'); console.log(process.env.HOME)`;
    launch(agent, [
      "--agent",
      agent,
      ...(agent === "codex" ? ["--mount-codex-auth"] : []),
      "--exec",
      "node",
      "-e",
      stateProbe,
    ]);
    assert.equal(existsSync(join(guestHome, "agent-state")), false);
    destroy(guestName(agent));
    assert.ok(
      launch(`${agent}-version`, [
        "--agent",
        agent,
        "--exec",
        agent,
        "--version",
      ]).trim(),
    );
    destroy(guestName(`${agent}-version`));
  }
  const authGuest = guestName("mount-codex-auth");
  const authProbe = `
    const fs=require('node:fs'), assert=require('node:assert/strict');
    const home=${JSON.stringify(codex)}, auth=home+'/auth.json';
    assert.equal(fs.lstatSync(auth).isSymbolicLink(),false);
    assert.equal(JSON.parse(fs.readFileSync(auth)).fixture,'initial');
    assert.equal(fs.existsSync('/run/virtiofs'),false);
    for(const name of ['config.toml','history.jsonl','unknown-state.json','sessions','skills']) {
      assert.equal(fs.existsSync(home+'/'+name),false,name);
    }
    assert.throws(()=>fs.writeFileSync(auth,'must not reach host'),e=>['EROFS','EACCES'].includes(e.code));
    const next=home+'/.auth-smoke'; fs.writeFileSync(next,'guest replacement');
    assert.throws(()=>fs.renameSync(next,auth),e=>['EBUSY','EROFS','EACCES'].includes(e.code));
    fs.unlinkSync(next);
    for(const name of ['config.toml','history.jsonl','auth.lock','auth.json.lock']) fs.writeFileSync(home+'/'+name,'guest only');
    fs.mkdirSync(home+'/sessions'); fs.writeFileSync(home+'/sessions/local','guest session');
    console.log('read-only auth and guest-local state verified');
  `;
  assert.match(
    launch("mount-codex-auth", [
      "--mount-codex-auth",
      "--exec",
      "node",
      "-e",
      authProbe,
    ]),
    /read-only auth and guest-local state verified/,
  );
  assert.equal(
    JSON.parse(readFileSync(join(codex, "auth.json"), "utf8")).fixture,
    "initial",
  );
  for (const name of ["auth.lock", "auth.json.lock"])
    assert.equal(existsSync(join(codex, name)), false);
  assert.equal(
    readFileSync(join(codex, "history.jsonl"), "utf8"),
    "private host history\n",
  );
  assert.deepEqual(readdirSync(join(codex, "sessions")), ["private.jsonl"]);
  writeFileSync(join(codex, ".host-config-smoke"), "updated private config\n");
  renameSync(join(codex, ".host-config-smoke"), join(codex, "config.toml"));
  writeFileSync(join(codex, "new-private-state.json"), "host only");
  run("container", [
    "exec",
    authGuest,
    "node",
    "-e",
    `const fs=require('node:fs'),a=require('node:assert/strict'),home=${JSON.stringify(codex)};a.equal(fs.readFileSync(home+'/config.toml','utf8'),'guest only');a.equal(fs.existsSync(home+'/new-private-state.json'),false);`,
  ]);
  writeFileSync(
    join(codex, ".auth-host-smoke"),
    '{"fixture":"host-refreshed"}\n',
  );
  renameSync(join(codex, ".auth-host-smoke"), join(codex, "auth.json"));
  // Reattach the file mount after host atomic replacement, retaining local state.
  invoke(["stop", "--name", authGuest]);
  invoke([
    "start",
    "--name",
    authGuest,
    "--exec",
    "node",
    "-e",
    `const fs=require('node:fs'),a=require('node:assert/strict'),home=${JSON.stringify(codex)};a.equal(JSON.parse(fs.readFileSync(home+'/auth.json')).fixture,'host-refreshed');a.equal(fs.readFileSync(home+'/history.jsonl','utf8'),'guest only');a.deepEqual(fs.readdirSync(home+'/sessions'),['local']);a.equal(fs.existsSync(home+'/new-private-state.json'),false);a.throws(()=>fs.writeFileSync(home+'/auth.json','blocked'),e=>['EROFS','EACCES'].includes(e.code));`,
  ]);
  destroy(authGuest);
  const privateState = [
    join(home, ".codex"),
    join(home, ".claude"),
    join(home, ".claude.json"),
    join(home, ".config", "opencode"),
    join(home, ".local", "share", "opencode"),
    join(home, ".agents", "skills"),
  ];
  launch("state-private", [
    "--exec",
    "node",
    "-e",
    `const fs=require('node:fs'), assert=require('node:assert/strict'); for (const path of ${JSON.stringify(privateState)}) assert.equal(fs.existsSync(path), false, path); console.log('host state excluded')`,
  ]);
  destroy(guestName("state-private"));
  launch("all-mounts", [
    "--mount-codex-auth",
    "--mount-skills",
    "--exec",
    "node",
    "-e",
    `const fs=require('node:fs'), assert=require('node:assert/strict'); for (const path of ${JSON.stringify([join(home, ".codex", "auth.json"), join(home, ".agents", "skills")])}) assert.ok(fs.existsSync(path), path); for (const path of ${JSON.stringify(privateState.slice(1, -1))}) assert.equal(fs.existsSync(path), false, path); console.log('read-only opt-in mounts available; other agent state excluded')`,
  ]);
  destroy(guestName("all-mounts"));
  process.env.PATH = normalPath;
  // A separate core cannot disturb the user's active Herdr session.
  process.env.HC_SESSION = "smoke";
  process.env.XDG_CONFIG_HOME = join(coreHome, "config");
  process.env.XDG_STATE_HOME = join(coreHome, "state");
  process.env.XDG_RUNTIME_DIR = join(coreHome, "run");
  mkdirSync(process.env.XDG_RUNTIME_DIR, { mode: 0o700 });
  delete process.env.HC_SOCKET;
  delete process.env.HC_TERMINAL_ID;
  run("hc", ["server", "start"]);
  coreStarted = true;
  const rejected = track(guestName("rejected"));
  const noninteractive = spawnSync(
    binary,
    [...prefix, "run", "--name", rejected, "--herdr"],
    { cwd: work, input: "must not be dropped\n", encoding: "utf8" },
  );
  assert.equal(noninteractive.status, 1);
  assert.match(noninteractive.stderr, /require a TTY/);
  assert.doesNotMatch(invoke(["status"]), new RegExp(rejected));
  const registered = JSON.parse(run("hc", ["machine", "ls", "--json"]));
  assert.equal(
    registered.machines.length,
    0,
    "rejected noninteractive launch must not register a guest",
  );
  const retained = track(guestName("retained"));
  assert.match(
    invoke([
      "run",
      "--name",
      retained,
      "--home",
      home,
      "--herdr",
      "--hc-session",
      "smoke",
      "--detach",
      "--terminal",
      "first",
      "--exec",
      "bash",
    ]),
    /^t/,
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
  invoke(["shell", "--name", retained, "--detach", "--terminal", "second"]);
  const terminals = JSON.parse(
    invoke(["terminals", "--name", retained]),
  ).terminals;
  assert.equal(
    terminals.filter((t: { state: string }) => t.state === "live").length,
    2,
  );
  invoke([
    "shell",
    "--name",
    retained,
    "--exec",
    "node",
    "-e",
    "require('node:fs').writeFileSync('/tmp/literal executable', '#!/bin/sh\\nprintf LITERAL_EXECUTABLE_OK\\n', {mode:0o755});",
  ]);
  for (const [terminal, executable, succeeds] of [
    ["literal-executable", "/tmp/literal executable", true],
    ["literal-not-shell", "touch /tmp/literal-shell-probe", false],
  ] as const) {
    invoke([
      "shell",
      "--name",
      retained,
      "--detach",
      "--terminal",
      terminal,
      "--exec",
      executable,
    ]);
    run("hc", ["wait", `${retained}/${terminal}`, "--timeout", "10"]);
    const result = JSON.parse(
      run("hc", ["get", `${retained}/${terminal}`, "--json"]),
    );
    assert.equal(result.exit_code === 0, succeeds);
    if (succeeds)
      assert.match(
        run("hc", ["read", `${retained}/${terminal}`]),
        /LITERAL_EXECUTABLE_OK/,
      );
  }
  invoke([
    "shell",
    "--name",
    retained,
    "--exec",
    "node",
    "-e",
    "require('node:assert/strict').equal(require('node:fs').existsSync('/tmp/literal-shell-probe'), false);",
  ]);
  const parent = JSON.parse(
    run("hc", [
      "run",
      "--bg",
      "--name",
      "remote-parent",
      "--no-parent",
      "--cwd",
      work,
      "--",
      "node",
      "-e",
      `require('node:child_process').execFileSync(${JSON.stringify(binary)},${JSON.stringify([...prefix, "shell", "--name", retained, "--detach", "--terminal", "native-child", "--exec", "bash"])},{stdio:'inherit'}); console.log('CHILD_READY'); require('node:readline').createInterface({input:process.stdin}).on('line',s=>console.log('RECEIVED '+s));`,
    ]),
  ).address;
  run("hc", ["wait", parent, "--output", "CHILD_READY", "--timeout", "10"]);
  const child = JSON.parse(
    run("hc", ["get", `${retained}/native-child`, "--json"]),
  );
  assert.equal(child.parent, parent);
  assert.equal(child.die_with_parent, false);
  const host = JSON.parse(run("hc", ["server", "status"])).core.id;
  run("container", [
    "exec",
    retained,
    "hc",
    "send",
    `${host}/${parent}`,
    "NATIVE_PARENT_REPORT_OK",
  ]);
  const deadline = Date.now() + 10_000;
  let response = "";
  while (Date.now() < deadline) {
    response = run("hc", ["read", parent]);
    if (response.includes("RECEIVED NATIVE_PARENT_REPORT_OK")) break;
    await setTimeout(100);
  }
  assert.match(response, /RECEIVED NATIVE_PARENT_REPORT_OK/);
  run("hc", ["kill", parent]);
  run("hc", ["rm", parent]);
  assert.equal(
    JSON.parse(run("hc", ["get", `${retained}/native-child`, "--json"])).state,
    "live",
  );
  assert.equal(
    invoke(["shell", "--name", retained, "--exec", "cat"], "piped input\n"),
    "piped input\n",
  );
  run("hc", ["send", `${retained}/first`, "exit"]);
  run("hc", ["wait", `${retained}/first`, "--timeout", "10"]);
  assert.equal(
    JSON.parse(run("hc", ["get", `${retained}/second`, "--json"])).state,
    "live",
  );
  const foreground = JSON.parse(
    run("hc", [
      "run",
      "--bg",
      "--name",
      "foreground-test",
      "--cwd",
      work,
      "--no-parent",
      "--outlive-parent",
      "--",
      binary,
      ...prefix,
      "shell",
      "--name",
      retained,
      "--terminal",
      "foreground",
    ]),
  ).address;
  run("hc", ["wait", foreground, "--output", "Terminal:", "--timeout", "10"]);
  run("hc", ["send", foreground, "printf 'foreground-ready\\n'"]);
  run("hc", [
    "wait",
    foreground,
    "--output",
    "foreground-ready",
    "--timeout",
    "10",
  ]);
  run("hc", ["keys", foreground, "ctrl+\\"]);
  run("hc", ["wait", foreground, "--timeout", "10"]);
  assert.equal(
    JSON.parse(run("hc", ["get", `${retained}/foreground`, "--json"])).state,
    "live",
    "Detaching must preserve the guest terminal",
  );
  const attached = JSON.parse(
    run("hc", [
      "run",
      "--bg",
      "--name",
      "attach-test",
      "--cwd",
      work,
      "--no-parent",
      "--outlive-parent",
      "--",
      binary,
      ...prefix,
      "attach",
      "--name",
      retained,
      "--terminal",
      "foreground",
    ]),
  ).address;
  run("hc", ["wait", attached, "--output", "bash-", "--timeout", "10"]);
  run("hc", ["send", attached, "exit"]);
  run("hc", ["wait", attached, "--timeout", "10"]);
  assert.equal(
    JSON.parse(run("hc", ["get", `${retained}/foreground`, "--json"])).state,
    "finished",
  );
  assert.equal(
    JSON.parse(run("hc", ["get", `${retained}/second`, "--json"])).state,
    "live",
  );
  invoke([
    "shell",
    "--name",
    retained,
    "--exec",
    "node",
    "-e",
    "require('node:fs').writeFileSync('/tmp/guest-marker','retained')",
  ]);
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
  process.env.HC_SESSION = "different-session";
  invoke(["stop", "--name", retained]);
  assert.match(invoke(["status"]), new RegExp(`${retained}\\tstopped`));
  assert.equal(
    invoke(["start", "--name", retained, "--exec", "cat", "/tmp/guest-marker"]),
    "retained",
  );
  invoke(["delete", "--name", retained]);
  process.env.HC_SESSION = "smoke";
  const disposable = track(guestName("rm"));
  invoke([
    "run",
    "--name",
    disposable,
    "--home",
    home,
    "--rm",
    "--exec",
    "true",
  ]);
  invoke(["stop", "--name", disposable]);
  assert.doesNotMatch(invoke(["status"]), new RegExp(disposable));
  const guests = JSON.parse(
    run("container", ["ls", "--all", "--format", "json"]),
  );
  assert.equal(
    guests.some((g: { configuration: { id: string } }) =>
      attemptedNames.has(g.configuration.id),
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
  assert.equal(readFileSync(join(main, ".git", "config"), "utf8"), gitConfig);
  console.log(
    "Persistent lifecycle, independent terminals, literal argv, pipes, agent state, opt-in Git/worktree metadata and isolated Herdr supervision passed",
  );
} finally {
  try {
    const guests = JSON.parse(
      run("container", ["ls", "--all", "--format", "json"]),
    );
    for (const guest of guests)
      if (attemptedNames.has(guest.configuration.id))
        invoke(["delete", "--name", guest.configuration.id]);
  } finally {
    try {
      if (coreStarted) {
        process.env.HC_SESSION = "smoke";
        run("hc", ["server", "stop"]);
      }
    } finally {
      rmSync(root, { recursive: true });
      rmSync(coreHome, { recursive: true });
    }
  }
}
