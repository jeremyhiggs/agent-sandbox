import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
if (args[0] === 'inspect') console.log(JSON.stringify([{configuration:{id:name,labels:process.env.JSON_TEST_LABELS ? JSON.parse(process.env.JSON_TEST_LABELS) : {'dev.agent-container.managed':'true','dev.agent-container.herdr':'false','dev.agent-container.checkout':'/workspace'}}}]));
else if (args[0] === 'image' && args[1] === 'save') {
  fs.writeFileSync(args[args.indexOf('--output')+1], JSON.stringify({image:args.at(-1),context:process.env.DOCKER_CONTEXT,host:process.env.DOCKER_HOST}));
}
else if (args[0] === 'image' && args[1] === 'inspect') {
  if (process.env.JSON_TEST_INSPECT_EXIT) process.exit(Number(process.env.JSON_TEST_INSPECT_EXIT));
  const images = {'fixture/requested:dev':'sha256:requested','agent-sandbox:base':'sha256:base','agent-sandbox:codex':'sha256:codex','agent-sandbox:opencode':'sha256:opencode','agent-sandbox:claude':'sha256:claude'};
  const digest = images[args.at(-1)];
  if (!digest) { console.error('Unexpected image reference: ' + args.at(-1)); process.exit(8); }
  console.log(digest + ' linux/arm64');
}
else if (args[0] === 'ls') console.log(JSON.stringify([{configuration:{id:name,labels:{'dev.agent-container.managed':'true'},private:'must not leak'},status:{state:'running'}},{configuration:{id:'legacy',labels:{'dev.codex-sandbox.managed':'true'}},status:{state:'stopped'}},{configuration:{id:'unrelated',labels:{}},status:{state:'running'}},{configuration:{id:'boolean-label',labels:{'dev.agent-container.managed':true}},status:{state:'running'}}]));
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
  process.exit(process.env.JSON_TEST_MIXED && args.at(-1).includes('-codex-') ? 7 : process.env.JSON_TEST_FINDING ? 42 : 0);
}
if (args[0] === 'image') fs.appendFileSync(process.env.JSON_TEST_LOG, JSON.stringify(['archive',JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1],'utf8'))]) + '\\n');
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

