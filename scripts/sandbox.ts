import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  join,
  posix,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildOS } from "./build-os.ts";
import { scanWithTrivy } from "./vulnerabilities.ts";

export const ROOT = resolve(import.meta.dirname, "..");
export const PROFILES = ["base", "codex", "opencode", "claude"] as const;
export type Agent = "codex" | "opencode" | "claude";
export const DEFAULT_DNS = process.env.CONTAINER_DNS ?? "1.1.1.1";
export const CODEX_SQLITE_HOME = "/var/lib/agent-sandbox/codex";
const CODEX_AUTH_FILE = "auth.json";
const LABEL = "dev.agent-container.managed";
const LEGACY_LABEL = "dev.codex-sandbox.managed";
const HERDR_LABEL = "dev.agent-container.herdr";
const CHECKOUT_LABEL = "dev.agent-container.checkout";
const CORE_LABEL = "dev.agent-container.hc-session";
const CORE_SOCKET_LABEL = "dev.agent-container.hc-socket";
const VIA_LABEL = "dev.agent-container.hc-via";
const SPACE_LABEL = "dev.agent-container.herdr-space";
const TAB_LABEL = "dev.agent-container.herdr-tab";

export function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  });
}
function inside(path: string, parent: string): boolean {
  return (
    path === parent ||
    path.startsWith(parent.endsWith(sep) ? parent : parent + sep)
  );
}
// Host volumes may ignore case even though the Linux guest does not.
// realpathSync resolves links but does not normalize pathname case.
function hostInside(path: string, parent: string): boolean {
  const root = statSync(parent, { bigint: true, throwIfNoEntry: false });
  if (!root) return false;
  let current = path;
  while (true) {
    const entry = statSync(current, { bigint: true, throwIfNoEntry: false });
    if (entry?.dev === root.dev && entry.ino === root.ino) return true;
    const next = dirname(current);
    if (next === current) return false;
    current = next;
  }
}
function file(path: string): boolean {
  return existsSync(path) && lstatSync(path).isFile();
}
function pointer(path: string): string {
  return resolve(dirname(path), readFileSync(path, "utf8").trim());
}

function directory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function gitMetadata(path: string): string {
  const git = executable("git");
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  try {
    return realpathSync(
      execFileSync(git, ["rev-parse", "--resolve-git-dir", path], {
        cwd: "/",
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    throw new Error(`Invalid Git metadata directory: ${path}`);
  }
}

export function repositoryMounts(checkout: string): string[] {
  const mounts = new Set([realpathSync(checkout)]);
  let git = join(checkout, ".git");
  const info = lstatSync(git, { throwIfNoEntry: false });
  if (info?.isSymbolicLink())
    throw new Error(`Git metadata cannot be a symlink: ${git}`);
  if (info?.isDirectory()) gitMetadata(git);
  else if (file(git)) {
    const text = readFileSync(git, "utf8").trim();
    if (!text.startsWith("gitdir: "))
      throw new Error(`Unrecognized Git pointer: ${git}`);
    git = realpathSync(resolve(checkout, text.slice(8)));
    const backlink = join(git, "gitdir");
    const commondir = join(git, "commondir");
    if (
      !file(backlink) ||
      pointer(backlink) !== join(checkout, ".git") ||
      !file(commondir)
    ) {
      throw new Error(
        `Git metadata is not registered to this worktree: ${git}`,
      );
    }
    const common = gitMetadata(pointer(commondir));
    if (git !== join(common, "worktrees", basename(git)))
      throw new Error(
        `Worktree is not registered in this common Git store: ${git}`,
      );
    gitMetadata(git);
    mounts.add(common);
  } else if (info) throw new Error(`Invalid Git metadata: ${git}`);
  return [...mounts].sort();
}

function directSymlinkTarget(path: string): string {
  const target = resolve(dirname(path), readlinkSync(path));
  const canonical = realpathSync(path);
  if (target !== canonical)
    throw new Error(
      `Unsupported chained symlink: ${path}; use a direct canonical target`,
    );
  return target;
}

export function withSymlinkTargets(paths: string[], home?: string): string[] {
  const mounts = new Set<string>();
  function approve(path: string) {
    if (home && hostInside(home, path))
      throw new Error(`Refusing a mount that exposes host home: ${path}`);
    mounts.add(path);
  }
  for (const path of paths) {
    approve(path);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) approve(directSymlinkTarget(path));
    else if (info.isDirectory()) {
      if (realpathSync(path) !== path)
        throw new Error(`Skill root cannot use symlinked ancestors: ${path}`);
      // Only the host's direct skill links approve additional roots. Contents
      // of those roots can be writable through a separately shared checkout.
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isSymbolicLink() && existsSync(child))
          approve(directSymlinkTarget(child));
      }
    }
  }
  const visited = new Set<string>();
  function visit(path: string) {
    if (visited.has(path)) return;
    visited.add(path);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      const target = directSymlinkTarget(path);
      if (
        ![...mounts].some(
          (root) => inside(target, root) && hostInside(target, root),
        )
      )
        throw new Error(
          `Nested skill symlink points outside approved skill roots: ${path}`,
        );
      visit(target);
    } else if (info.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (
          entry.isDirectory() ||
          (entry.isSymbolicLink() && existsSync(child))
        )
          visit(child);
      }
    }
  }
  for (const path of paths) visit(path);
  return [...mounts].sort();
}

