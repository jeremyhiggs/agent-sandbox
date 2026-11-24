import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

function versionParts(version: string): bigint[] {
  assert.match(
    version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    "Expected a stable version in package.json",
  );
  return version.split(".").map(BigInt);
}

export function releasePlan(before: string, after: string, changelog: string) {
  const previous = versionParts(before);
  const next = versionParts(after);
  const firstChange = next.findIndex((part, index) => part !== previous[index]);
  if (firstChange === -1 || next[firstChange] < previous[firstChange]) return;

  for (const section of changelog.split(/^## /m).slice(1)) {
    const [heading, ...body] = section.split(/\r?\n/);
    if (heading.trim() !== after) continue;
    const notes = body.join("\n").trim();
    assert.ok(notes, `Empty changelog entry for ${after}`);
    return { tag: `v${after}`, notes };
  }
  throw new Error(`Missing changelog entry for ${after}`);
}

if (import.meta.main) {
  const before = process.env.BEFORE_SHA ?? "";
  assert.match(
    before,
    /^[a-f0-9]{40}$/,
    "Expected the GitHub push's before SHA",
  );
  if (before !== "0".repeat(40)) {
    execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", before], {
      stdio: "inherit",
    });
    const previous = JSON.parse(
      execFileSync("git", ["show", `${before}:package.json`], {
        encoding: "utf8",
      }),
    );
    const current = JSON.parse(readFileSync("package.json", "utf8"));
    const plan = releasePlan(
      previous.version,
      current.version,
      readFileSync("CHANGELOG.md", "utf8"),
    );
    if (plan) {
      const output = process.env.GITHUB_OUTPUT;
      assert.ok(output, "GITHUB_OUTPUT is required");
      const delimiter = randomUUID();
      appendFileSync(
        output,
        `tag=${plan.tag}\nnotes<<${delimiter}\n${plan.notes}\n${delimiter}\n`,
      );
    }
  }
}
