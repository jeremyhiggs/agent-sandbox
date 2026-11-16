import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRequests, parsePackagePins } from "../image/packages.ts";

const image = join(import.meta.dirname, "..", "image");
for (const arch of ["arm64", "amd64"]) {
  const pins = parsePackagePins(
    readFileSync(join(image, "locks", "wolfi", arch, "base.txt"), "utf8"),
  );
  const names = new Set(pins.map((pin) => pin.split("=", 1)[0]));
  for (const name of packageRequests)
    assert.ok(names.has(name), `wolfi/${arch}/base omits ${name}`);
  assert.ok(
    pins.some((pin) =>
      pin.startsWith(`nodejs-24=${process.env.IMAGE_NODE_VERSION}-`),
    ),
    "Node lock differs from mise pin",
  );
  assert.ok(
    pins.some((pin) => pin.startsWith(`gh=${process.env.IMAGE_GH_VERSION}-`)),
    "gh lock differs from mise pin",
  );
  console.log(`wolfi/${arch}/base: ${pins.length} exact package pins`);
}

for (const name of ["WOLFI", "MISE"])
  assert.match(
    process.env[`IMAGE_${name}_BASE`] ?? "",
    /@sha256:[a-f0-9]{64}$/,
  );
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
  "Base digests, package requests, tool archives and mise pins agree",
);
