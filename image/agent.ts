import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const [agent, version] = process.argv.slice(2);
const packages: Record<string, string> = {
  codex: "@openai/codex",
  opencode: "@opencode/cli",
  claude: "@anthropic-ai/claude-code",
};
assert.ok(packages[agent], "Unknown agent");
const root = `/opt/tools/${agent}`;
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.deepEqual(manifest.dependencies, { [packages[agent]]: version });
execFileSync(
  "pnpm",
  ["--dir", root, "install", "--frozen-lockfile", "--ignore-scripts"],
  { stdio: "inherit" },
);
let binary = join(root, "node_modules", ".bin", agent);
if (agent !== "codex") {
  // Link the integrity-locked Linux binary directly. Vendor postinstall scripts
  // may fetch an unpinned fallback; none are run during this build.
  const require = createRequire(
    realpathSync(join(root, "node_modules", packages[agent], "package.json")),
  );
  const platform = `${packages[agent]}-linux-${process.arch}`;
  binary = join(
    dirname(require.resolve(`${platform}/package.json`)),
    ...(agent === "opencode" ? ["bin", "opencode"] : ["claude"]),
  );
}
symlinkSync(binary, `/usr/local/bin/${agent}`);
const actual = execFileSync(agent, ["--version"], { encoding: "utf8" });
assert.ok(actual.includes(version), `Unexpected ${agent} version: ${actual}`);
console.log(actual.trim());

rmSync("/opt/pnpm-home/store", { recursive: true, force: true });