type Mount = { source: string; readonly: boolean };
type MountOptions = {
  volume?: string[];
  "mount-codex-auth"?: boolean;
  "mount-skills"?: boolean;
};

function directoryMount(spec: string): Mount & { target: string } {
  const parts = spec.split(":");
  const [source, target, access] = parts;
  if (
    parts.length !== 3 ||
    !source ||
    !target ||
    !posix.isAbsolute(target) ||
    !["ro", "rw"].includes(access) ||
    /[,\n]/.test(spec)
  )
    throw new Error("--volume requires SOURCE:/absolute/TARGET:ro|rw");
  return {
    source: resolve(source),
    target: posix.resolve(target),
    readonly: access === "ro",
  };
}

export function mountPlan(
  checkout: string | undefined,
  home: string,
  options: MountOptions = {},
): Map<string, Mount> {
  const hostHome = realpathSync(homedir());
  const mounts = new Map<string, Mount>(
    (checkout ? repositoryMounts(checkout) : []).map((path) => [
      path,
      { source: path, readonly: false },
    ]),
  );
  const codex = join(home, ".codex");
  if (options["mount-codex-auth"]) {
    if (!directory(codex)) throw new Error(`Missing Codex directory: ${codex}`);
    if (lstatSync(codex).isSymbolicLink())
      throw new Error(
        `Codex directory cannot be a symlink in this initial version: ${codex}`,
      );
    if (
      [...mounts.keys()].some(
        (path) => hostInside(codex, path) || hostInside(path, codex),
      )
    )
      throw new Error(
        "Git sharing cannot also expose the host Codex directory",
      );
    const auth = join(codex, CODEX_AUTH_FILE);
    if (!lstatSync(auth, { throwIfNoEntry: false })?.isFile())
      throw new Error(
        `Codex ${CODEX_AUTH_FILE} must be an existing regular file: ${auth}. Sign in on the host with file-backed credentials first.`,
      );
    mounts.set(auth, { source: auth, readonly: true });
  }
  const skills = join(home, ".agents", "skills");
  let skillRoots: string[] = [];
  if (options["mount-skills"]) {
    if (!existsSync(skills))
      throw new Error(`Missing agent skills directory: ${skills}`);
    skillRoots = withSymlinkTargets([skills], home);
    for (const path of skillRoots)
      mounts.set(path, { source: path, readonly: true });
  }
  if (
    options["mount-codex-auth"] &&
    skillRoots.some((root) => hostInside(codex, root))
  )
    throw new Error(
      "The host Codex directory cannot also be a shared skill root",
    );
  const plan = new Map<string, Mount>();
  for (const [path, mount] of [...mounts.entries()].sort(
    ([a], [b]) => a.length - b.length,
  )) {
    if (hostInside(home, path) || hostInside(hostHome, path))
      throw new Error(`Refusing to expose host home: ${path}`);
    const inherited = [...plan.entries()]
      .filter(([parent]) => inside(path, parent))
      .at(-1)?.[1].readonly;
    mount.readonly ||= inherited === true;
    if (inherited !== mount.readonly) plan.set(path, mount);
  }
  for (const spec of options.volume ?? []) {
    const { target, readonly, source: requested } = directoryMount(spec);
    if (!directory(requested))
      throw new Error(
        `Mount source must be an existing directory: ${requested}`,
      );
    const source = realpathSync(requested);
    if (hostInside(home, source) || hostInside(hostHome, source))
      throw new Error(`Refusing to expose host home: ${source}`);
    if (
      options["mount-codex-auth"] &&
      (hostInside(codex, source) || hostInside(source, codex))
    )
      throw new Error(
        "Directory mounts cannot expose host Codex state with --mount-codex-auth",
      );
    if (
      !readonly &&
      skillRoots.some(
        (root) => hostInside(source, root) || hostInside(root, source),
      )
    )
      throw new Error(
        "A writable directory mount cannot also expose read-only shared skills",
      );
    const reserved = [
      "/proc",
      "/sys",
      "/dev",
      "/run",
      "/var/run",
      CODEX_SQLITE_HOME,
      "/tmp/agent-hc.sock",
    ];
    if (
      inside(home, target) ||
      reserved.some((path) => inside(target, path) || inside(path, target)) ||
      (options["mount-codex-auth"] &&
        (inside(target, codex) || inside(codex, target)))
    )
      throw new Error(
        `Mount target overlaps a reserved guest runtime path: ${target}`,
      );
    if (
      [...plan.keys()].some(
        (path) => inside(target, path) || inside(path, target),
      )
    )
      throw new Error(`Mount target overlaps another volume: ${target}`);
    plan.set(target, { source, readonly });
  }
  return new Map([...plan].sort(([a], [b]) => a.localeCompare(b)));
}

