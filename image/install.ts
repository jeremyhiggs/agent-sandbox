import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installedPackages,
  packagePins,
  verifyPackageInventory,
} from "./packages.ts";

function run(command: string, args: string[]) {
  execFileSync(command, args, { stdio: "inherit" });
}
type Artifact = { url: string; sha256: string };
type Release = { version: string; arm64: Artifact; amd64: Artifact };
const locks = JSON.parse(
  readFileSync(join(import.meta.dirname, "artifacts.json"), "utf8"),
) as {
  pnpm: Artifact & { version: string };
  jj: Release;
  hc: Release;
};
verifyPackageInventory(packagePins(), installedPackages());
async function install(
  tool: "pnpm" | "jj" | "hc",
  destination: string,
  members: string[],
) {
  const release = locks[tool];
  assert.equal(
    release.version,
    process.env[tool.toUpperCase() + "_VERSION"],
    tool + " artifact lock differs from mise pin",
  );
  const artifact =
    tool === "pnpm"
      ? locks.pnpm
      : (release as Release)[process.arch === "arm64" ? "arm64" : "amd64"];
  const response = await fetch(artifact.url);
  if (!response.ok) throw new Error(tool + " archive HTTP " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    artifact.sha256,
    tool + " archive checksum mismatch",
  );
  const temp = mkdtempSync(join(tmpdir(), tool + "-install-"));
  try {
    const archive = join(temp, "archive.tar.gz");
    writeFileSync(archive, bytes);
    mkdirSync(destination, { recursive: true });
    run("tar", ["-xzf", archive, "-C", destination, ...members]);
  } finally {
    rmSync(temp, { recursive: true });
  }
}
await install("jj", "/opt/jj", ["./jj", "./LICENSE"]);
symlinkSync("/opt/jj/jj", "/usr/local/bin/jj");
await install("pnpm", "/opt/pnpm", ["--strip-components=1"]);
symlinkSync("/opt/pnpm/bin/pnpm.cjs", "/usr/local/bin/pnpm");
const manifest = JSON.parse(
  readFileSync("/opt/tools/base/package.json", "utf8"),
) as { dependencies: Record<string, string> };
assert.equal(
  manifest.dependencies["agent-browser"],
  process.env.AGENT_BROWSER_VERSION,
);
run("pnpm", [
  "--dir",
  "/opt/tools/base",
  "install",
  "--frozen-lockfile",
  "--ignore-scripts",
]);
for (const tool of ["agent-browser"])
  symlinkSync(
    "/opt/tools/base/node_modules/.bin/" + tool,
    "/usr/local/bin/" + tool,
  );
await install("hc", "/usr/local/bin", ["herdr-core"]);
symlinkSync("herdr-core", "/usr/local/bin/hc");
for (const tool of ["mise", "node", "pnpm", "agent-browser", "hc", "jj"])
  run(tool, ["--version"]);

rmSync("/opt/pnpm-home/store", { recursive: true, force: true });
