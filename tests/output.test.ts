import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "../scripts/sandbox.ts";

const cli = join(ROOT, "scripts", "sandbox.ts");

function fixture(fn: (root: string, env: NodeJS.ProcessEnv) => void) {
  const root = mkdtempSync(join(tmpdir(), "sandbox-json-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const runtime = `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.JSON_TEST_LOG, JSON.stringify(args) + '\\n');
const name = 'json-test';
if (args[0] === 'inspect') console.log(JSON.stringify([{configuration:{id:name,labels:{'dev.agent-container.managed':'true','dev.agent-container.herdr':'false','dev.agent-container.checkout':'/workspace'}}}]));
else if (args[0] === 'ls') console.log(JSON.stringify([{configuration:{id:name,labels:{'dev.agent-container.managed':'true'},private:'must not leak'},status:{state:'running'}},{configuration:{id:'unrelated',labels:{}},status:{state:'running'}}]));
else if (args[0] === 'exec') {
  const at = args.indexOf(name), command = args.slice(at + 1);
  if (command[0] === 'hc') {
    if (command[1] === 'run') console.log(JSON.stringify({address:'t7'}));
    else if (command[1] === 'ls') console.log(JSON.stringify({terminals:[{address:'t7',name:'fixture'}],extra:'preserved'}));
  } else if (command[0] !== 'mkdir') {
    const child = cp.spawnSync(command[0], command.slice(1), {stdio:'inherit'});
    process.exit(child.status ?? 1);
  }
} else console.log('runtime progress');
`;
    writeFileSync(join(bin, "container"), runtime, { mode: 0o755 });
    writeFileSync(join(bin, "docker"), runtime, { mode: 0o755 });
    writeFileSync(
      join(bin, "trivy"),
      `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
fs.writeFileSync(args[args.indexOf('--output')+1], JSON.stringify({Results:[{Type:'fixture',Vulnerabilities:process.env.JSON_TEST_FINDING ? [{Severity:'HIGH'}] : []}]}));
console.log('scanner progress');
`,
      { mode: 0o755 },
    );
    const log = join(root, "calls.jsonl");
    writeFileSync(log, "");
    fn(root, {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      JSON_TEST_LOG: log,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function invoke(args: string[], env: NodeJS.ProcessEnv, input?: string) {
  return spawnSync(process.execPath, [cli, ...args], {
    env,
    input,
    encoding: "utf8",
  });
}

test("JSON help, version, skill and parsing failures need no runtime", () => {
  const env = { ...process.env, PATH: "" };
  for (const [flag, command] of [
    ["--help", "help"],
    ["--version", "version"],
    ["--skill", "skill"],
  ]) {
    const result = invoke([flag, "--json"], env);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.command, command);
    assert.equal(output.ok, true);
    if (command === "version") assert.equal(output.data.name, "agent-sandbox");
    else assert.ok(output.data.text.length > 100);
  }
  const error = invoke(["run", "--json", "--unknown"], env);
  assert.equal(error.status, 1);
  assert.equal(JSON.parse(error.stdout).ok, false);
  assert.match(JSON.parse(error.stdout).error.message, /Unknown option/);
  for (const args of [
    ["run", "--name", "bad/name", "--agent", "codex", "--prompt", "--json"],
    ["run", "--name", "bad/name", "--exec", "echo", "--json"],
    ["run", "--name", "--json"],
  ]) {
    const literal = invoke(args, env);
    assert.equal(literal.status, 1);
    assert.equal(literal.stdout, "");
  }
});

test("JSON lifecycle results stay structured and invalid interactive requests have no effects", () =>
  fixture((root, env) => {
    for (const args of [
      ["run", "--name", "json-test", "--json"],
      ["start", "--name", "json-test", "--json"],
      ["shell", "--name", "json-test", "--json"],
      ["attach", "--name", "json-test", "--terminal", "t7", "--json"],
      [
        "shell",
        "--name",
        "json-test",
        "--json",
        "--herdr-space",
        "json-test/sp1",
        "--exec",
        "echo",
        "hi",
      ],
    ]) {
      const result = invoke(args, env);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).ok, false);
    }
    assert.equal(readFileSync(env.JSON_TEST_LOG!, "utf8"), "");
    for (const command of ["run", "start", "shell"]) {
      const result = invoke(
        [
          command,
          "--name",
          "json-test",
          "--json",
          "--detach",
          ...(command === "run" ? ["--home", root] : []),
        ],
        env,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        command,
        ok: true,
        exit_code: 0,
        data: {
          name: "json-test",
          detached: true,
          terminal: "t7",
          address: "json-test/t7",
        },
      });
    }
    const list = invoke(["status", "--json"], env);
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout).data, {
      sandboxes: [{ name: "json-test", state: "running" }],
    });
    const terminals = invoke(
      ["terminals", "--name", "json-test", "--json"],
      env,
    );
    assert.equal(terminals.status, 0, terminals.stderr);
    assert.equal(JSON.parse(terminals.stdout).data.extra, "preserved");
    assert.equal(JSON.parse(terminals.stdout).data.terminals[0].address, "t7");
    for (const command of ["stop", "delete"]) {
      const result = invoke([command, "--name", "json-test", "--json"], env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).data.name, "json-test");
    }
    const normal = invoke(["shell", "--name", "json-test", "--detach"], env);
    assert.equal(normal.status, 0, normal.stderr);
    assert.equal(normal.stdout, "t7\n");
  }));

test("JSON foreground exec streams output, consumes stdin and preserves nonzero exit codes", () =>
  fixture((_root, env) => {
    const result = invoke(
      [
        "shell",
        "--name",
        "json-test",
        "--json",
        "--exec",
        process.execPath,
        "-e",
        "process.stdout.write(require('node:fs').readFileSync(0));process.stderr.write('child stderr');process.exit(7)",
      ],
      env,
      "piped input",
    );
    assert.equal(result.status, 7);
    const output = JSON.parse(result.stdout);
    assert.equal(output.exit_code, 7);
    assert.equal(output.ok, false);
    assert.equal(output.data.detached, false);
    assert.match(result.stderr, /piped input/);
    assert.match(result.stderr, /child stderr/);
    const calls: string[][] = readFileSync(env.JSON_TEST_LOG!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(!calls.some((args) => args.includes("hc")));
    const literal = invoke(
      [
        "shell",
        "--name",
        "json-test",
        "--exec",
        process.execPath,
        "-e",
        "process.stdout.write(process.argv[1])",
        "--",
        "--json",
      ],
      env,
    );
    assert.equal(literal.status, 0, literal.stderr);
    assert.equal(literal.stdout, "--json");
  }));

test("JSON scan preserves reports on both success and vulnerability failure", () =>
  fixture((_root, env) => {
    const image = `json-fixture-${process.pid}`;
    const report = join(ROOT, ".artifacts", `vulnerabilities-${image}.json`);
    try {
      for (const blocked of [false, true]) {
        const result = invoke(
          ["scan", "--engine", "docker", "--image", image, "--json"],
          { ...env, JSON_TEST_FINDING: blocked ? "yes" : "" },
        );
        assert.equal(result.status, blocked ? 1 : 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.data.report, report);
        assert.equal(output.ok, !blocked);
        assert.match(result.stderr, /Complete report:/);
        assert.ok(readFileSync(report, "utf8").includes('"Results"'));
      }
    } finally {
      rmSync(report, { force: true });
    }
  }));
