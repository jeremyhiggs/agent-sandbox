import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packagePins } from "../image/packages.ts";

const image = join(import.meta.dirname, "..", "image");
for (const arch of ["arm64", "amd64"]) {
  const pins = packagePins(arch);
  assert.equal(
    new Set(pins.map((pin) => pin.split("=", 1)[0])).size,
    pins.length,
    "Duplicate package in native lockfile",
  );
  for (const [name, tool] of [
    ["nodejs-24", "NODE"],
    ["gh", "GH"],
  ])
    assert.ok(
      pins.some((pin) =>
        pin.startsWith(`${name}=${process.env[`IMAGE_${tool}_VERSION`]}-`),
      ),
      `${name} lock differs from mise pin`,
    );
  console.log(`apko/${arch}: ${pins.length} exact package pins`);
}
assert.match(process.env.IMAGE_MISE_BASE ?? "", /@sha256:[a-f0-9]{64}$/);
assert.ok(
  process.env.IMAGE_MISE_BASE?.includes(`:${process.env.IMAGE_MISE_VERSION}@`),
);
const artifacts = JSON.parse(
  readFileSync(join(image, "artifacts.json"), "utf8"),
);
for (const tool of ["pnpm", "jj", "hc"]) {
  assert.equal(
    artifacts[tool].version,
    process.env[`IMAGE_${tool.toUpperCase()}_VERSION`],
    `${tool} archive lock differs from mise pin`,
  );
  for (const entry of tool === "pnpm"
    ? [artifacts.pnpm]
    : [artifacts[tool].arm64, artifacts[tool].amd64]) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.url.startsWith("https://"));
  }
}
for (const [profile, dependency, variable] of [
  ["base", "agent-browser", "AGENT_BROWSER"],
  ["codex", "@openai/codex", "CODEX"],
  ["opencode", "@opencode/cli", "OPENCODE"],
  ["claude", "@anthropic-ai/claude-code", "CLAUDE"],
]) {
  const tools = JSON.parse(
    readFileSync(join(image, "tools", profile, "package.json"), "utf8"),
  );
  assert.deepEqual(tools.dependencies, {
    [dependency]: process.env[`IMAGE_${variable}_VERSION`],
  });
}
console.log(
  "Native OS lock, mise image digest, tool archives and version pins agree",
);