export function checkoutRoot(path: string): string {
  let current = realpathSync(path);
  if (!directory(current))
    throw new Error(`--mount-git requires a directory: ${path}`);
  while (true) {
    if (lstatSync(join(current, ".git"), { throwIfNoEntry: false }))
      return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`No Git checkout found at ${path}`);
    current = parent;
  }
}
function executable(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return resolve(path);
    } catch {}
  }
  throw new Error(`Required host command not found: ${name}`);
}
export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function requireName(name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(name))
    throw new Error(
      "--name is required; use 1-50 lowercase letters, digits, hyphens or underscores",
    );
  return name;
}
export type Options = {
  "mount-git"?: string;
  "git-name"?: string;
  "git-email"?: string;
  home?: string;
  name?: string;
  image?: string;
  cpus?: string;
  memory?: string;
  dns?: string;
  agent?: Agent;
  herdr: boolean;
  engine?: string;
  profile?: string;
  prompt?: string;
  volume?: string[];
  "mount-codex-auth"?: boolean;
  "mount-skills"?: boolean;
  detach?: boolean;
  json?: boolean;
  rm?: boolean;
  terminal?: string;
  "hc-session"?: string;
  "herdr-space"?: string;
  "herdr-tab"?: string;
};

type Labels = Record<string, string>;

function hostHC(labels: Labels, args: string[]): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HC_SESSION: labels[CORE_LABEL] || "default",
  };
  // An explicit core session must not be overridden by an inherited socket.
  delete env.HC_SOCKET;
  if (labels[CORE_SOCKET_LABEL]) env.HC_SOCKET = labels[CORE_SOCKET_LABEL];
  return execFileSync("hc", args, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
    env,
  });
}

function registerSandbox(name: string, labels: Labels): void {
  if (labels[HERDR_LABEL] !== "true") return;
  executable("hc");
  const machines = JSON.parse(hostHC(labels, ["machine", "ls", "--json"]));
  const via = labels[VIA_LABEL] || hcTransport(name);
  const existing = machines.machines.find(
    (machine: { name: string }) => machine.name === name,
  );
  if (existing) {
    if (sameTransport(existing, via)) return;
    throw new Error(
      `hc machine name already exists with another transport: ${name}`,
    );
  }
  hostHC(labels, ["machine", "add", "--name", name, "--via", via]);
}

function hcTransport(
  name: string,
  container = executable("container"),
): string {
  return [container, "exec", "-i", name, "sh", "-c"].map(quote).join(" ");
}

function sameTransport(
  machine: { via?: boolean; target?: string },
  via: string,
): boolean {
  return machine.via === true && machine.target === via;
}

function gitIdentityEnvironment(
  checkout: string | undefined,
  options: Options,
): string[] {
  const values: string[] = [];
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
  ])
    delete env[key];
  let unavailable = false;
  for (const role of ["AUTHOR", "COMMITTER"]) {
    let name = options["git-name"],
      email = options["git-email"];
    if (checkout && (name === undefined || email === undefined)) {
      if (name !== undefined) env[`GIT_${role}_NAME`] = name;
      if (email !== undefined) env[`GIT_${role}_EMAIL`] = email;
      try {
        const identity = execFileSync(
          "git",
          [
            "-C",
            checkout,
            "-c",
            "user.useConfigOnly=true",
            "var",
            `GIT_${role}_IDENT`,
          ],
          {
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          },
        ).trimEnd();
        const match = identity.match(/^(.*) <([^<>]*)> -?\d+ [+-]\d{4}$/);
        if (!match)
          throw new Error(
            `Unexpected host Git ${role.toLowerCase()} identity format`,
          );
        name ??= match[1];
        email ??= match[2];
      } catch (error) {
        if ((error as { status?: number }).status !== 128) throw error;
        unavailable = true;
      }
    }
    if (name !== undefined) values.push(`GIT_${role}_NAME=${name}`);
    if (email !== undefined) values.push(`GIT_${role}_EMAIL=${email}`);
  }
  if (unavailable)
    console.error(
      "Host Git identity is unavailable; configure it on the host or use --git-name and --git-email.",
    );
  return values;
}

function sandboxInfo(name: string) {
  requireName(name);
  const info = JSON.parse(run("container", ["inspect", name]))[0];
  const labels: Labels = info.configuration.labels ?? {};
  if (labels[LABEL] !== "true" && labels[LEGACY_LABEL] !== "true")
    throw new Error(`Guest is not owned by this launcher: ${name}`);
  return { info, labels };
}

function appTarget(
  name: string,
  options: Options,
): { space: string; tab: string } {
  const prefix = name + "/";
  if (!options["herdr-space"]?.startsWith(prefix))
    throw new Error(
      `Herdr spaces are scoped to a machine; choose a space belonging to ${name}. Use --hc-session at creation to choose the host core.`,
    );
  const spaces = JSON.parse(run("herdr-app", ["ls"])).spaces;
  const space = spaces.find(
    (space: { id: string }) => space.id === options["herdr-space"],
  );
  if (!space)
    throw new Error(`Herdr space not found: ${options["herdr-space"]}`);
  const tab = options["herdr-tab"];
  if (
    tab &&
    (!tab.startsWith(prefix) ||
      !space.tabs.some((item: { id: string }) => item.id === tab))
  )
    throw new Error(`Herdr tab is not in that space: ${tab}`);
  // The app prefixes guest labels with the registered machine name itself.
  return {
    space: space.id.slice(prefix.length),
    tab: tab?.slice(prefix.length) ?? "",
  };
}

