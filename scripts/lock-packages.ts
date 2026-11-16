import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { packageRequests, parseApkDatabase } from "../image/packages.ts";
import { DEFAULT_DNS } from "./sandbox.ts";

const { values } = parseArgs({
  options: {
    engine: { type: "string", default: "container" },
    arch: { type: "string" },
    dns: { type: "string", default: DEFAULT_DNS },
  },
});
const engine = values.engine!;
if (!["container", "docker"].includes(engine))
  throw new Error("Use --engine container|docker");
const arches = values.arch ? [values.arch] : ["arm64", "amd64"];
if (arches.some((a) => !["arm64", "amd64"].includes(a)))
  throw new Error("Use --arch arm64|amd64");
const results: { path: string; pins: string[] }[] = [];
for (const arch of arches) {
  const image = process.env.IMAGE_WOLFI_BASE;
  if (!image?.includes("@sha256:"))
    throw new Error("Missing pinned Wolfi base; run through mise");
  const name = `cs-lock-${randomUUID().slice(0, 8)}`;
  const invoke = (args: string[], capture = false): string =>
    execFileSync(engine, args, {
      encoding: "utf8",
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    }) ?? "";
  let created = false;
  try {
    invoke([
      "run",
      "-d",
      "--name",
      name,
      "--platform",
      `linux/${arch}`,
      ...(engine === "container" && arch === "amd64" ? ["--rosetta"] : []),
      ...(values.dns ? ["--dns", values.dns] : []),
      image,
      "sleep",
      "infinity",
    ]);
    created = true;
    const exec = (args: string[], capture = false) =>
      invoke(["exec", name, ...args], capture);
    const basePins = parseApkDatabase(
      exec(["cat", "/lib/apk/db/installed"], true),
    );
    for (const profile of ["base", "browser"] as const) {
      const requests = [
        ...packageRequests.base,
        ...(profile === "browser" ? packageRequests.browser : []),
      ].map((p) =>
        p === "nodejs-24" ? `${p}~${process.env.IMAGE_NODE_VERSION}` : p,
      );
      const simulation = exec(
        [
          "apk",
          "add",
          "--simulate",
          "--no-cache",
          "--timeout",
          "30",
          ...requests,
        ],
        true,
      );
      const resolved = new Map(
        basePins.map((pin) => pin.split("=") as [string, string]),
      );
      for (const line of simulation.split("\n")) {
        const change = line.match(
          /(?:Installing|Upgrading|Downgrading|Reinstalling) (\S+) \(([^)]+)\)/,
        );
        if (change) resolved.set(change[1], change[2].split(" -> ").at(-1)!);
        const removed = line.match(/Purging (\S+) /);
        if (removed) resolved.delete(removed[1]);
      }
      const pins = [...resolved]
        .map(([name, version]) => `${name}=${version}`)
        .sort();
      for (const requested of requests) {
        const name = requested.split("~", 1)[0];
        if (!resolved.has(name))
          throw new Error("APK solver omitted requested package: " + name);
      }
      results.push({
        path: join(
          import.meta.dirname,
          "..",
          "image",
          "locks",
          "wolfi",
          arch,
          `${profile}.txt`,
        ),
        pins,
      });
      console.log(`wolfi/${arch}/${profile}: resolved ${pins.length} packages`);
    }
  } finally {
    if (created)
      invoke(
        engine === "container"
          ? ["delete", "--force", name]
          : ["rm", "--force", name],
      );
  }
}
for (const result of results) {
  mkdirSync(dirname(result.path), { recursive: true });
  writeFileSync(result.path, `${result.pins.join("\n")}\n`);
}
