import type { Manifest, SwitchingSet, Track } from "../types/manifest";

/**
 * Transient upsert index for a single `applyMpd` call. `sets` aliases
 * `manifest.switchingSets` — pushing through the context mutates the
 * manifest in place, which is what preserves identity across updates.
 */
export type ApplyContext = {
  sets: SwitchingSet[];
  switchingSetsById: Map<string, SwitchingSet>;
  tracksById: Map<string, Track>;
};

export function createContext(manifest: Manifest): ApplyContext {
  const ctx: ApplyContext = {
    sets: manifest.switchingSets,
    switchingSetsById: new Map(),
    tracksById: new Map(),
  };
  for (const set of manifest.switchingSets) {
    ctx.switchingSetsById.set(set.id, set);
    for (const track of set.tracks) {
      ctx.tracksById.set(`${set.id}:${track.id}`, track);
    }
  }
  return ctx;
}
