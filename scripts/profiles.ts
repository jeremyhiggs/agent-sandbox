import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { PROFILES } from "../image/packages.ts";
import { buildImage, prepareBuild, ROOT } from "./build-os.ts";
import { failureExitCode } from "./process.ts";
import { POLICY_EXIT_CODE, scanImage } from "./vulnerabilities.ts";

const [command, engine = "container"] = process.argv.slice(2);
if (!["container", "docker"].includes(engine))
  throw new Error("Use container or docker");
const failed: { profile: string; exitCode: number }[] = [];
const osArchive = command === "build" ? prepareBuild() : undefined;
for (const profile of PROFILES) {
  const image = `agent-sandbox:${profile}`;
  if (osArchive) {
    console.log(`\nbuild: ${image}`);
    buildImage({ engine, profile }, osArchive);
    continue;
  }
  let runProfile: () => unknown;
  if (command === "audit" || command === "locks") {
    const args = [
      "--dir",
      join(ROOT, "image", "tools", profile),
      ...(command === "audit"
        ? ["audit", "--audit-level=moderate"]
        : [
            "install",
            "--lockfile-only",
            "--frozen-lockfile",
            "--ignore-scripts",
          ]),
    ];
    runProfile = () => execFileSync("pnpm", args, { stdio: "inherit" });
  } else if (command === "scan") {
    runProfile = () => scanImage(engine, image);
  } else if (command === "check") {
    runProfile = () =>
      execFileSync(
        engine,
        [
          "run",
          "--rm",
          ...(engine === "docker" ? ["--pull=never"] : []),
          image,
          "node",
          "/opt/agent-sandbox/check.ts",
        ],
        { stdio: "inherit" },
      );
  } else throw new Error("Use build|check|scan|audit|locks [container|docker]");
  console.log(`\n${command}: ${image}`);
  try {
    runProfile();
  } catch (error) {
    const failure = error as Error;
    if (command === "scan") console.error(failure.message);
    failed.push({
      profile,
      exitCode: failureExitCode(failure),
    });
  }
}

if (failed.length) {
  console.error(
    `${command} failed for: ${failed.map(({ profile, exitCode }) => `${profile} (exit ${exitCode})`).join(", ")}`,
  );
  process.exitCode = (
    failed.find(({ exitCode }) => exitCode !== POLICY_EXIT_CODE) ?? failed[0]
  ).exitCode;
}