export function createSandbox(options: Options): string {
  const name = requireName(options.name ?? "");
  if (options.herdr && name.length > 32)
    throw new Error("--herdr requires a sandbox name of at most 32 characters");
  const checkout =
    options["mount-git"] !== undefined
      ? checkoutRoot(resolve(options["mount-git"]))
      : undefined;
  const workdir = checkout ?? "/workspace";
  const home = realpathSync(options.home ?? homedir());
  const mounts = mountPlan(checkout, home, options);
  const identity = gitIdentityEnvironment(checkout, options);
  const codex = join(home, ".codex");
  const sharedCodex = options["mount-codex-auth"];
  const container = executable("container");
  const labels: Labels = {
    [LABEL]: "true",
    [HERDR_LABEL]: String(options.herdr),
    [CHECKOUT_LABEL]: workdir,
    [CORE_LABEL]: options["hc-session"] ?? process.env.HC_SESSION ?? "default",
    [CORE_SOCKET_LABEL]: options["hc-session"]
      ? ""
      : (process.env.HC_SOCKET ?? ""),
    [VIA_LABEL]: hcTransport(name, container),
    [SPACE_LABEL]: options.herdr ? `sp${randomUUID().slice(0, 8)}` : "",
    [TAB_LABEL]: "",
  };
  // Only selected subdirectories are mounted; this home path itself is guest-local.
  const guestHome = home;
  const args = [
    "run",
    "--detach",
    "--name",
    name,
    "--cpus",
    options.cpus ?? "4",
    "--memory",
    options.memory ?? "4G",
    "--workdir",
    checkout ?? "/",
    "--env",
    `HOME=${guestHome}`,
    "--env",
    "AGENT_BROWSER_SOCKET_DIR=/tmp/agent-browser",
    "--env",
    "HC_SOCKET=/tmp/agent-hc.sock",
    "--env",
    `CODEX_SQLITE_HOME=${CODEX_SQLITE_HOME}`,
    "--dns",
    options.dns ?? DEFAULT_DNS,
  ];
  for (const [key, value] of Object.entries(labels))
    args.push("--label", `${key}=${value}`);
  if (options.rm) args.push("--rm");
  args.push("--env", `CODEX_HOME=${codex}`);
  for (const value of identity) args.push("--env", value);
  console.error(`Starting ${name}; host mounts:`);
  for (const [target, { source, readonly }] of mounts) {
    if (/[:,\n]/.test(source) || /[:,\n]/.test(target))
      throw new Error(`Unsupported mount path delimiter: ${source}`);
    args.push("--volume", `${source}:${target}${readonly ? ":ro" : ""}`);
    console.error(`  ${readonly ? "ro" : "rw"} ${source} -> ${target}`);
  }
  if (sharedCodex) {
    console.error(
      "  Codex auth is read-only: refresh/login cannot save credentials. If auth fails, renew host login and restart a persistent sandbox. With --rm, export work and save a verified handoff before stopping, then recreate it: stopping deletes guest files. Or use a sandbox without --mount-codex-auth for guest-local login. See README authentication limitations.",
    );
  }
  run(container, [
    ...args,
    options.image ?? `agent-sandbox:${options.agent ?? "base"}`,
  ]);
  try {
    run(container, [
      "exec",
      name,
      "mkdir",
      "-p",
      guestHome,
      workdir,
      CODEX_SQLITE_HOME,
    ]);
    if (options.agent === "codex" || sharedCodex)
      run(container, ["exec", name, "mkdir", "-p", codex]);
    if (checkout)
      run(container, [
        "exec",
        name,
        "git",
        "config",
        "--global",
        "--add",
        "safe.directory",
        checkout,
      ]);
    registerSandbox(name, labels);
  } catch (error) {
    // Registration is the last operation; a failed add must not remove an existing machine.
    run(container, ["delete", "--force", name]);
    throw error;
  }
  return name;
}

export function stop(name: string, remove = false): void {
  const { labels } = sandboxInfo(name);
  try {
    if (labels[HERDR_LABEL] === "true" || labels[LEGACY_LABEL] === "true") {
      const machines = JSON.parse(hostHC(labels, ["machine", "ls", "--json"]));
      const machine = machines.machines.find(
        (machine: { name: string }) => machine.name === name,
      );
      if (machine) {
        const via = labels[VIA_LABEL] || hcTransport(name);
        if (!sameTransport(machine, via))
          throw new Error(
            `Refusing to remove a different hc transport: ${name}`,
          );
        hostHC(labels, ["machine", "rm", name]);
      }
    }
  } finally {
    run("container", remove ? ["delete", "--force", name] : ["stop", name]);
  }
}

export function prepareBuild(stdout: 1 | 2 = 1): string {
  execFileSync("node", [join(ROOT, "scripts", "check-locks.ts")], {
    stdio: ["inherit", stdout, 2],
  });
  return buildOS(stdout);
}

