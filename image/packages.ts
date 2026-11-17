import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ApkoLock = {
  contents: {
    packages: { name: string; version: string; architecture: string }[];
  };
};

export function lockedPackages(lock: ApkoLock, arch: string): string[] {
  const architecture =
    arch === "arm64"
      ? "aarch64"
      : ["amd64", "x64"].includes(arch)
        ? "x86_64"
        : undefined;
  if (!architecture) throw new Error(`Unsupported architecture: ${arch}`);
  const pins = lock.contents.packages
    .filter((pkg) => pkg.architecture === architecture)
    .map((pkg) => `${pkg.name}=${pkg.version}`)
    .sort();
  if (!pins.length) throw new Error(`Lockfile has no packages for ${arch}`);
  return pins;
}

export function parseApkDatabase(database: string): string[] {
  return database
    .trim()
    .split(/\n\n+/)
    .map((record) => {
      const fields = Object.fromEntries(
        record.split("\n").map((line) => [line.slice(0, 1), line.slice(2)]),
      );
      if (!fields.P || !fields.V)
        throw new Error("Invalid APK inventory record");
      return `${fields.P}=${fields.V}`;
    })
    .sort();
}

export function verifyPackageInventory(
  expected: string[],
  actual: string[],
  exact = true,
): void {
  const installed = new Set(actual),
    locked = new Set(expected);
  const missing = expected.filter((pin) => !installed.has(pin));
  const extra = exact ? actual.filter((pin) => !locked.has(pin)) : [];
  if (missing.length || extra.length)
    throw new Error(
      `Package lock mismatch: missing/changed [${missing.join(", ")}]; extra [${extra.join(", ")}]`,
    );
}

export function packagePins(arch: string = process.arch): string[] {
  return lockedPackages(
    JSON.parse(
      readFileSync(join(import.meta.dirname, "apko.lock.json"), "utf8"),
    ),
    arch,
  );
}

export function installedPackages(): string[] {
  return parseApkDatabase(readFileSync("/lib/apk/db/installed", "utf8"));
}
