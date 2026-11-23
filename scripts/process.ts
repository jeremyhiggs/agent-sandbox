import { execFileSync } from "node:child_process";

export function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  });
}

export function failureExitCode(error: unknown): number {
  const failure = error as {
    exitCode?: number;
    status?: number;
    code?: string;
  };
  return (
    failure.exitCode ??
    failure.status ??
    (failure.code === "ENOENT" ? 127 : failure.code === "EACCES" ? 126 : 1)
  );
}