export function buildImage(
  options: Pick<Options, "engine" | "profile" | "image" | "dns">,
  osArchive: string,
  stdout: 1 | 2 = 1,
): void {
  const engine = options.engine ?? "container";
  const variant = options.profile ?? "base";
  if (!(PROFILES as readonly string[]).includes(variant))
    throw new Error("Use --profile base|codex|opencode|claude");
  const args = [
    "build",
    "--build-arg",
    `OS_ARCHIVE=${osArchive}`,
    "--pull",
    "--tag",
    options.image ?? `agent-sandbox:${variant}`,
    "--target",
    variant,
  ];
  for (const name of [
    "MISE_BASE",
    "BROWSER_SHA256_ARM64",
    "BROWSER_SHA256_AMD64",
    "PNPM_VERSION",
    "BROWSER_VERSION",
    "CODEX_VERSION",
    "OPENCODE_VERSION",
    "CLAUDE_VERSION",
    "AGENT_BROWSER_VERSION",
    "HC_VERSION",
  ]) {
    const value = process.env[`IMAGE_${name}`];
    if (!value) throw new Error(`Missing IMAGE_${name}; run through mise`);
    args.push("--build-arg", `${name}=${value}`);
  }
  if (engine === "container") args.push("--dns", options.dns ?? DEFAULT_DNS);
  else if (options.dns)
    throw new Error("Build --dns is supported only by Apple's runtime");
  execFileSync(engine, [...args, ROOT], { stdio: ["inherit", stdout, 2] });
}

export function scanImage(engine: string, image: string, json = false): string {
  const artifacts = join(ROOT, ".artifacts");
  mkdirSync(artifacts, { recursive: true });
  const report = join(
    artifacts,
    `vulnerabilities-${engine}-${image.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`,
  );
  let temp: string | undefined;
  try {
    scanWithTrivy(
      "image",
      () => {
        if (engine === "container") {
          // Apple exports an OCI tar; Trivy expects an unpacked OCI layout.
          temp = mkdtempSync(join(tmpdir(), "codex-image-"));
          const archive = join(temp, "image.tar");
          run(engine, ["image", "save", "--output", archive, image]);
          const input = join(temp, "oci");
          mkdirSync(input);
          run("tar", ["-xf", archive, "-C", input]);
          rmSync(archive);
          return ["--input", input];
        } else {
          const endpoint = process.env.DOCKER_CONTEXT
            ? run("docker", [
                "context",
                "inspect",
                "--format",
                "{{.Endpoints.docker.Host}}",
              ]).trim()
            : process.env.DOCKER_HOST ||
              run("docker", [
                "context",
                "inspect",
                "--format",
                "{{.Endpoints.docker.Host}}",
              ]).trim();
          const identity = run("docker", [
            "image",
            "inspect",
            "--format",
            "{{.Id}} {{.Os}}/{{.Architecture}}",
            image,
          ]).trim();
          const [id, platform] = identity.split(/\s+/);
          if (!id || !platform)
            throw new Error("Docker returned no image identity/platform");
          (json ? console.error : console.log)(
            `Scanning Docker image ${id} (${platform})`,
          );
          return ["--image-src", "docker", "--docker-host", endpoint, id];
        }
      },
      report,
      json ? 2 : 1,
    );
    return report;
  } finally {
    if (temp) rmSync(temp, { recursive: true });
  }
}

async function foreground(
  command: string,
  argv: string[],
  json = false,
): Promise<number> {
  return await new Promise((done, reject) => {
    const child = spawn(command, argv, {
      stdio: json ? ["inherit", 2, 2] : "inherit",
    });
    const interrupt = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    child.once("error", reject);
    child.once("close", (code) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      done(code ?? 1);
    });
  });
}

async function workload(
  name: string,
  argv: string[],
  options: Options,
  custom: boolean,
): Promise<{ exitCode: number; terminal?: string }> {
  const { labels } = sandboxInfo(name);
  const checkout = labels[CHECKOUT_LABEL] ?? "/";
  if (options["herdr-space"]) {
    if (labels[HERDR_LABEL] !== "true")
      throw new Error("This sandbox was created without --herdr");
    const target = appTarget(name, options);
    labels[SPACE_LABEL] = target.space;
    labels[TAB_LABEL] = target.tab;
  }
  if (directWorkload(custom, options)) {
    const exitCode = await foreground(
      "container",
      [
        "exec",
        process.stdin.isTTY && process.stdout.isTTY ? "-it" : "-i",
        "--workdir",
        checkout,
        name,
        ...argv,
      ],
      options.json,
    );
    return { exitCode };
  }
  const terminal =
    options.terminal ??
    (options.agent ?? "shell") + "-" + randomUUID().slice(0, 8);
  const args = [
    "run",
    "--bg",
    "--name",
    terminal,
    "--cwd",
    checkout,
    "--outlive-parent",
  ];
  const herdr = labels[HERDR_LABEL] === "true";
  const sameCore =
    herdr &&
    process.env.HC_TERMINAL_ID &&
    JSON.parse(hostHC(labels, ["server", "status"])).core.id ===
      JSON.parse(run("hc", ["server", "status"])).core.id;
  if (!sameCore) args.push("--no-parent");
  if (herdr) {
    args.push("--label", "herdr.space=" + labels[SPACE_LABEL]);
    args.push(
      "--label",
      "herdr.tab=" + (labels[TAB_LABEL] || "tb" + randomUUID().slice(0, 8)),
    );
  }
  // hc treats one whitespace-containing argument as shell text, even after --.
  const managedArgv = custom
    ? ["sh", "-c", 'exec "$@"', "agent-sandbox", ...argv]
    : argv;
  const created = JSON.parse(
    herdr
      ? hostHC(labels, [...args, "--on", name, "--", ...managedArgv])
      : run("container", ["exec", name, "hc", ...args, "--", ...managedArgv]),
  );
  const terminalID = herdr
    ? created.address.slice(name.length + 1)
    : created.address;
  console.error(
    "Terminal: " +
      terminalID +
      "; attach with: agent-sandbox attach --name " +
      name +
      " --terminal " +
      terminalID,
  );
  if (options.detach) {
    if (!options.json) console.log(terminalID);
    return { exitCode: 0, terminal: terminalID };
  }
  const code = await foreground("container", [
    "exec",
    "-it",
    name,
    "hc",
    "attach",
    terminalID,
  ]);
  const result = JSON.parse(
    run("container", ["exec", name, "hc", "get", "--json", terminalID]),
  );
  return {
    exitCode: result.finished_ms !== null ? (result.exit_code ?? 1) : code,
    terminal: terminalID,
  };
}

