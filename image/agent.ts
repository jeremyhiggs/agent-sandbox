import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PROFILE_PACKAGES } from "./packages.ts";

const [agent, version] = process.argv.slice(2);
const profile = Object.entries(PROFILE_PACKAGES).find(
  ([name]) => name === agent && name !== "base",
)?.[1];
assert.ok(profile, "Unknown agent");
const { dependency } = profile;
const root = `/opt/tools/${agent}`;
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.deepEqual(manifest.dependencies, { [dependency]: version });
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
    realpathSync(join(root, "node_modules", dependency, "package.json")),
  );
  const platform = `${dependency}-linux-${process.arch}`;
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
