// Runtime-managed project directories. The config-defined `directories` are
// immutable; the web UI can additionally create/register directories under
// `projectsDir` (persisted to stateDir/directories.json). A newly-created
// project is scaffolded from `newProjectTemplate` (the vibe-shell template) and
// `git init`-ed so its flake is usable. ZERO external imports.

import type { DirConfig, ServerConfig } from "./config.ts";
import { isError, isValidName, log } from "./util.ts";

const userDirs = new Map<string, DirConfig>();

function persistPath(stateDir: string): string {
  return `${stateDir}/directories.json`;
}

let writing: Promise<void> = Promise.resolve();
function persist(stateDir: string): Promise<void> {
  writing = writing.then(async () => {
    try {
      await Deno.writeTextFile(persistPath(stateDir), JSON.stringify([...userDirs.values()]));
    } catch (e) {
      log("warn", "directories persist failed", { err: isError(e) ? e.message : String(e) });
    }
  });
  return writing;
}

export async function loadUserDirs(stateDir: string): Promise<void> {
  let arr: unknown;
  try {
    arr = JSON.parse(await Deno.readTextFile(persistPath(stateDir)));
  } catch {
    return;
  }
  for (const item of Array.isArray(arr) ? arr : []) {
    const d = item as DirConfig;
    if (d && typeof d.name === "string" && typeof d.path === "string" && isValidName(d.name)) {
      userDirs.set(d.name, { name: d.name, path: d.path });
    }
  }
}

export interface ListedDir extends DirConfig {
  removable: boolean;
}

export function listDirectories(config: ServerConfig): ListedDir[] {
  const out: ListedDir[] = [];
  const seen = new Set<string>();
  for (const d of config.directories) {
    out.push({ name: d.name, path: d.path, removable: false });
    seen.add(d.name);
  }
  for (const d of userDirs.values()) {
    if (!seen.has(d.name)) out.push({ name: d.name, path: d.path, removable: true });
  }
  return out;
}

export function resolveDir(config: ServerConfig, name: string): DirConfig | undefined {
  return config.directories.find((d) => d.name === name) ?? userDirs.get(name);
}

export function canManageDirectories(config: ServerConfig): boolean {
  return config.projectsDir !== null && config.projectsDir !== "";
}

async function run(args: string[]): Promise<void> {
  const [bin, ...rest] = args;
  const { code, stderr } = await new Deno.Command(bin, { args: rest, stdout: "piped", stderr: "piped" }).output();
  if (code !== 0) throw new Error(`${bin}: ${new TextDecoder().decode(stderr).trim() || `exit ${code}`}`);
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

// Copy the template, make it writable (store paths are read-only), and turn it
// into a flake-visible git repo so `nix develop` / direnv work in the new project.
async function scaffold(template: string, dest: string): Promise<void> {
  await run(["cp", "-rT", template, dest]);
  await run(["chmod", "-R", "u+w", dest]);
  await run(["git", "init", "-q", dest]).catch(() => {});
  await run(["git", "-C", dest, "add", "-A"]).catch(() => {});
}

// Create (scaffolding from the template when missing) or register a directory
// under projectsDir, then persist it. Returns the registered directory.
export async function addDirectory(config: ServerConfig, name: string): Promise<DirConfig> {
  if (!isValidName(name)) throw new Error("invalid name");
  if (!canManageDirectories(config)) throw new Error("directory management disabled");
  if (config.directories.some((d) => d.name === name)) throw new Error("name already configured");
  const base = config.projectsDir as string;
  const path = `${base}/${name}`;
  await Deno.mkdir(base, { recursive: true });

  let created = false;
  if (!(await isDir(path))) {
    if (config.newProjectTemplate) {
      await scaffold(config.newProjectTemplate, path);
    } else {
      await Deno.mkdir(path, { recursive: true });
    }
    created = true;
  }

  const dir: DirConfig = { name, path };
  userDirs.set(name, dir);
  await persist(config.stateDir);
  log("info", "directory added", { name, path, created });
  return dir;
}

// Unregister a user-added directory. Does NOT delete files on disk.
export async function removeDirectory(config: ServerConfig, name: string): Promise<boolean> {
  if (!userDirs.has(name)) return false;
  userDirs.delete(name);
  await persist(config.stateDir);
  return true;
}
