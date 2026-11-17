import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { buildImage, PROFILES, prepareBuild, ROOT } from "./sandbox.ts";

const [command, engine = "container"] = process.argv.slice(2);
if (!["container", "docker"].includes(engine))
  throw new Error("Use container or docker");
const failed: string[] = [];
const osArchive = command === "build" ? prepareBuild() : undefined;
for (const profile of PROFILES) {
  const image = `agent-container:${profile}`;
  if (osArchive) {
    console.log(`\nbuild: ${image}`);
    buildImage({ engine, profile }, osArchive);
    continue;
  }
  let binary: string;
  let args: string[];
  if (command === "audit" || command === "locks") {
    binary = "pnpm";
    args = [
      "--dir",
      join(ROOT, "image", "tools", profile),
      ...(command === "audit"
        ? ["audit", "--audit-level=high"]
        : [
            "install",
            "--lockfile-only",
            "--frozen-lockfile",
            "--ignore-scripts",
          ]),
    ];
  } else if (command === "scan") {
    binary = "node";
    args = [
      join(ROOT, "scripts", "sandbox.ts"),
      command,
      "--engine",
      engine,
      "--profile",
      profile,
    ];
  } else if (command === "check") {
    binary = engine;
    args = ["run", "--rm", image, "node", "/opt/agent-container/check.ts"];
  } else throw new Error("Use build|check|scan|audit|locks [container|docker]");
  console.log(`\n${command}: ${image}`);
  try {
    execFileSync(binary, args, { stdio: "inherit" });
  } catch (error) {
    failed.push(profile);
  }
}

if (failed.length)
  throw new Error(`${command} failed for: ${failed.join(", ")}`);
