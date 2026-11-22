import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
else if (args[0] === 'context') console.log('unix:///fixture/docker.sock');
else if (args[0] === 'image' && args[1] === 'inspect') {
  if (process.env.JSON_TEST_INSPECT_EXIT) process.exit(Number(process.env.JSON_TEST_INSPECT_EXIT));
  console.log('sha256:fixture linux/arm64');
}
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
fs.appendFileSync(process.env.JSON_TEST_LOG, JSON.stringify(['trivy',...args]) + '\\n');
if (args[0] === 'version') {
  if (process.env.JSON_TEST_VERSION_EXIT) process.exit(Number(process.env.JSON_TEST_VERSION_EXIT));
  console.log(JSON.stringify({Version:'fixture',VulnerabilityDB:{UpdatedAt:'after-scan'}})); process.exit(0);
}
if (args[0] === 'convert') {
  console.log('native policy table');
  process.exit(process.env.JSON_TEST_MIXED && args.at(-1).endsWith('-codex.json') ? 7 : process.env.JSON_TEST_FINDING ? 42 : 0);
}
if (process.env.JSON_TEST_SCANNER_EXIT) process.exit(Number(process.env.JSON_TEST_SCANNER_EXIT));
fs.writeFileSync(args[args.indexOf('--output')+1], JSON.stringify({Results:[]}));
console.log('scanner progress');
`,
      { mode: 0o755 },
    );
    const log = join(root, "calls.jsonl");
    writeFileSync(log, "");
    fn(root, {
      ...process.env,
      DOCKER_HOST: "",
      DOCKER_CONTEXT: "",
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
      assert.match(
        JSON.parse(result.stdout).error.message,
        args[0] === "attach"
          ? /--json cannot attach interactively/
          : /--json managed launches require --detach/,
      );
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
    const report = join(
      ROOT,
      ".artifacts",
      `vulnerabilities-docker-${image}.json`,
    );
    try {
      for (const blocked of [false, true]) {
        const result = invoke(
          ["scan", "--engine", "docker", "--image", image, "--json"],
          { ...env, JSON_TEST_FINDING: blocked ? "yes" : "" },
        );
        assert.equal(result.status, blocked ? 42 : 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.data.report, report);
        assert.equal(output.ok, !blocked);
        assert.match(result.stderr, /Complete report:/);
        assert.ok(readFileSync(report, "utf8").includes('"Results"'));
        const provenance = JSON.parse(
          readFileSync(report.replace(/\.json$/, ".trivy.json"), "utf8"),
        );
        assert.equal(provenance.trivy.VulnerabilityDB.UpdatedAt, "after-scan");
      }
      const calls = readFileSync(env.JSON_TEST_LOG!, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const scan = calls.find(
        (args) => args[0] === "trivy" && args[1] === "image",
      )!;
      assert.equal(
        scan[scan.indexOf("--docker-host") + 1],
        "unix:///fixture/docker.sock",
      );
      assert.equal(scan[scan.indexOf("--image-src") + 1], "docker");
      assert.equal(scan.at(-1), "sha256:fixture");
      assert.equal(scan[scan.indexOf("--scanners") + 1], "vuln,secret");
      assert.ok(!calls.some((args) => args.includes("save")));
      const scannerCalls = calls
        .filter((args) => args[0] === "trivy")
        .slice(0, 3);
      assert.deepEqual(
        scannerCalls.map((args) => args[1]),
        ["image", "version", "convert"],
      );
      assert.equal(
        scannerCalls[2][scannerCalls[2].indexOf("--scanners") + 1],
        "vuln,secret",
      );
      for (const [dockerEnv, endpoint] of [
        [
          { DOCKER_HOST: "unix:///override.sock", DOCKER_CONTEXT: "" },
          "unix:///override.sock",
        ],
        [
          { DOCKER_HOST: "unix:///ignored.sock", DOCKER_CONTEXT: "fixture" },
          "unix:///fixture/docker.sock",
        ],
      ] as const) {
        const result = invoke(
          ["scan", "--engine", "docker", "--image", image, "--json"],
          { ...env, ...dockerEnv },
        );
        assert.equal(result.status, 0, result.stderr);
        const lastScan = readFileSync(env.JSON_TEST_LOG!, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
          .findLast((args) => args[0] === "trivy" && args[1] === "image")!;
        assert.equal(lastScan[lastScan.indexOf("--docker-host") + 1], endpoint);
      }
      const failure = invoke(
        ["scan", "--engine", "docker", "--image", image, "--json"],
        { ...env, JSON_TEST_SCANNER_EXIT: "7" },
      );
      assert.equal(failure.status, 7, failure.stderr);
      assert.equal(JSON.parse(failure.stdout).data, null);
      assert.match(
        JSON.parse(failure.stdout).error.message,
        /execution failed/,
      );
      assert.throws(() => readFileSync(report));
      assert.throws(() =>
        readFileSync(report.replace(/\.json$/, ".trivy.json")),
      );
      const bin = env.PATH!.split(":")[0];
      chmodSync(join(bin, "trivy"), 0o644);
      const denied = invoke(
        ["scan", "--engine", "docker", "--image", image, "--json"],
        { ...env, PATH: bin },
      );
      assert.equal(denied.status, 126, denied.stderr);
      assert.equal(JSON.parse(denied.stdout).exit_code, 126);
      rmSync(join(bin, "trivy"));
      const missing = invoke(
        ["scan", "--engine", "docker", "--image", image, "--json"],
        { ...env, PATH: bin },
      );
      assert.equal(missing.status, 127, missing.stderr);
      assert.equal(JSON.parse(missing.stdout).exit_code, 127);
      writeFileSync(report, "old report");
      writeFileSync(report.replace(/\.json$/, ".trivy.json"), "old provenance");
      const inspectFailure = invoke(
        ["scan", "--engine", "docker", "--image", image, "--json"],
        { ...env, JSON_TEST_INSPECT_EXIT: "9" },
      );
      assert.equal(inspectFailure.status, 9, inspectFailure.stderr);
      assert.equal(JSON.parse(inspectFailure.stdout).data, null);
      assert.throws(() => readFileSync(report));
      assert.throws(() =>
        readFileSync(report.replace(/\.json$/, ".trivy.json")),
      );
    } finally {
      rmSync(report, { force: true });
      rmSync(report.replace(/\.json$/, ".trivy.json"), { force: true });
    }
  }));

test("repository audit preserves a post-scan metadata command failure", () =>
  fixture((root, env) => {
    mkdirSync(join(root, "scripts"));
    for (const file of [
      "scripts/security.ts",
      "scripts/vulnerabilities.ts",
      ".trivyignore.yaml",
    ])
      copyFileSync(join(ROOT, file), join(root, file));
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts/security.ts"), "repo"],
      {
        env: { ...env, JSON_TEST_VERSION_EXIT: "7" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 7, result.stderr);
    assert.ok(
      readFileSync(
        join(root, ".artifacts/vulnerabilities-repo.json"),
        "utf8",
      ).includes('"Results"'),
    );
    assert.throws(() =>
      readFileSync(join(root, ".artifacts/vulnerabilities-repo.trivy.json")),
    );
    const calls = readFileSync(env.JSON_TEST_LOG!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const scan = calls.find((args) => args[1] === "fs")!;
    assert.equal(scan[scan.indexOf("--scanners") + 1], "vuln");
    assert.ok(!calls.some((args) => args[1] === "convert"));
  }));

test("profile scans continue after findings and preserve execution-error precedence", () =>
  fixture((root, env) => {
    mkdirSync(join(root, "scripts"));
    for (const file of [
      "scripts/profiles.ts",
      "scripts/sandbox.ts",
      "scripts/build-os.ts",
      "scripts/vulnerabilities.ts",
      ".trivyignore.yaml",
    ])
      copyFileSync(join(ROOT, file), join(root, file));
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts/profiles.ts"), "scan", "docker"],
      {
        env: { ...env, JSON_TEST_FINDING: "yes", JSON_TEST_MIXED: "yes" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 7, result.stderr);
    assert.match(
      result.stderr,
      /base \(exit 42\).*codex \(exit 7\).*opencode \(exit 42\).*claude \(exit 42\)/,
    );
    const calls = readFileSync(env.JSON_TEST_LOG!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.filter((args) => args[0] === "trivy" && args[1] === "image").length,
      4,
    );
    for (const profile of ["base", "codex", "opencode", "claude"])
      assert.ok(
        readFileSync(
          join(
            root,
            `.artifacts/vulnerabilities-docker-agent-sandbox-${profile}.json`,
          ),
          "utf8",
        ).includes('"Results"'),
      );
  }));
