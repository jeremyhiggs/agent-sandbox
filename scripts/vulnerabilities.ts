import { readFileSync } from "node:fs";

export function checkVulnerabilities(
  report: string,
  log: (message: string) => void = console.log,
): void {
  const results = JSON.parse(readFileSync(report, "utf8")) as {
    Results?: {
      Type: string;
      Vulnerabilities?: { Severity: string; FixedVersion?: string }[];
    }[];
  };
  let blocked = 0;
  for (const result of results.Results ?? []) {
    const counts: Record<string, number> = {};
    let fixable = 0;
    for (const vulnerability of result.Vulnerabilities ?? []) {
      counts[vulnerability.Severity] =
        (counts[vulnerability.Severity] ?? 0) + 1;
      if (["HIGH", "CRITICAL"].includes(vulnerability.Severity)) {
        blocked++;
        if (vulnerability.FixedVersion) fixable++;
      }
    }
    log(
      `${result.Type}: ${JSON.stringify(counts)}; fixable HIGH/CRITICAL: ${fixable}`,
    );
  }
  log(`Complete report: ${report}`);
  if (blocked)
    throw new Error(
      `Vulnerability gate failed: ${blocked} HIGH/CRITICAL package findings`,
    );
}
