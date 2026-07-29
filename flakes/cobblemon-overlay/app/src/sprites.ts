// Offline sprite serving from the bundled pokesprite gen-8 box icons. ZERO
// external imports.
//
// The sprite dir holds <slug>.png files (e.g. bulbasaur.png, mr-mime.png, and
// regional-form slugs like growlithe-hisui.png) plus a parallel shiny/<slug>.png
// set and an optional pokemon.json (pokesprite's data file: dex-number keys →
// slug.eng) used for the dex-number fallback. Cobblemon species ids are mostly
// identity with pokesprite slugs (lowercase, strip the "cobblemon:" namespace);
// the remaining mismatches (punctuation like "mrmime" vs "mr-mime") are covered
// by a dash-less loose index, and anything still unmapped 404s cleanly — the
// overlay pages then fall back to text, never a broken card.
//
// FORMS + SHINY: a Pokémon's Cobblemon aspects (["hisuian"], ["alolan"], …) pick
// a regional-form sprite (growlithe → growlithe-hisui) and the `shiny` flag picks
// the shiny/<slug>.png variant. Both degrade gracefully: an unknown form or a
// missing shiny sprite falls back to the plain box icon rather than 404ing.
//
// SECURITY: the requested name is sanitized to [a-z0-9-] BEFORE any lookup and
// files are only ever resolved out of the whitelists built by init() (the flat
// set or the shiny/ set — the only "/" ever emitted is the fixed "shiny/"
// prefix), so path traversal ("../", encoded dots, absolute paths) cannot reach
// the filesystem.

import { isError, log } from "./util.ts";

// Cobblemon aspect → pokesprite form-slug suffix, for the regional forms whose
// pokesprite slug differs from the Cobblemon aspect name. Any other aspect is
// tried verbatim as a suffix (so "gmax", "mega", "sky", … resolve to
// <slug>-<aspect> when pokesprite ships that file), and anything that maps to no
// installed sprite falls through to the base icon.
const FORM_ASPECTS: Record<string, string> = {
  hisuian: "hisui",
  alolan: "alola",
  galarian: "galar",
  paldean: "paldea",
};

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

// The shiny flag + Cobblemon aspects carried alongside a species id. Both raw —
// resolve() maps/sanitizes the aspects itself.
export interface SpriteVariant {
  shiny?: boolean;
  aspects?: string[];
}

function notFound(): Response {
  return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
}

export class SpriteStore {
  #dir: string;
  #slugs = new Set<string>(); // available <slug>.png basenames (regular set, incl. forms)
  #shinySlugs = new Set<string>(); // available shiny/<slug>.png basenames
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
  static forTest(
    slugs: string[],
    dexMap: Map<number, string> = new Map(),
    shinySlugs: string[] = [],
  ): SpriteStore {
    const s = new SpriteStore("");
    for (const slug of slugs) s.#addSlug(slug);
    for (const slug of shinySlugs) s.#shinySlugs.add(slug);
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
    // Parallel shiny set (shiny/<slug>.png). A missing shiny/ subdir is not
    // fatal — shiny requests simply fall back to the regular icon.
    try {
      for await (const entry of Deno.readDir(`${this.#dir}/shiny`)) {
        if (entry.isFile && entry.name.endsWith(".png")) {
          this.#shinySlugs.add(entry.name.slice(0, -".png".length));
        }
      }
    } catch {
      // no shiny/ subdir — shiny requests degrade to the regular sprite
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
    log("info", "sprites loaded", {
      dir: this.#dir,
      count: this.#slugs.size,
      shiny: this.#shinySlugs.size,
      dexMapped: this.#dexMap.size,
    });
  }

  #has(slug: string): boolean {
    return this.#slugs.has(slug) || this.#shinySlugs.has(slug);
  }

  // The base pokesprite slug for a species (+ optional dex fallback): the direct
  // slug, its dash-less loose match, or the dex→slug map. Returns the sanitized
  // slug as a last resort so a form candidate can still be tried; null only when
  // there is nothing to go on.
  #baseSlug(species: string, dex: number): string | null {
    const slug = sanitizeSlug(species);
    if (slug) {
      if (this.#has(slug)) return slug;
      const loose = this.#loose.get(slug.replaceAll("-", ""));
      if (loose) return loose;
    }
    if (dex > 0) {
      const bySlug = this.#dexMap.get(dex);
      if (bySlug && this.#has(bySlug)) return bySlug;
    }
    return slug || null;
  }

  // Resolve a species id (+ optional dex fallback + shiny/aspects) to a
  // whitelisted sprite path relative to the sprite dir ("growlithe-hisui.png" or
  // "shiny/growlithe-hisui.png"), or null when unmapped. Tries the most specific
  // form first, then the base; prefers the shiny variant of each candidate when
  // asked but falls back to the regular icon rather than missing.
  resolve(species: string, dex = 0, variant: SpriteVariant = {}): string | null {
    const base = this.#baseSlug(species, dex);
    if (!base) return null;

    // Ordered candidate slugs from the aspects (known regional aspects
    // normalized to pokesprite slugs, others verbatim), most specific first,
    // then the bare base.
    const candidates: string[] = [];
    for (const aspect of variant.aspects ?? []) {
      const a = sanitizeSlug(aspect);
      if (!a) continue;
      const form = FORM_ASPECTS[a] ?? a;
      const slug = `${base}-${form}`;
      if (!candidates.includes(slug)) candidates.push(slug);
    }
    candidates.push(base);

    const shiny = variant.shiny === true;
    for (const c of candidates) {
      if (shiny && this.#shinySlugs.has(c)) return `shiny/${c}.png`;
      if (this.#slugs.has(c)) return `${c}.png`;
    }
    return null;
  }

  // GET /sprites/<name>.png[?dex=N][&shiny=1][&form=hisuian,alolan] — 404s cleanly
  // on anything unmapped.
  async serve(
    rawName: string,
    dexParam: string | null,
    variant: SpriteVariant = {},
  ): Promise<Response> {
    if (!this.#dir) return notFound();
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return notFound();
    }
    if (!name.toLowerCase().endsWith(".png")) return notFound();
    const dex = dexParam ? Number.parseInt(dexParam, 10) : 0;
    const file = this.resolve(
      name.slice(0, -".png".length),
      Number.isFinite(dex) && dex > 0 ? dex : 0,
      variant,
    );
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