function directWorkload(custom: boolean, options: Options): boolean {
  return custom && !options.detach && !options["herdr-space"];
}

const STRING_OPTIONS = [
  "engine",
  "image",
  "mount-git",
  "git-name",
  "git-email",
  "home",
  "name",
  "cpus",
  "memory",
  "dns",
  "profile",
  "agent",
  "prompt",
  "terminal",
  "hc-session",
  "herdr-space",
  "herdr-tab",
];

// Preserve literal --json inside prompts, string values and --exec arguments,
// including when parsing fails before an invocation can be returned.
function jsonRequested(input: string[]): boolean {
  for (let index = 0; index < input.length; index++) {
    const arg = input[index];
    if (arg === "--exec") break;
    if (arg === "--json") return true;
    if (arg === "--mount-git") {
      if (input[index + 1] && !input[index + 1].startsWith("-")) index++;
    } else if (
      arg === "-v" ||
      arg === "--volume" ||
      STRING_OPTIONS.some((name) => arg === `--${name}`)
    )
      index++;
  }
  return false;
}

function jsonResult(
  command: string,
  data: unknown,
  exitCode = 0,
  error?: string,
): void {
  console.log(
    JSON.stringify({
      command,
      ok: exitCode === 0,
      exit_code: exitCode,
      data,
      ...(error ? { error: { message: error } } : {}),
    }),
  );
}

