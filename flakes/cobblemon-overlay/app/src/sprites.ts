// Offline sprite serving from the bundled pokesprite gen-8 box icons. ZERO
// external imports.
//
// The sprite dir holds <slug>.png files (e.g. bulbasaur.png, mr-mime.png) plus
// an optional pokemon.json (pokesprite's data file: dex-number keys → slug.eng)
// used for the dex-number fallback. Cobblemon species ids are mostly identity
// with pokesprite slugs (lowercase, strip the "cobblemon:" namespace); the
// remaining mismatches (punctuation like "mrmime" vs "mr-mime") are covered by
// a dash-less loose index, and anything still unmapped 404s cleanly — the
// overlay pages then fall back to text, never a broken card.
//
// SECURITY: the requested name is sanitized to [a-z0-9-] BEFORE any lookup and
// files are only ever resolved out of the whitelist built by init(), so path
// traversal ("../", encoded dots, absolute paths) cannot reach the filesystem.

import { isError, log } from "./util.ts";

// Reduce a species id to the pokesprite slug charset [a-z0-9-]: lowercase,
// strip any "namespace:" prefix, map whitespace/underscores to "-", drop every
// other character, collapse dash runs, trim edge dashes.
export function sanitizeSlug(species: string): string {
  let s = species.toLowerCase();
  const colon = s.lastIndexOf(":");
  if (colon >= 0) s = s.slice(colon + 1);
  return s
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function notFound(): Response {
  return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
}

export class SpriteStore {
  #dir: string;
  #slugs = new Set<string>(); // available <slug>.png basenames
  #loose = new Map<string, string>(); // dash-less slug → slug ("mrmime" → "mr-mime")
  #dexMap = new Map<number, string>(); // national dex → slug

  constructor(dir: string) {
    this.#dir = dir;
  }

  get dir(): string {
    return this.#dir;
  }

  get count(): number {
    return this.#slugs.size;
  }

  // Test seam: inject the lookup tables without touching the filesystem.
  static forTest(slugs: string[], dexMap: Map<number, string> = new Map()): SpriteStore {
    const s = new SpriteStore("");
    for (const slug of slugs) s.#addSlug(slug);
    s.#dexMap = dexMap;
    return s;
  }

  #addSlug(slug: string): void {
    this.#slugs.add(slug);
    const loose = slug.replaceAll("-", "");
    if (loose !== slug && !this.#loose.has(loose)) this.#loose.set(loose, slug);
  }

  async init(): Promise<void> {
    if (!this.#dir) {
      log("warn", "sprites disabled (no spriteDir) — overlay cards fall back to text");
      return;
    }
    try {
      for await (const entry of Deno.readDir(this.#dir)) {
        if (entry.isFile && entry.name.endsWith(".png")) {
          this.#addSlug(entry.name.slice(0, -".png".length));
        }
      }
    } catch (e) {
      log("error", "could not read spriteDir — sprites disabled", {
        dir: this.#dir,
        err: isError(e) ? e.message : String(e),
      });
      return;
    }
    // Optional dex→slug map (pokesprite's data/pokemon.json: {"001": {slug: {eng: "bulbasaur"}}}).
    try {
      const raw = JSON.parse(await Deno.readTextFile(`${this.#dir}/pokemon.json`));
      if (typeof raw === "object" && raw !== null) {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          const dex = Number.parseInt(key, 10);
          if (!Number.isFinite(dex) || dex <= 0) continue;
          const slug = (value as { slug?: { eng?: unknown } } | null)?.slug?.eng;
          if (typeof slug === "string" && slug) this.#dexMap.set(dex, slug);
        }
      }
    } catch {
      // no/dud pokemon.json — dex fallback simply finds nothing
    }
    log("info", "sprites loaded", { dir: this.#dir, count: this.#slugs.size, dexMapped: this.#dexMap.size });
  }

  // Resolve a species id (+ optional dex number fallback) to a whitelisted
  // "<slug>.png" filename, or null when unmapped.
  resolve(species: string, dex = 0): string | null {
    const slug = sanitizeSlug(species);
    if (slug) {
      if (this.#slugs.has(slug)) return `${slug}.png`;
      const loose = this.#loose.get(slug.replaceAll("-", ""));
      if (loose) return `${loose}.png`;
    }
    if (dex > 0) {
      const bySlug = this.#dexMap.get(dex);
      if (bySlug && this.#slugs.has(bySlug)) return `${bySlug}.png`;
    }
    return null;
  }

  // GET /sprites/<name>.png[?dex=N] — 404s cleanly on anything unmapped.
  async serve(rawName: string, dexParam: string | null): Promise<Response> {
    if (!this.#dir) return notFound();
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return notFound();
    }
    if (!name.toLowerCase().endsWith(".png")) return notFound();
    const dex = dexParam ? Number.parseInt(dexParam, 10) : 0;
    const file = this.resolve(name.slice(0, -".png".length), Number.isFinite(dex) && dex > 0 ? dex : 0);
    if (!file) return notFound();
    try {
      const data = await Deno.readFile(`${this.#dir}/${file}`);
      return new Response(data, {
        headers: {
          "content-type": "image/png",
          // Sprite URLs stay the same across package upgrades but the files
          // change (e.g. the build-time trim) — a day-long cache left OBS
          // showing stale art after a rebuild (hit live, 2026-07-19). Short
          // max-age keeps stream-night load trivial without pinning old files.
          "cache-control": "public, max-age=300",
        },
      });
    } catch {
      return notFound();
    }
  }
}
