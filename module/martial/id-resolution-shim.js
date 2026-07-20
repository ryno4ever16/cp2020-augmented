/**
 * Martial-art id-resolution shim (module side).
 *
 * Two repairs to the base system's skill-by-stable-id machinery, both applied to the actor
 * class the base registers on CONFIG.Actor.documentClass:
 *
 * 1. CANDIDATE SHIM (self-disengaging). The base static helper _getItemIdCandidates() recovers
 *    a skill's canonical compendium _id only from the legacy flags.core.sourceId. Foundry v12+
 *    stamps a document's compendium origin on _stats.compendiumSource instead, so a skill
 *    dragged from a compendium never resolves its canonical id: the base trainedMartials()
 *    misclassifies every built-in style as "custom-martial:<embeddedId>", the base
 *    getSkillVal(<canonical key>) hard-returns 0, and getMartialActionBonus() misses the bonus
 *    tables (all rig-proven 2026-07-19). The wrap appends the _stats.compendiumSource-derived
 *    ids to the base candidate list — the same two reads as the pending upstream fix — and
 *    STANDS DOWN the moment the base function reads compendiumSource itself (i.e. the upstream
 *    PR merged), per the seam-shim contract. Delete this half when that PR lands.
 *
 * 2. SELECTION REPAIR (permanent module behavior, kept even after the upstream fix). The base
 *    instance method _getSkillByStableId() returns the FIRST id match — and actor creation
 *    seeds every built-in martial art at level 0 under its canonical _id, so a level-0 seeded
 *    row shadows a leveled compendium-dragged copy of the same style (the style then reads
 *    level 0, or vanishes from the attack dialog once ids resolve). The replacement collects
 *    ALL matching skill items and returns the one with the highest effective level (chip
 *    overrides honored via the base realSkillValue), ties broken toward the direct
 *    embedded-id match — the base's own preference. Correct with or without repair 1.
 *
 * No settings, no user-facing strings — silent repair machinery, like seam-shim.js. Both
 * repairs are idempotent (marker property) and individually guarded, so a base-system rename
 * or reshape makes the affected half stand down instead of breaking.
 */

const SCOPE = "cp2020-augmented";

/**
 * True when the base candidate helper still needs the shim: it exists, and its source never
 * reads compendiumSource (the upstream fix is absent). Pure — exported for the rig keeper.
 *
 * @param {Function} fn  the base class's _getItemIdCandidates
 * @returns {boolean}
 */
export function needsCandidateShim(fn) {
  return typeof fn === "function" && !String(fn).includes("compendiumSource");
}

/** Install both repairs. Called once from the module's ready hook (after the base class exists). */
export function registerMartialIdResolutionShim() {
  const K = CONFIG?.Actor?.documentClass;
  if (!K) return;

  // ── 1. Candidate shim — self-disengaging ─────────────────────────────────────────────────
  try {
    if (needsCandidateShim(K._getItemIdCandidates) && !K._getItemIdCandidates.__cpIdResolutionShim) {
      const orig = K._getItemIdCandidates;
      const wrapped = function (itemData) {
        const ids = orig.call(this, itemData);
        if (!Array.isArray(ids)) return ids; // upstream semantics changed → pass through untouched
        for (const src of [itemData?._stats?.compendiumSource, itemData?._source?._stats?.compendiumSource]) {
          if (typeof src === "string" && src) {
            const tail = src.split(".").pop();
            if (tail && !ids.includes(tail)) ids.push(tail);
          }
        }
        return ids;
      };
      wrapped.__cpIdResolutionShim = true;
      K._getItemIdCandidates = wrapped;
    }
  } catch (e) {
    console.warn(`${SCOPE} | martial id-resolution candidate shim failed to install`, e);
  }

  // ── 2. Highest-effective-level selection ─────────────────────────────────────────────────
  try {
    const proto = K.prototype;
    if (typeof proto._getSkillByStableId === "function" && !proto._getSkillByStableId.__cpIdResolutionShim) {
      const replacement = function (stableId) {
        if (!stableId) return null;
        const matches = this.items.filter((i) =>
          i.type === "skill" && (K._getItemIdCandidates?.(i) ?? []).includes(stableId));
        if (!matches.length) return null;
        // Effective level via the base's chip-aware static; plain stored level if it renamed.
        const val = (s) => Number(K.realSkillValue?.(s) ?? s?.system?.level ?? 0) || 0;
        let best = matches[0];
        for (const s of matches.slice(1)) {
          const d = val(s) - val(best);
          if (d > 0 || (d === 0 && s.id === stableId && best.id !== stableId)) best = s;
        }
        return best;
      };
      replacement.__cpIdResolutionShim = true;
      proto._getSkillByStableId = replacement;
    }
  } catch (e) {
    console.warn(`${SCOPE} | martial skill-selection repair failed to install`, e);
  }
}
