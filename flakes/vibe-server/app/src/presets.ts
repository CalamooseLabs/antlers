// Launch presets, sourced from programs.vibe.presets via the NixOS module. They
// SUPERSEDE the old runtime-managed `directories`: presets are config-defined, so
// there is no runtime add / remove / filesystem-browse here. ZERO external imports.

import type { PresetConfig, ServerConfig } from "./config.ts";

export function listPresets(config: ServerConfig): PresetConfig[] {
  return config.presets;
}

export function resolvePreset(config: ServerConfig, name: string): PresetConfig | undefined {
  return config.presets.find((p) => p.name === name);
}
