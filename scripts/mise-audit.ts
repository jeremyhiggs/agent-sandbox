import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ToolVersion = { tool: string; version: string };
type Finding = ToolVersion & {
  id: string;
  severity: "low" | "medium" | "high" | "critical" | null;
  url: string;
};

const root = join(import.meta.dirname, "..");
const options = { cwd: root, encoding: "utf8" } as const;
const lock: { tools: Record<string, { backend: string; version: string }[]> } =
  JSON.parse(
    execFileSync("taplo", ["get", "-f", "mise.lock", "-o", "json"], options),
  );
// Explicit backends let Linux audit macOS-only pins without installing them.
const pins = Object.values(lock.tools).flatMap((entries) =>
  entries.map(({ backend, version }) => `${backend}@${version}`),
);
const miseVersion = execFileSync("mise", ["--version"], options).split(
  " ",
  1,
)[0];
const requested = [...pins, `github:jdx/mise@${miseVersion}`];
const result = spawnSync("mise", ["audit", "--json", ...requested], options);
if (result.error) throw result.error;
if (result.stderr) process.stderr.write(result.stderr);
assert.ok(result.stdout, "mise audit did not produce an OSV report");
const report: { vulnerabilities: Finding[]; unchecked: ToolVersion[] } =
  JSON.parse(result.stdout);
assert.ok(
  Array.isArray(report.vulnerabilities) && Array.isArray(report.unchecked),
  "Invalid mise audit report",
);
assert.ok(
  result.status === 0 ||
    (result.status === 1 &&
      report.vulnerabilities.length &&
      !result.stderr.trim()),
  "mise audit did not complete",
);

const dir = join(root, ".artifacts");
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, "mise-audit.json"),
  `${JSON.stringify({ requested, ...report }, null, 2)}\n`,
);

for (const { tool, version } of report.unchecked)
  console.warn(`OSV coverage unavailable for ${tool}@${version}`);
const blocking = report.vulnerabilities.filter(
  ({ severity }) =>
    severity === "medium" || severity === "high" || severity === "critical",
);
for (const { tool, version, severity, id, url } of blocking)
  console.error(`${tool}@${version} ${severity} ${id} ${url}`);
console.log(
  `OSV reported ${blocking.length} Medium or higher findings and ${report.vulnerabilities.length - blocking.length} lower or unrated findings. See .artifacts/mise-audit.json.`,
);
process.exitCode = blocking.length ? 1 : 0;