export function parseInvocation(input: string[]) {
  let args = [...input];
  let command = args.length ? "" : "help";
  if (
    [
      "build",
      "scan",
      "run",
      "start",
      "stop",
      "delete",
      "shell",
      "attach",
      "terminals",
      "status",
    ].includes(args[0])
  )
    command = args.shift()!;
  if (args[0] === "exec")
    throw new Error("Use --exec COMMAND ARG... instead of an exec subcommand");
  let name: string | undefined;
  let custom: string[] | undefined;
  const flags: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--exec") {
      custom = args.slice(index + 1);
      if (!custom.length) throw new Error("--exec requires a command");
      break;
    }
    if (args[index] === "--prompt") {
      if (args[index + 1] === undefined)
        throw new Error("--prompt requires text");
      flags.push(`--prompt=${args[++index]}`);
    } else if (args[index] === "--mount-git") {
      const path = args[index + 1];
      flags.push(
        `--mount-git=${path && !path.startsWith("-") ? args[++index] : "."}`,
      );
    } else flags.push(args[index]);
  }
  args = flags;
  const { values } = parseArgs({
    args,
    options: {
      ...Object.fromEntries(
        STRING_OPTIONS.map((name) => [name, { type: "string" as const }]),
      ),
      herdr: { type: "boolean", default: false },
      volume: { type: "string", short: "v", multiple: true, default: [] },
      "mount-codex-auth": { type: "boolean", default: false },
      "mount-skills": { type: "boolean", default: false },
      detach: { type: "boolean", short: "d", default: false },
      json: { type: "boolean", default: false },
      rm: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
      skill: { type: "boolean" },
      version: { type: "boolean", short: "V" },
    },
  });
  if (values.help) command = "help";
  if (values.skill) command = "skill";
  if (values.version) command = "version";
  const options = values as Options;
  if (options["mount-git"] === "")
    throw new Error("--mount-git requires a nonempty path");
  if (!command) throw new Error("Choose a command; run agent-sandbox --help");
  if (
    ["run", "start", "stop", "delete", "shell", "attach", "terminals"].includes(
      command,
    )
  )
    name = requireName(options.name ?? "");
  if (options.terminal && !/^[a-z0-9_-]{1,32}$/.test(options.terminal))
    throw new Error(
      "--terminal must be an ID or name of 1-32 lowercase letters, digits, hyphens or underscores",
    );
  if (command === "attach" && !options.terminal)
    throw new Error(
      "attach requires --terminal; use terminals --name NAME to discover terminals",
    );
  if (
    options["hc-session"] &&
    !/^[a-zA-Z0-9_-]{1,32}$/.test(options["hc-session"])
  )
    throw new Error("Invalid --hc-session name");
  if (options["herdr-tab"] && !options["herdr-space"])
    throw new Error("--herdr-tab requires --herdr-space");
  if (options["herdr-space"] || options["hc-session"]) options.herdr = true;
  if (options["herdr-space"] && command !== "shell")
    throw new Error(
      "--herdr-space selects a terminal's space with shell; a new sandbox gets its own machine-scoped space",
    );
  for (const key of ["git-name", "git-email"] as const) {
    const value = options[key];
    if (value !== undefined && (!value.trim() || /[\0\r\n]/.test(value)))
      throw new Error(
        "Git identity values must be nonempty single-line strings",
      );
  }
  if (
    (options["git-name"] !== undefined || options["git-email"] !== undefined) &&
    !["run", "help", "skill", "version"].includes(command)
  )
    throw new Error("Git identity settings are chosen at creation with run");
  if (
    command !== "run" &&
    (options.volume?.length ||
      options["mount-codex-auth"] ||
      options["mount-skills"] ||
      options.home ||
      options["mount-git"] !== undefined ||
      options.image ||
      options.cpus ||
      options.memory ||
      options.rm ||
      options["hc-session"] ||
      (options.herdr && !options["herdr-space"])) &&
    !["build", "scan", "help", "skill", "version"].includes(command)
  )
    throw new Error(
      "Image, resource, mount, --rm and Herdr settings are chosen at creation with run",
    );
  if (
    options.detach &&
    !["run", "start", "shell", "help", "skill", "version"].includes(command)
  )
    throw new Error("--detach is supported by run, start and shell");
  for (const mount of options.volume ?? []) directoryMount(mount);
  if (options.agent && !["codex", "opencode", "claude"].includes(options.agent))
    throw new Error(`Unknown agent: ${options.agent}`);
  if (options.prompt !== undefined && !options.agent)
    throw new Error("--prompt requires --agent");
  if (options.prompt !== undefined && custom)
    throw new Error("--prompt cannot combine with --exec");
  if (options.json && command === "attach")
    throw new Error(
      "--json cannot attach interactively; use terminals --json to discover terminals",
    );
  if (
    options.json &&
    ["run", "start", "shell"].includes(command) &&
    !options.detach &&
    !directWorkload(!!custom, options)
  )
    throw new Error(
      "--json managed launches require --detach; use --exec for a foreground command",
    );
  if (options.engine && !["container", "docker"].includes(options.engine))
    throw new Error("Engine must be container or docker");
  if (options.engine === "docker" && !["build", "scan"].includes(command))
    throw new Error("Guest launches use Apple's container runtime");
  if (!["run", "start", "shell"].includes(command) && custom)
    throw new Error("--exec is only supported when launching a workload");
  let argv = custom ?? ["bash"];
  if (!custom && options.agent) {
    argv =
      options.agent === "codex"
        ? [
            "codex",
            "--no-daemon",
            "--dangerously-bypass-approvals-and-sandbox",
            "-c",
            'cli_auth_credentials_store="file"',
            "-c",
            `sqlite_home="${CODEX_SQLITE_HOME}"`,
            "-c",
            "check_for_update_on_startup=false",
          ]
        : options.agent === "opencode"
          ? ["opencode", "--standalone"]
          : ["claude"];
    if (options.prompt !== undefined)
      argv.push(
        ...(options.agent === "opencode"
          ? [`--prompt=${options.prompt}`]
          : ["--", options.prompt]),
      );
  }
  return { command, options, argv, name, custom: custom !== undefined };
}

