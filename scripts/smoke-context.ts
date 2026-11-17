import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT } from "./sandbox.ts";

const engine = process.argv[2] ?? "container";
assert.ok(["container", "docker"].includes(engine));
const root = mkdtempSync(join(tmpdir(), "sandbox-context-"));
const context = join(root, "context"),
  output = join(root, "output");
const allowed = [
  "mise.toml",
  "image/install.ts",
  "image/artifacts.json",
  "image/apko.lock.json",
  "image/apko.yaml",
  "image/tools/codex/package.json",
  "image/tools/codex/pnpm-lock.yaml",
  ".artifacts/os-probe.tar.gz",
];
const excluded = [
  "host-secret",
  "scripts/private.ts",
  "image/private.json",
  "image/tools/codex/node_modules/private",
  "image/tools/codex/other.json",
  ".artifacts/handoff.json",
  ".artifacts/codex-lifecycle-example/handoff.json",
];
try {
  mkdirSync(context);
  copyFileSync(join(ROOT, ".dockerignore"), join(context, ".dockerignore"));
  writeFileSync(join(context, "Dockerfile"), "FROM scratch\nCOPY . /\n");
  for (const file of [...allowed, ...excluded]) {
    const path = join(context, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "synthetic context probe\n");
  }
  execFileSync(
    engine,
    [
      "build",
      "--progress",
      "plain",
      "--output",
      `type=local,dest=${output},platform-split=false`,
      context,
    ],
    { stdio: "inherit" },
  );
  for (const file of allowed)
    assert.ok(existsSync(join(output, file)), `Missing ${file}`);
  for (const file of excluded)
    assert.ok(!existsSync(join(output, file)), `Build context exposed ${file}`);
  console.log(
    "Build context includes declared inputs and excludes worker reports, private files and installed dependencies",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
