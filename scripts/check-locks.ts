import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  packageRequests,
  parsePackagePins,
  verifyPackageInventory,
} from "../image/packages.ts";

const image = join(import.meta.dirname, "..", "image");
for (const arch of ["arm64", "amd64"]) {
  const read = (profile: string) =>
    parsePackagePins(
      readFileSync(
        join(image, "locks", "wolfi", arch, profile + ".txt"),
        "utf8",
      ),
    );
  const base = read("base"),
    browser = read("browser");
  verifyPackageInventory(base, browser, false);
  for (const profile of ["base", "browser"] as const) {
    const pins = profile === "base" ? base : browser;
    const names = new Set(pins.map((pin) => pin.split("=", 1)[0]));
    const roots = [
      ...packageRequests.base,
      ...(profile === "browser" ? packageRequests.browser : []),
    ];
    for (const name of roots)
      assert.ok(
        names.has(name),
        `wolfi/${arch}/${profile} lock omits ${name}; run lock:update`,
      );
    assert.ok(
      pins.some((pin) =>
        pin.startsWith(`nodejs-24=${process.env.IMAGE_NODE_VERSION}-`),
      ),
      "Node package lock differs from mise pin",
    );
    console.log(`wolfi/${arch}/${profile}: ${pins.length} exact package pins`);
  }
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
const tools = JSON.parse(
  readFileSync(join(image, "tools", "package.json"), "utf8"),
);
assert.equal(
  tools.dependencies["@openai/codex"],
  process.env.IMAGE_CODEX_VERSION,
);
assert.equal(
  tools.dependencies["agent-browser"],
  process.env.IMAGE_AGENT_BROWSER_VERSION,
);
console.log(
  "Base digests, package requests, tool archives and mise pins agree",
);