async function main(): Promise<void> {
  const input = process.argv.slice(2);
  let command = input[0]?.startsWith("-") ? "unknown" : (input[0] ?? "help");
  try {
    const {
      command: selectedCommand,
      options,
      argv,
      name: existing,
      custom,
    } = parseInvocation(input);
    command = selectedCommand;
    const respond = (data: unknown, exitCode = 0) => {
      process.exitCode = exitCode;
      if (options.json) jsonResult(command, data, exitCode);
    };
    if (command === "version") {
      const { name, version } = JSON.parse(
        readFileSync(join(ROOT, "package.json"), "utf8"),
      );
      if (!options.json) console.log(`${name} ${version}`);
      respond({ name, version });
      return;
    }
    if (command === "skill") {
      const text = readFileSync(
        join(ROOT, "skills", "agent-sandbox", "SKILL.md"),
        "utf8",
      );
      if (!options.json) process.stdout.write(text);
      respond({ text });
      return;
    }
    if (command === "help") {
      const text = `Usage: agent-sandbox COMMAND [options] [--exec COMMAND ARG...]
run --name NAME                Create a persistent sandbox and open its shell/agent
start --name NAME              Restart a stopped sandbox and open a new shell/agent
shell --name NAME              Open another shell/agent in a running sandbox
attach --name NAME --terminal ID   Reconnect to an existing terminal
terminals --name NAME          Discover terminal IDs and names
stop --name NAME               Stop the VM; retain its filesystem (unless --rm)
delete --name NAME             Destroy the sandbox and unregister it
status                        List managed sandboxes, including stopped ones
build / scan                  Build or scan images
  --agent codex|opencode|claude    Select initial image (run) and program
  --prompt TEXT                  Interactive initial prompt; requires --agent
  -d, --detach                   Return immediately without attaching (opt-in)
  --json                         One JSON result on stdout; progress/workload output on stderr
  --skill                        Agent guidance and recommended workflows
  -V, --version                  Print the installed CLI version
  --rm                           Remove when the sandbox stops; chosen with run
  --herdr                        Register with host hc and show terminals in Herdr
  --hc-session NAME              Select host core session (implies --herdr)
  --herdr-space ID [--herdr-tab ID]   With shell: select a space/tab belonging to this sandbox
  --terminal ID_OR_NAME           Name a new terminal or select one to attach
  --exec COMMAND ARG...          Literal custom command; consumes remaining arguments
  --mount-git [PATH]              Share a checkout and Git metadata; start at its root (default: current checkout)
  --git-name NAME --git-email EMAIL   Override author/committer identity resolved from the host checkout
  --mount-codex-auth              Mount only host Codex auth.json read-only
  --mount-skills                  Share host agent skills read-only
  -v, --volume SOURCE:TARGET:ro|rw  Share a directory at an absolute guest path (repeatable)
Creation: --home PATH --image TAG --dns IP --cpus N --memory 4G
Without --mount-git, workloads start in /workspace; --volume does not select the working directory.
By default /workspace is guest-local; a directory mounted there becomes the starting location.
Build/scan: --engine container|docker --profile base|codex|opencode|claude
Foreground is the default. For hc supervision, launch directly from its host terminal with --detach --prompt.
Exiting or detaching any terminal leaves its sandbox running. Bare invocation prints help.
Agent? Run: agent-sandbox --skill
JSON managed launches require --detach; interactive attach is unavailable in JSON mode.
Launch options precede --exec. Use --exec sh -lc '...' for shell syntax.`;
      if (!options.json) console.log(text);
      respond({ text });
      return;
    }
    if (command === "status") {
      const sandboxes: { name: string; state: string }[] = [];
      for (const item of JSON.parse(
        run("container", ["ls", "--all", "--format", "json"]),
      ))
        if (
          item.configuration.labels?.[LABEL] === "true" ||
          item.configuration.labels?.[LEGACY_LABEL] === "true"
        ) {
          sandboxes.push({
            name: item.configuration.id,
            state: item.status.state,
          });
          if (!options.json)
            console.log(`${item.configuration.id}\t${item.status.state}`);
        }
      respond({ sandboxes });
      return;
    }
    if (command === "stop" || command === "delete") {
      stop(existing!, command === "delete");
      respond({ name: existing });
      return;
    }
    if (command === "terminals") {
      sandboxInfo(existing!);
      const text = run("container", [
        "exec",
        existing!,
        "hc",
        "ls",
        "--all",
        "--json",
      ]);
      if (!options.json) process.stdout.write(text);
      respond({ ...JSON.parse(text), name: existing });
      return;
    }
    if (command === "build") {
      const stdout = options.json ? 2 : 1;
      const archive = prepareBuild(stdout);
      buildImage(options, archive, stdout);
      respond({
        engine: options.engine ?? "container",
        profile: options.profile ?? "base",
        image: options.image ?? `agent-sandbox:${options.profile ?? "base"}`,
      });
      return;
    }
    if (command === "scan") {
      const engine = options.engine ?? "container";
      const image =
        options.image ??
        `agent-sandbox:${options.agent ?? options.profile ?? "base"}`;
      const report = scanImage(engine, image, options.json);
      respond({ engine, image, report });
      return;
    }
    if (
      !options.detach &&
      !directWorkload(custom, options) &&
      (!process.stdin.isTTY || !process.stdout.isTTY)
    )
      throw new Error(
        "Interactive terminals require a TTY; use --detach or --exec for scripts and pipes",
      );
    if (command === "attach") {
      sandboxInfo(existing!);
      process.exitCode = await foreground("container", [
        "exec",
        "-it",
        existing!,
        "hc",
        "attach",
        options.terminal!,
      ]);
      return;
    }
    let name = existing!;
    if (command === "run") {
      name = createSandbox(options);
    } else if (command === "start") {
      const { labels } = sandboxInfo(name);
      run("container", ["start", name]);
      registerSandbox(name, labels);
    }
    const result = await workload(name, argv, options, custom);
    respond(
      {
        name,
        detached: !!options.detach,
        ...(result.terminal
          ? { terminal: result.terminal, address: `${name}/${result.terminal}` }
          : {}),
      },
      result.exitCode,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = error as {
      exitCode?: number;
      status?: number;
      code?: string;
    };
    const exitCode =
      failure.exitCode ??
      failure.status ??
      (failure.code === "ENOENT" ? 127 : failure.code === "EACCES" ? 126 : 1);
    if (jsonRequested(input)) {
      const data =
        error && typeof error === "object" && "report" in error
          ? { report: error.report }
          : null;
      jsonResult(command, data, exitCode, message);
    } else console.error(message);
    process.exitCode = exitCode;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
