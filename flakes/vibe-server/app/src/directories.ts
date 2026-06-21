// Runtime-managed project directories. The config-defined `directories` are
// immutable; the web UI can additionally create/register directories under
// `projectsDir` (persisted to stateDir/directories.json). A newly-created
// project is scaffolded from `newProjectTemplate` (the vibe-shell template) and
// `git init`-ed so its flake is usable. ZERO external imports.

import type { DirConfig, ServerConfig } from "./config.ts";
import { basenameOf, isError, isValidName, log, normalizeAbs, sanitizeName, uniqueName, withinRoot } from "./util.ts";

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
  return config.browseRoot !== null && config.browseRoot.trim() !== "";
}

function browseRootOf(config: ServerConfig): string {
  return normalizeAbs((config.browseRoot ?? "/").trim() || "/");
}

// realpath a path, falling back to its normalized form if it can't be resolved
// (e.g. it doesn't exist) — callers re-check the bound afterwards.
async function realOrNorm(p: string): Promise<string> {
  try {
    return await Deno.realPath(p);
  } catch {
    return normalizeAbs(p);
  }
}

export interface BrowseEntry {
  name: string;
  path: string;
  registered: boolean;
}

export interface BrowseResult {
  root: string;
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
  error?: string;
}

// Parent of `p` within `root` (null at the root itself / when out of bounds).
function parentWithin(root: string, p: string): string | null {
  if (p === root || !withinRoot(root, p)) return null;
  const parent = normalizeAbs(p.slice(0, p.lastIndexOf("/")) || "/");
  return withinRoot(root, parent) ? parent : root;
}

// List the subdirectories of `reqPath` (default: the browse root), bounded to
// browseRoot. Symlinks are resolved with realPath and re-bounded so a link inside
// the root can't escape it. Read-only; never throws (errors surface in `.error`).
export async function browse(config: ServerConfig, reqPath?: string): Promise<BrowseResult> {
  const root = await realOrNorm(browseRootOf(config));
  let target = reqPath && reqPath.startsWith("/") ? normalizeAbs(reqPath) : root;
  if (!withinRoot(root, target)) target = root; // cheap string bound before hitting the FS
  target = await realOrNorm(target);
  if (!withinRoot(root, target)) target = root; // symlink escape → clamp to root

  const registered = new Set(listDirectories(config).map((d) => d.path));
  const entries: BrowseEntry[] = [];
  try {
    for await (const e of Deno.readDir(target)) {
      if (!e.isDirectory && !e.isSymlink) continue;
      const full = target === "/" ? `/${e.name}` : `${target}/${e.name}`;
      if (e.isSymlink) {
        try {
          if (!(await Deno.stat(full)).isDirectory) continue;
        } catch {
          continue; // dangling / unreadable symlink
        }
      }
      entries.push({ name: e.name, path: full, registered: registered.has(full) });
    }
  } catch {
    return { root, path: target, parent: parentWithin(root, target), entries: [], error: "cannot read directory" };
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { root, path: target, parent: parentWithin(root, target), entries };
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

// Add a directory the user picked in the file browser. The chosen folder (`path`)
// must be inside browseRoot. With a `name`, create `<path>/<name>` (scaffolded
// from the template + git-init, if it doesn't exist already) and register it.
// Without a name, register the chosen folder itself (label = its sanitized
// basename, de-duplicated). Persists and returns the registered directory.
export async function addDirectory(
  config: ServerConfig,
  opts: { path: string; name?: string },
): Promise<DirConfig> {
  if (!canManageDirectories(config)) throw new Error("directory management disabled");
  const root = await realOrNorm(browseRootOf(config));
  if (!opts.path.startsWith("/") || !withinRoot(root, normalizeAbs(opts.path))) {
    throw new Error("location is outside the browse root");
  }
  let base: string;
  try {
    base = await Deno.realPath(opts.path);
  } catch {
    throw new Error("location does not exist");
  }
  if (!withinRoot(root, base)) throw new Error("location is outside the browse root");
  if (!(await isDir(base))) throw new Error("location is not a directory");

  const taken = new Set<string>([
    ...config.directories.map((d) => d.name),
    ...[...userDirs.values()].map((d) => d.name),
  ]);

  let dir: DirConfig;
  if (opts.name) {
    if (!isValidName(opts.name)) throw new Error("invalid name");
    if (taken.has(opts.name)) throw new Error("name already in use");
    let dest = `${base}/${opts.name}`;
    let created = false;
    if (!(await isDir(dest))) {
      if (config.newProjectTemplate) await scaffold(config.newProjectTemplate, dest);
      else await Deno.mkdir(dest, { recursive: true });
      created = true;
    }
    // Re-resolve and re-bound, mirroring the register branch: isDir() follows
    // symlinks, so a pre-existing symlink at <base>/<name> pointing outside
    // browseRoot would otherwise be registered (and later run a session) out of
    // bounds. realPath collapses it; reject anything that escapes the root.
    dest = await Deno.realPath(dest);
    if (!withinRoot(root, dest)) throw new Error("location is outside the browse root");
    dir = { name: opts.name, path: dest };
    log("info", "directory created", { name: dir.name, path: dir.path, created });
  } else {
    const label = uniqueName(sanitizeName(basenameOf(base)), taken);
    dir = { name: label, path: base };
    log("info", "directory registered", { name: dir.name, path: dir.path });
  }
  userDirs.set(dir.name, dir);
  await persist(config.stateDir);
  return dir;
}

// Unregister a user-added directory. Does NOT delete files on disk.
export async function removeDirectory(config: ServerConfig, name: string): Promise<boolean> {
  if (!userDirs.has(name)) return false;
  userDirs.delete(name);
  await persist(config.stateDir);
  return true;
}