test("creation resolves host checkout identities and explicit overrides without writing Git config", () =>
  fixture((root, inherited) => {
    const work = join(root, "checkout");
    const env = { ...inherited };
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_")) delete env[key];
    delete env.EMAIL;
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = join(root, "global.gitconfig");
    const git = (...args: string[]) =>
      execFileSync("git", args, { env, encoding: "utf8" });
    git("init", "-q", work);
    const metadata = git("-C", work, "rev-parse", "--absolute-git-dir").trim();
    writeFileSync(
      env.GIT_CONFIG_GLOBAL,
      `[includeIf "gitdir:${metadata}"]\n  path = ${join(root, "identity.gitconfig")}\n`,
    );
    writeFileSync(
      join(root, "identity.gitconfig"),
      "[user]\n  name = Checkout User\n  email = checkout@example.invalid\n",
    );
    writeFileSync(join(root, "empty.gitconfig"), "");
    const config = readFileSync(join(metadata, "config"), "utf8");
    const hostIdentity = {
      GIT_AUTHOR_NAME: "Host Author",
      GIT_AUTHOR_EMAIL: "author@example.invalid",
      GIT_COMMITTER_NAME: "Host Committer",
      GIT_COMMITTER_EMAIL: "committer@example.invalid",
    };
    const cases = [
      {
        mount: true,
        flags: [],
        extra: {
          GIT_AUTHOR_DATE: "not-a-date",
          GIT_COMMITTER_DATE: "not-a-date",
        },
        expected: [
          "Checkout User",
          "checkout@example.invalid",
          "Checkout User",
          "checkout@example.invalid",
        ],
      },
      {
        mount: true,
        flags: [],
        extra: hostIdentity,
        expected: [
          "Host Author",
          "author@example.invalid",
          "Host Committer",
          "committer@example.invalid",
        ],
      },
      {
        mount: true,
        flags: [
          "--git-name",
          "Override User",
          "--git-email",
          "override@example.invalid",
        ],
        extra: hostIdentity,
        expected: [
          "Override User",
          "override@example.invalid",
          "Override User",
          "override@example.invalid",
        ],
      },
      {
        mount: true,
        flags: ["--git-name", "Name Override"],
        extra: {},
        expected: [
          "Name Override",
          "checkout@example.invalid",
          "Name Override",
          "checkout@example.invalid",
        ],
      },
      {
        mount: true,
        flags: ["--git-email", "email-override@example.invalid"],
        extra: {},
        expected: [
          "Checkout User",
          "email-override@example.invalid",
          "Checkout User",
          "email-override@example.invalid",
        ],
      },
      {
        mount: true,
        flags: [],
        extra: { GIT_CONFIG_GLOBAL: join(root, "empty.gitconfig") },
        expected: [],
      },
      { mount: false, flags: [], extra: hostIdentity, expected: [] },
      {
        mount: false,
        flags: [
          "--git-name",
          "Explicit User",
          "--git-email",
          "explicit@example.invalid",
        ],
        extra: {},
        expected: [
          "Explicit User",
          "explicit@example.invalid",
          "Explicit User",
          "explicit@example.invalid",
        ],
      },
    ];
    for (const scenario of cases) {
      writeFileSync(env.JSON_TEST_LOG!, "");
      const result = invoke(
        [
          "run",
          "--name",
          "json-test",
          "--home",
          root,
          "--detach",
          "--json",
          ...(scenario.mount ? ["--mount-git", work] : []),
          ...scenario.flags,
        ],
        { ...env, ...scenario.extra },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).ok, true);
      const launch = readFileSync(env.JSON_TEST_LOG!, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
        .find((args) => args[0] === "run")!;
      const variables = launch.flatMap((arg, i) =>
        arg === "--env" ? [launch[i + 1]] : [],
      );
      const keys = [
        "GIT_AUTHOR_NAME",
        "GIT_AUTHOR_EMAIL",
        "GIT_COMMITTER_NAME",
        "GIT_COMMITTER_EMAIL",
      ];
      assert.deepEqual(
        variables.filter((value) =>
          keys.some((key) => value.startsWith(key + "=")),
        ),
        scenario.expected.map((value, i) => `${keys[i]}=${value}`),
      );
      assert.equal(readFileSync(join(metadata, "config"), "utf8"), config);
      if (scenario.mount && !scenario.expected.length)
        assert.match(result.stderr, /Host Git identity.*unavailable/);
    }
  }));

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
    ["status", "--", "--json"],
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
      sandboxes: [
        { name: "json-test", state: "running" },
        { name: "legacy", state: "stopped" },
      ],
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

