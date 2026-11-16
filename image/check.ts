import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  installedPackages,
  packagePins,
  verifyPackageInventory,
} from "./packages.ts";

verifyPackageInventory(packagePins(), installedPackages());

for (const tool of [
  "mise",
  "node",
  "pnpm",
  "git",
  "gh",
  "agent-browser",
  "hc",
  "jj",
]) {
  execFileSync(tool, ["--version"], { stdio: "inherit" });
}
for (const tool of ["npm", "npx", "gcc", "g++", "cc", "make", "pkg-config"]) {
  assert.notEqual(
    spawnSync("sh", ["-c", 'command -v "$1"', "check", tool]).status,
    0,
    `${tool} must not ship in the image`,
  );
}
const ssh = spawnSync("ssh", ["-V"], { encoding: "utf8" });
assert.equal(ssh.status, 0);
const version = ssh.stderr.match(/OpenSSH_(\d+)\.(\d+)/);
assert.ok(
  version &&
    (Number(version[1]) > 10 ||
      (Number(version[1]) === 10 && Number(version[2]) >= 4)),
  `OpenSSH 10.4 or newer is required: ${ssh.stderr}`,
);
for (const agent of ["codex", "opencode", "claude"]) {
  if (agent === process.env.IMAGE_AGENT) {
    execFileSync(agent, ["--version"], { stdio: "inherit" });
    const flags =
      agent === "codex"
        ? [
            "--no-daemon",
            "--dangerously-bypass-approvals-and-sandbox",
            "-c",
            'cli_auth_credentials_store="file"',
          ]
        : agent === "opencode"
          ? ["--standalone"]
          : [];
    const help = execFileSync(agent, [...flags, "--help"], {
      encoding: "utf8",
    });
    assert.ok(help.length > 0);
    if (agent === "opencode") assert.ok(help.includes("--prompt"));
  } else
    assert.notEqual(
      spawnSync("sh", ["-c", 'command -v "$1"', "check", agent]).status,
      0,
      `${agent} must only ship in its own image`,
    );
}
try {
  execFileSync(
    "agent-browser",
    [
      "open",
      "data:text/html,<title>Container smoke test</title><h1>Ready</h1>",
    ],
    { stdio: "inherit" },
  );
  const title = execFileSync("agent-browser", ["get", "title"], {
    encoding: "utf8",
  }).trim();
  assert.equal(title, "Container smoke test");
} finally {
  execFileSync("agent-browser", ["close"], { stdio: "inherit" });
}
console.log("Image tool and browser checks passed");
