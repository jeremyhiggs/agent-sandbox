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
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODEX_SQLITE_HOME, ROOT, run } from "./sandbox.ts";

const artifacts = join(ROOT, ".artifacts");
mkdirSync(artifacts, { recursive: true });
const root = realpathSync(mkdtempSync(join(artifacts, "codex-lifecycle-")));
const coreEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HC_SESSION: "default",
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
const receipts = join(root, "parent-reports.jsonl");
const handoffPath = join(root, "handoff.json");
let parent: string | undefined;
const report: Record<string, unknown> = {
  sandbox: name,
  fixture: root,
  hcSession: "default",
  passed: false,
};
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
  return existsSync(receipts) ? readFileSync(receipts, "utf8") : "";
}
async function waitForHerdr(visible: boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const space = JSON.parse(command("herdr-app", ["ls"])).spaces.find(
      (space: { id: string }) => space.id.startsWith(name + "/"),
    );
    if (Boolean(space) === visible) return space as { id: string } | undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Sandbox ${visible ? "did not appear in" : "was not removed from"} Herdr`,
  );
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
    if (worker.state !== "live") {
      report.workerExit = {
        exitCode: worker.exit_code,
        reason: worker.reason,
        signal: worker.signal,
      };
      throw new Error(
        `Codex exited before reporting: ${JSON.stringify(report.workerExit)}`,
      );
    }
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
      ["wait", parent!, "--output", marker, "--timeout", "45"],
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
    "# Scope\n\nChange only src/index.js, test/index.test.js, and README.md. Add no dependencies.\nDo not start other agents, access credentials, or change unrelated state.\nDo not commit until the orchestrator explicitly requests it.\nReport progress and completion using hc send to the host orchestrator address in the launch prompt.\n",
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
  // Raw input avoids the host terminal's canonical line-length limit on reports.
  const collector = `const fs=require('node:fs'); process.stdin.setRawMode(true); const rl=require('node:readline').createInterface({input:process.stdin}); console.log('ORCHESTRATOR_READY'); rl.on('line',text=>{fs.appendFileSync(${JSON.stringify(receipts)},JSON.stringify({text})+String.fromCharCode(10));console.log('ORCHESTRATOR_RECEIVED '+text);});`;
  parent = JSON.parse(
    hc([
      "run",
      "--bg",
      "--no-parent",
      "--outlive-parent",
      "--name",
      `as-orchestrator-${process.pid}`,
      "--",
      "node",
      "-e",
      collector,
    ]),
  ).address;
  coreEnv.HC_TERMINAL_ID = parent;
  hc(["wait", parent!, "--output", "ORCHESTRATOR_READY", "--timeout", "10"]);
  const probe = "HANDOFF_TRANSPORT_PROBE " + "x".repeat(4096);
  hc(["send", parent!, probe]);
  hc(["wait", parent!, "--output", "ORCHESTRATOR_RECEIVED", "--timeout", "10"]);
  assert.ok(
    reports()
      .split("\n")
      .some((line) => line && JSON.parse(line).text === probe),
  );
  report.longReportTransport = true;
  const inbox = `${JSON.parse(hc(["server", "status"])).core.id}/${parent}`;
  report.hostParent = parent;
  const prompt = `This is an authorized lifecycle acceptance test in a throwaway Git worktree. No other agents or external services. Never inspect authentication files. Your host orchestrator is ${inbox}; report to it with hc send using that qualified address. You are a replaceable worker: guest SQLite is not the durable record. Before teardown, the host must receive and save your final handoff with results, decisions and reasons, changed files and commit IDs, tests and results, and unfinished work. First read the shared agent skill ${skill}, then report LIFECYCLE_STARTED with hc send ${inbox}. Implement an exported formatDuration(seconds) in src/index.js. Accept nonnegative safe integers only, throwing RangeError otherwise. Format using nonzero h/m/s parts separated by spaces: 0 -> '0s', 60 -> '1m', 3661 -> '1h 1m 1s'. Add Node built-in tests for boundaries and invalid inputs and update README.md. Run node --test. Do not commit yet. When done, report LIFECYCLE_READY_FOR_COMMIT with a short result via hc send ${inbox}, then wait for further instructions. Only edit the three files named in AGENTS.md.`;
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
    "default",
    "--detach",
    "--terminal",
    "worker",
    "--prompt",
    prompt,
  ]);
  assert.equal(
    JSON.parse(hc(["get", `${name}/worker`, "--json"])).parent,
    parent,
  );
  const appSpace = await waitForHerdr(true);
  assert.ok(appSpace, "Sandbox did not appear in the Herdr app");
  report.herdrSpace = appSpace.id;
  console.log(`Visible in Herdr: ${appSpace.id}`);
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
  guest([
    "node",
    "-e",
    `require('node:assert/strict').ok(require('node:fs').readdirSync(${JSON.stringify(CODEX_SQLITE_HOME)}).some(name=>/^state_\\d+\\.sqlite$/.test(name)));`,
  ]);
  report.sqliteHome = CODEX_SQLITE_HOME;
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
  console.log(
    guest([
      "git",
      "commit",
      "-m",
      "feat: format durations",
      "--",
      ...files,
    ]).trim(),
  );
  const commit = command("git", ["rev-parse", "HEAD"]).trim();
  hc([
    "send",
    `${name}/worker`,
    `The host orchestrator ran the independent tests and privacy-gate pre-commit successfully for staged tree ${expectedTree}, then executed the commit inside this guest. The commit is ${commit}. Do not change files or make another commit. Verify git HEAD, the committed tree, and a clean worktree. Report LIFECYCLE_COMMITTED followed by the full commit SHA with hc send ${inbox}. Then send a separate message to ${inbox} starting exactly with LIFECYCLE_HANDOFF followed by a space and one compact JSON object: {"result":"brief outcome","decisions":[{"decision":"implementation choice","reason":"why"}],"files":["README.md","src/index.js","test/index.test.js"],"commit":"full SHA","tests":[{"command":"node --test","result":"passed"}],"unfinished":[]}. Supply actual results and meaningful decisions with reasons. Use one line with no Markdown fences. Wait after sending; the host will save and verify your handoff before teardown. Do not spawn agents or push.`,
  ]);
  waitFor("LIFECYCLE_COMMITTED");
  waitFor("LIFECYCLE_HANDOFF ");
  assert.equal(command("git", ["rev-parse", "HEAD"]).trim(), commit);
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
  report.commitActor =
    "Host orchestrator executes git commit inside the guest after the host privacy scan";
  report.agentReports = received
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  report.reportTransport =
    "Native hc remote child sends directly to its qualified host parent";
  const handoffMessage = report.agentReports as { text: string }[];
  const marker = "LIFECYCLE_HANDOFF ";
  const message = handoffMessage.findLast(({ text }) =>
    text.startsWith(marker),
  );
  assert.ok(message, "Parent did not receive the final handoff");
  const handoff = JSON.parse(message.text.slice(marker.length));
  assert.equal(handoff.commit, commit);
  assert.deepEqual(handoff.files.sort(), [...files].sort());
  assert.ok(typeof handoff.result === "string" && handoff.result.trim());
  assert.ok(Array.isArray(handoff.decisions) && handoff.decisions.length > 0);
  for (const { decision, reason } of handoff.decisions) {
    assert.ok(typeof decision === "string" && decision.trim());
    assert.ok(typeof reason === "string" && reason.trim());
  }
  assert.ok(
    handoff.tests.some(
      (test: { command: string; result: string }) =>
        test.command === "node --test" && /^passed(?::|$)/.test(test.result),
    ),
  );
  assert.deepEqual(handoff.unfinished, []);
  writeFileSync(
    handoffPath,
    JSON.stringify(
      {
        ...handoff,
        verifiedByHost: {
          tree: expectedTree,
          cleanWorktree: true,
          tests: ["node --test", "independent acceptance checks"],
        },
      },
      null,
      2,
    ) + "\n",
  );
  report.handoffRecorded = true;
  report.handoffPath = handoffPath;
  console.log("Final handoff received, verified and saved before teardown");
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
  await waitForHerdr(false);
  assert.match(cli(["status"]), new RegExp(`${name}\\tstopped`));
  assert.ok(
    !JSON.parse(hc(["machine", "ls", "--json"])).machines.some(
      (machine: { name: string }) => machine.name === name,
    ),
  );
  cli([
    "start",
    "--name",
    name,
    "--detach",
    "--terminal",
    "restarted",
    "--exec",
    "bash",
  ]);
  await waitForHerdr(true);
  assert.match(
    guest([
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
  await waitForHerdr(false);
  assert.equal(JSON.parse(readFileSync(handoffPath, "utf8")).commit, commit);
  assert.equal(command("git", ["rev-parse", "HEAD"]).trim(), commit);
  report.handoffAndCommitSurvivedDeletion = true;
  report.herdrRemovedOnStopAndDelete = true;
  assert.ok(
    !JSON.parse(hc(["machine", "ls", "--json"])).machines.some(
      (machine: { name: string }) => machine.name === name,
    ),
  );
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
    ) {
      if (report.handoffRecorded) {
        cli(["delete", "--name", name]);
        report.sandboxDeleted = true;
      } else {
        cli(["stop", "--name", name]);
        report.sandboxRetained = true;
        console.log(
          `No verified handoff; stopped ${name} and retained it for recovery`,
        );
      }
    } else report.sandboxDeleted = true;
  } finally {
    try {
      if (parent) {
        if (JSON.parse(hc(["get", parent, "--json"])).state === "live")
          hc(["kill", parent]);
        hc(["rm", parent]);
      }
    } finally {
      writeFileSync(
        join(root, "report.json"),
        JSON.stringify(report, null, 2) + "\n",
      );
    }
  }
}
