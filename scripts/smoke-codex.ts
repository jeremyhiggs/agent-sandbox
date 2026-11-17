import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT, run } from "./sandbox.ts";

const artifacts = join(ROOT, ".artifacts");
mkdirSync(artifacts, { recursive: true });
const root = realpathSync(mkdtempSync(join(artifacts, "codex-lifecycle-")));
const coreHome = mkdtempSync("/tmp/as-live-");
const coreEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HC_SESSION: "live",
  XDG_CONFIG_HOME: join(coreHome, "config"),
  XDG_STATE_HOME: join(coreHome, "state"),
  XDG_DATA_HOME: join(coreHome, "data"),
};
delete coreEnv.HC_SOCKET;
delete coreEnv.HC_TERMINAL_ID;
const main = join(root, "main"),
  work = join(root, "worktree");
const name = `as-live-${process.pid}`;
const skills = join(homedir(), ".agents", "skills");
const skill = [
  join(skills, "ponytail", "SKILL.md"),
  ...readdirSync(skills).map((name) => join(skills, name, "SKILL.md")),
].find(existsSync);
assert.ok(skill, "An installed agent skill is required");
const hash = createHash("sha256").update(readFileSync(skill)).digest("hex");
const files = ["src/index.js", "test/index.test.js", "README.md"];
const receipts = "/tmp/lifecycle-reports.jsonl";
const inbox = "orchestrator-inbox";
const report: Record<string, unknown> = {
  sandbox: name,
  fixture: root,
  passed: false,
};
let coreStarted = false;
function command(
  program: string,
  args: string[],
  cwd = work,
  env = process.env,
) {
  return execFileSync(program, args, {
    cwd,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
}
const cli = (args: string[]) =>
  command(
    process.execPath,
    [join(ROOT, "scripts", "sandbox.ts"), ...args],
    work,
    coreEnv,
  );
const hc = (args: string[]) => command("hc", args, work, coreEnv);
const guest = (args: string[]) =>
  cli(["shell", "--name", name, "--exec", ...args]);
function reports(): string {
  return hc([
    "exec",
    "--on",
    name,
    "node",
    "-e",
    `const fs=require('node:fs'); if(fs.existsSync(${JSON.stringify(receipts)})) process.stdout.write(fs.readFileSync(${JSON.stringify(receipts)},'utf8'));`,
  ]);
}
function waitFor(marker: string) {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    if (reports().includes(marker)) {
      console.log(`Received agent report: ${marker}`);
      return;
    }
    const worker = JSON.parse(hc(["get", `${name}/worker`, "--json"]));
    const status = worker.status?.state ?? worker.state;
    console.log(`Codex: ${status}; turn ${worker.turn}`);
    assert.equal(worker.state, "live", "Codex exited before reporting");
    const screen = hc(["read", `${name}/worker`, "--lines", "0"]);
    if (screen.includes("Trust this folder?")) {
      assert.ok(
        screen.includes(work) && screen.includes(main),
        "Unexpected folder trust target",
      );
      assert.match(screen, /›\s*1\. Trust and continue/);
      hc(["keys", `${name}/worker`, "enter"]);
      console.log("Accepted trust for the generated fixture");
    } else {
      assert.ok(
        !["blocked", "error"].includes(status),
        `Codex is ${status}; inspect its terminal`,
      );
    }
    const waited = spawnSync(
      "hc",
      ["wait", `${name}/${inbox}`, "--output", marker, "--timeout", "45"],
      { encoding: "utf8", env: coreEnv },
    );
    assert.ok([0, 124].includes(waited.status ?? -1), waited.stderr);
  }
  throw new Error(`Codex did not report ${marker} within ten minutes`);
}
try {
  for (const dir of [main, join(main, "src"), join(main, "test")])
    mkdirSync(dir);
  writeFileSync(
    join(main, "package.json"),
    JSON.stringify(
      {
        name: "sandbox-lifecycle-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(main, "src/index.js"),
    'export const projectName = "sandbox-lifecycle-fixture";\n',
  );
  writeFileSync(
    join(main, "test/index.test.js"),
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { projectName } from "../src/index.js";\ntest("fixture is ready", () => assert.equal(projectName, "sandbox-lifecycle-fixture"));\n',
  );
  writeFileSync(
    join(main, "README.md"),
    "# Lifecycle fixture\n\nRun `node --test`.\n",
  );
  writeFileSync(
    join(main, "AGENTS.md"),
    "# Scope\n\nChange only src/index.js, test/index.test.js, and README.md. Add no dependencies.\nDo not start other agents, access credentials, or change unrelated state.\nDo not commit until the orchestrator explicitly requests it.\nReport progress and completion to orchestrator-inbox with hc send.\n",
  );
  command("git", ["init", "-q", "-b", "main"], main);
  for (const [key, value] of [
    ["user.name", "Sandbox Lifecycle"],
    ["user.email", "sandbox@example.invalid"],
    ["commit.gpgsign", "false"],
  ])
    command("git", ["config", key, value], main);
  command("git", ["add", "AGENTS.md", "package.json", ...files], main);
  command("privacy-gate", ["pre-commit"], main);
  const seedMessage = join(root, "seed-message.txt");
  writeFileSync(seedMessage, "test: initialize lifecycle fixture\n");
  command(
    "git",
    ["commit", "-F", seedMessage, "--", "AGENTS.md", "package.json", ...files],
    main,
  );
  command(
    "git",
    ["worktree", "add", "-b", "lifecycle-test", work, "main"],
    main,
  );
  const baseline = command("git", ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(root, "host-only.txt"), "This file must not be shared.\n");
  const config = join(coreHome, "config", "herdr-core");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "config.toml"), "notes = false\ndraft_wait = 0\n");
  hc(["server", "start"]);
  coreStarted = true;
  const prompt = `This is an authorized lifecycle acceptance test in a throwaway Git worktree. No other agents or external services. Never inspect authentication files. Your orchestrator will shortly create an hc terminal named ${inbox}; wait for hc get ${inbox} to succeed if necessary. First read the shared agent skill ${skill}, then report LIFECYCLE_STARTED with hc send ${inbox}. Implement an exported formatDuration(seconds) in src/index.js. Accept nonnegative safe integers only, throwing RangeError otherwise. Format using nonzero h/m/s parts separated by spaces: 0 -> '0s', 60 -> '1m', 3661 -> '1h 1m 1s'. Add Node built-in tests for boundaries and invalid inputs and update README.md. Run node --test. Do not commit yet. When done, report LIFECYCLE_READY_FOR_COMMIT with a short result via hc send ${inbox}, then wait for further instructions. Only edit the three files named in AGENTS.md.`;
  console.log(`Fixture: ${root}\nLaunching ${name} with a real Codex prompt`);
  cli([
    "run",
    "--name",
    name,
    "--git",
    work,
    "--agent",
    "codex",
    "--mount",
    "codex",
    "--mount",
    "skills",
    "--hc-session",
    "live",
    "--detach",
    "--terminal",
    "worker",
    "--prompt",
    prompt,
  ]);
  const collector = `const fs=require('node:fs'); const rl=require('node:readline').createInterface({input:process.stdin}); console.log('ORCHESTRATOR_READY'); rl.on('line',text=>{fs.appendFileSync(${JSON.stringify(receipts)},JSON.stringify({text})+String.fromCharCode(10));console.log('ORCHESTRATOR_RECEIVED '+text);});`;
  cli([
    "shell",
    "--name",
    name,
    "--detach",
    "--terminal",
    inbox,
    "--exec",
    "node",
    "-e",
    collector,
  ]);
  const auth = spawnSync(
    "container",
    [
      "exec",
      name,
      "codex",
      "-c",
      'cli_auth_credentials_store="file"',
      "login",
      "status",
    ],
    { encoding: "utf8" },
  );
  assert.equal(auth.status, 0, auth.stderr);
  assert.match(auth.stdout + auth.stderr, /Logged in using ChatGPT/);
  report.authentication = "ChatGPT";
  console.log("Guest login status: ChatGPT");
  const preflight = `const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'); assert.equal(process.cwd(),${JSON.stringify(work)}); assert.equal(fs.existsSync(${JSON.stringify(join(root, "host-only.txt"))}),false); assert.equal(crypto.createHash('sha256').update(fs.readFileSync(${JSON.stringify(skill)})).digest('hex'),${JSON.stringify(hash)}); const probe=${JSON.stringify(join(skills, `.as-live-${process.pid}`))}; let error; try{fs.writeFileSync(probe,'probe',{flag:'wx'});}catch(e){error=e;} if(!error)fs.unlinkSync(probe); assert.ok(error && ['EROFS','EACCES'].includes(error.code),'skills must be read-only'); console.log('Shared skills verified, read-only; host sentinel excluded');`;
  console.log(guest(["node", "-e", preflight]).trim());
  report.skills = { bytesMatchHost: true, readonly: true };
  waitFor("LIFECYCLE_READY_FOR_COMMIT");
  assert.ok(reports().includes("LIFECYCLE_STARTED"));
  console.log(guest(["node", "--test"]).trim());
  const acceptance =
    "import assert from 'node:assert/strict'; import {formatDuration} from './src/index.js'; for(const [input,expected] of [[0,'0s'],[59,'59s'],[60,'1m'],[3600,'1h'],[3661,'1h 1m 1s']]) assert.equal(formatDuration(input),expected); for(const input of [-1,0.5,NaN,Infinity,'60',Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>formatDuration(input),RangeError); console.log('Independent acceptance checks passed');";
  console.log(guest(["node", "--input-type=module", "-e", acceptance]).trim());
  const changed = command("git", ["diff", "--name-only"])
    .trim()
    .split("\n")
    .sort();
  assert.deepEqual(changed, [...files].sort());
  command("git", ["add", ...files]);
  command("privacy-gate", ["pre-commit"]);
  const expectedTree = command("git", ["write-tree"]).trim();
  hc([
    "send",
    `${name}/worker`,
    `Independent tests and the host privacy-gate pre-commit scan passed for staged tree ${expectedTree}. Do not change any files. Commit only src/index.js, test/index.test.js and README.md with message 'feat: format durations'. The fixture identity and unsigned test-commit configuration are already set in its Git config. Report LIFECYCLE_COMMITTED followed by the full commit SHA with hc send ${inbox}. Do not spawn agents or push.`,
  ]);
  waitFor("LIFECYCLE_COMMITTED");
  const commit = command("git", ["rev-parse", "HEAD"]).trim();
  assert.notEqual(commit, baseline);
  assert.equal(
    command("git", ["rev-parse", "HEAD^{tree}"]).trim(),
    expectedTree,
  );
  assert.equal(command("git", ["status", "--porcelain"]).trim(), "");
  assert.equal(command("git", ["rev-parse", "main"]).trim(), baseline);
  const received = reports();
  assert.ok(received.includes(commit));
  report.commit = commit;
  report.agentReports = received
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  report.reportTransport =
    "Guest hc send to orchestrator inbox; host reads receipt through its registered hc machine";
  cli([
    "shell",
    "--name",
    name,
    "--detach",
    "--terminal",
    "shell-check",
    "--exec",
    "bash",
    "--noprofile",
    "--norc",
  ]);
  hc([
    "send",
    `${name}/shell-check`,
    "node --test; result=$?; printf 'SHELL_LIFECYCLE_DONE\\n'; exit $result",
  ]);
  hc(["wait", `${name}/shell-check`, "--timeout", "45"]);
  assert.equal(
    JSON.parse(hc(["get", `${name}/shell-check`, "--json"])).exit_code,
    0,
  );
  assert.equal(
    JSON.parse(hc(["get", `${name}/worker`, "--json"])).state,
    "live",
  );
  console.log(
    guest([
      "node",
      "-e",
      "require('node:fs').writeFileSync('/tmp/lifecycle-persistent','retained'); console.log('Independent exec passed');",
    ]).trim(),
  );
  cli(["stop", "--name", name]);
  assert.match(cli(["status"]), new RegExp(`${name}\\tstopped`));
  assert.equal(JSON.parse(hc(["machine", "ls", "--json"])).machines.length, 0);
  assert.match(
    cli([
      "start",
      "--name",
      name,
      "--exec",
      "node",
      "-e",
      "require('node:assert/strict').equal(require('node:fs').readFileSync('/tmp/lifecycle-persistent','utf8'),'retained'); console.log('Restart retained guest filesystem');",
    ]),
    /Restart retained/,
  );
  assert.ok(
    JSON.parse(hc(["machine", "ls", "--json"])).machines.some(
      (machine: { name: string }) => machine.name === name,
    ),
  );
  cli(["delete", "--name", name]);
  assert.equal(JSON.parse(hc(["machine", "ls", "--json"])).machines.length, 0);
  report.passed = true;
  console.log(
    `Live lifecycle passed; commit ${commit}\nEvidence: ${join(root, "report.json")}`,
  );
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try {
    const guests = JSON.parse(
      run("container", ["ls", "--all", "--format", "json"]),
    );
    if (
      guests.some(
        (guest: { configuration: { id: string } }) =>
          guest.configuration.id === name,
      )
    )
      cli(["delete", "--name", name]);
    report.sandboxDeleted = true;
  } finally {
    try {
      if (coreStarted) hc(["server", "stop"]);
    } finally {
      writeFileSync(
        join(root, "report.json"),
        JSON.stringify(report, null, 2) + "\n",
      );
      rmSync(coreHome, { recursive: true });
    }
  }
}