test("guest access requires an exact current or legacy ownership label", () =>
  fixture((_root, env) => {
    for (const [labels, accepted] of [
      [{ "dev.agent-container.managed": "true" }, true],
      [{ "dev.codex-sandbox.managed": "true" }, true],
      [{ "dev.agent-container.managed": "false" }, false],
      [{ "dev.agent-container.managed": true }, false],
      [{}, false],
    ] as const) {
      writeFileSync(env.JSON_TEST_LOG!, "");
      const result = invoke(["terminals", "--name", "json-test", "--json"], {
        ...env,
        JSON_TEST_LABELS: JSON.stringify(labels),
      });
      assert.equal(result.status, accepted ? 0 : 1, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, accepted);
      if (accepted)
        assert.deepEqual(output.data.terminals, [
          { address: "t7", name: "fixture" },
        ]);
      else {
        assert.match(
          output.error.message,
          /Guest is not owned by this launcher/,
        );
        const calls = readFileSync(env.JSON_TEST_LOG!, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
        assert.ok(
          !calls.some((args) => args[0] === "exec"),
          "unowned guests must not be executed",
        );
      }
    }
  }));

test("failed Herdr registration deletes only its new container and preserves existing machines", () =>
  fixture((root, env) => {
    writeFileSync(
      join(root, "bin", "hc"),
      `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(process.env.JSON_TEST_LOG, JSON.stringify(['hc', ...args]) + '\\n');
if (args[0] === 'machine' && args[1] === 'ls') {
  console.log(JSON.stringify({machines: process.env.JSON_TEST_REGISTRATION === 'conflict' ? [{name:'json-test',via:true,target:'existing-transport'}] : [{name:'unrelated',via:true,target:'preserved-transport'}]}));
} else if (args[0] === 'machine' && args[1] === 'add') {
  console.error('fixture registration failed'); process.exit(17);
} else if (args[0] === 'machine' && args[1] === 'rm') process.exit(0);
else { console.error('Unexpected hc command'); process.exit(91); }
`,
      { mode: 0o755 },
    );
    for (const [scenario, status] of [
      ["conflict", 1],
      ["add-failure", 17],
    ] as const) {
      writeFileSync(env.JSON_TEST_LOG!, "");
      const result = invoke(
        [
          "run",
          "--name",
          "json-test",
          "--home",
          root,
          "--herdr",
          "--hc-session",
          "fixture-session",
          "--detach",
          "--json",
        ],
        {
          ...env,
          JSON_TEST_REGISTRATION: scenario,
          JSON_TEST_LABELS: JSON.stringify({
            "dev.agent-container.managed": "true",
            "dev.agent-container.herdr": "true",
            "dev.agent-container.checkout": "/workspace",
          }),
        },
      );
      assert.equal(result.status, status, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, false);
      assert.match(
        output.error.message,
        scenario === "conflict"
          ? /already exists with another transport/
          : /Command failed: hc machine add/,
      );
      if (scenario === "add-failure")
        assert.match(result.stderr, /fixture registration failed/);
      const calls = readFileSync(env.JSON_TEST_LOG!, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(calls.filter((args) => args[0] === "run").length, 1);
      assert.deepEqual(
        calls.filter((args) => args[0] === "delete"),
        [["delete", "--force", "json-test"]],
      );
      assert.ok(
        !calls.some(
          (args) =>
            args[0] === "hc" && args[1] === "machine" && args[2] === "rm",
        ),
        "rollback must preserve existing host machines",
      );
    }
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

test("JSON scans preserve independent reports and export the selected Docker image", () =>
  fixture((_root, env) => {
    const image = "fixture/requested:dev";
    const reports: string[] = [];
    try {
      for (const blocked of [false, true]) {
        const result = invoke(
          ["scan", "--engine", "docker", "--image", image, "--json"],
          { ...env, JSON_TEST_FINDING: blocked ? "yes" : "" },
        );
        assert.equal(result.status, blocked ? 42 : 0, result.stderr);
        const output = JSON.parse(result.stdout);
        const report: string = output.data.report;
        assert.ok(!reports.includes(report), "each invocation owns its report");
        reports.push(report);
        assert.equal(output.ok, !blocked);
        assert.match(result.stderr, /Complete report:/);
        assert.ok(readFileSync(report, "utf8").includes('"Results"'));
        const observation = JSON.parse(
          readFileSync(report.replace(/\.json$/, ".trivy.json"), "utf8"),
        );
        assert.equal(observation.observation, "post-scan-cache");
        assert.equal(observation.trivy.VulnerabilityDB.UpdatedAt, "after-scan");
      }
      const calls = readFileSync(env.JSON_TEST_LOG!, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const scan = calls.find(
        (args) => args[0] === "trivy" && args[1] === "image",
      )!;
      const save = calls.find(
        (args) => args[0] === "image" && args[1] === "save",
      )!;
      assert.equal(save.at(-1), "sha256:requested");
      assert.equal(
        scan[scan.indexOf("--input") + 1],
        save[save.indexOf("--output") + 1],
      );
      assert.equal(scan[scan.indexOf("--scanners") + 1], "vuln,secret");
      assert.ok(!scan.includes("--docker-host"));
      const scannerCalls = calls
        .filter((args) => args[0] === "trivy")
        .slice(0, 3);
      assert.deepEqual(
        scannerCalls.map((args) => args[1]),
        ["image", "version", "convert"],
      );
      assert.equal(scannerCalls[2].at(-1), reports[0]);
      assert.equal(
        scannerCalls[2][scannerCalls[2].indexOf("--scanners") + 1],
        "vuln,secret",
      );
      for (const dockerEnv of [
        { DOCKER_HOST: "unix:///override.sock", DOCKER_CONTEXT: "" },
        { DOCKER_HOST: "unix:///ignored.sock", DOCKER_CONTEXT: "ssh-fixture" },
        { DOCKER_HOST: "", DOCKER_CONTEXT: "tls-fixture" },
      ]) {
        const result = invoke(
          ["scan", "--engine", "docker", "--image", image, "--json"],
          { ...env, ...dockerEnv },
        );
        assert.equal(result.status, 0, result.stderr);
        reports.push(JSON.parse(result.stdout).data.report);
        const archive = readFileSync(env.JSON_TEST_LOG!, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .findLast((args) => args[0] === "archive")[1];
        assert.deepEqual(archive, {
          image: "sha256:requested",
          context: dockerEnv.DOCKER_CONTEXT,
          host: dockerEnv.DOCKER_HOST,
        });
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
      for (const report of reports)
        assert.ok(readFileSync(report, "utf8").includes('"Results"'));
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
      const inspectFailure = invoke(
        ["scan", "--engine", "docker", "--image", image, "--json"],
        { ...env, JSON_TEST_INSPECT_EXIT: "9" },
      );
      assert.equal(inspectFailure.status, 9, inspectFailure.stderr);
      assert.equal(JSON.parse(inspectFailure.stdout).data, null);
      for (const report of reports)
        assert.ok(readFileSync(report, "utf8").includes('"Results"'));
    } finally {
      for (const report of reports) {
        rmSync(report, { force: true });
        rmSync(report.replace(/\.json$/, ".trivy.json"), { force: true });
      }
    }
  }));

test("repository audit preserves a post-scan metadata command failure", () =>
  fixture((root, env) => {
    mkdirSync(join(root, "scripts"));
    for (const file of [
      "scripts/security.ts",
      "scripts/vulnerabilities.ts",
      "scripts/process.ts",
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
    const report = join(
      root,
      ".artifacts",
      readdirSync(join(root, ".artifacts")).find((name) =>
        name.startsWith("vulnerabilities-repo-"),
      )!,
    );
    assert.ok(readFileSync(report, "utf8").includes('"Results"'));
    assert.throws(() => readFileSync(report.replace(/\.json$/, ".trivy.json")));
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
    mkdirSync(join(root, "image"));
    for (const file of [
      "image/packages.ts",
      "scripts/profiles.ts",
      "scripts/build-os.ts",
      "scripts/vulnerabilities.ts",
      "scripts/process.ts",
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
    assert.deepEqual(
      calls
        .filter((args) => args[0] === "archive")
        .map((args) => (args[1] as unknown as { image: string }).image),
      ["sha256:base", "sha256:codex", "sha256:opencode", "sha256:claude"],
    );
    for (const profile of ["base", "codex", "opencode", "claude"])
      assert.ok(
        readFileSync(
          join(
            root,
            ".artifacts",
            readdirSync(join(root, ".artifacts")).find(
              (name) =>
                name.startsWith(
                  `vulnerabilities-docker-agent-sandbox-${profile}-`,
                ) && !name.endsWith(".trivy.json"),
            )!,
          ),
          "utf8",
        ).includes('"Results"'),
      );
  }));
