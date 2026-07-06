/**
 * Data corrections for BASE-SYSTEM compendium items (eyes-verified against the books).
 *
 * The base system's packs can't be edited in place (they're re-installed on every system update), so
 * book-verified corrections live here and are applied at the two places the module touches that data:
 *   1. `preCreateItem` — a copy created FROM a corrected compendium item (drag-out, shop purchase)
 *      gets the corrected name/cost/flavor plus the correction notes appended, so owned copies carry
 *      the book values. Matching is by the copy's `_stats.compendiumSource` uuid (v12+; never by name).
 *   2. The shop (catalog.js / purchase.js) — reads `correctedCost`/`correctionFor` so browsing,
 *      purchase charging and the request flow all price with the corrected values.
 *
 * `priceRange` marks a VARIABLE-PRICE item (the book prints a range, e.g. "200-1000eb by style"): the
 * catalog shows the range as a suggestion and, for these items only, a GM price override takes
 * precedence over the compendium cost (see resolveCatalogPrice's preferOverride) so the GM can set the
 * final price without editing the compendium.
 *
 * PURE DATA + pure lookups here; the only impure piece is registerDataCorrections() (the hook), called
 * from the module's init hook. Notes text is item DATA (like pack content), not UI — it stays English.
 * Sourced from the user's book audit 2026-07-05 (import-staging/item-audit/USER-AUDIT-2026-07-05.md).
 */

const CYBERWARE_OLD = "cyberpunk2020.cyberware-old";

/** One `<p>` block appended to a corrected item's notes. */
function note(text) { return `<p>${text}</p>`; }

const FINGER_NOTE = "Dynalar cyberfinger option (Chromebook 3 p.22). Requires an installed cyberhand or cyberarm — compatible with any model. A hand fits up to 5 cyberfinger options.";

/** packId → itemId → correction: { name?, cost?, flavor?, priceRange?{min,max}, notesAppend? } */
export const DATA_CORRECTIONS = {
  [CYBERWARE_OLD]: {
    // Super Compact Braindance → the book's full product name (Chromebook 3 p.23).
    tsY2j88C5WxOTbDG: { name: "Super Compact Braindance Recorder" },
    // LiveWires: 400eb is the NON-implant wearable's price; the body implant costs 200eb (CB3 p.24).
    s4D3tB3dwEsVs3AE: {
      cost: 200,
      flavor: "Prehensile interface cables (body-implant version)",
      notesAppend: note("Body-implant version: 200eb. A non-implant wearable version exists for 400eb (sold as gear). (Chromebook 3 p.24)"),
    },
    // Bonespike (CB3 p.25): surgery code, breakage roll, concealment.
    lNqrIKwpKnbbkZKi: {
      notesAppend: note("Surgery: MA. Damage 1d6+4. Roll 3 or less on 1d10 to avoid breakage. Noticing the bonespike slit requires a Very Difficult Awareness check; X-rays and scanners see only forearm reinforcement. (Chromebook 3 p.25)"),
    },
    // Enable cyberlimbs (CB3 p.34): the pack carried the USED prices; the book's new prices are
    // 4000/arm and 6000/leg. Used prices kept in the description.
    ksNQKhJLA69OyVZi: {
      cost: 4000,
      flavor: "23/33 SDP; REF -1. New price; used examples ~500eb",
      notesAppend: note("New: 4,000eb per arm (used examples ~500eb). 23 SDP to disable, 33 SDP to destroy. Reduces the user's REF by 1. Humanity Cost 2d6+2. (Chromebook 3 p.34)"),
    },
    "58jU3dLX2vobSely": {
      cost: 6000,
      flavor: "28/35 SDP; REF -1; MA -1 per leg. New price; used examples ~700eb",
      notesAppend: note("New: 6,000eb per leg (used examples ~700eb). 28 SDP to disable, 35 SDP to destroy. Reduces the user's REF by 1; MA reduced by 1 per leg. Humanity Cost 3d6+3 each. (Chromebook 3 p.34)"),
    },
    // General Products exoskeletons (CB3 p.34): the book's movement caveat.
    NpOACgBGfKqubbbU: { notesAppend: note("The wearer moves like a vehicle instead of a person while the exoskeleton is worn. (Chromebook 3 p.34)") },
    ZCcxYK3Hd9yJC9wy: { notesAppend: note("The wearer moves like a vehicle instead of a person while the exoskeleton is worn. (Chromebook 3 p.34)") },
    // Spectrum outer-ear attachments (CB3 p.35): variable price by style.
    hqp1XekLTwvDxuIC: {
      priceRange: { min: 200, max: 1000 },
      notesAppend: note("Outer-ear attachments, 200–1000eb by style: Elven, pointed, batwing, scooping. The GM sets the final price for the chosen style. (Chromebook 3 p.35)"),
    },
    // Gene-Tek See-It transparent skin (CB3 p.35): per-square-meter pricing + HC.
    qBZuO58sBE7zvcyu: {
      notesAppend: note("Cost is per square meter of skin covered. Humanity Cost 3d6 per square meter — 6d6 if the entire body is covered. Arms are ½ square meter each; legs are 1 square meter each. (Chromebook 3 p.35)"),
    },
    // Dermatech Mood Skin (CB3 p.35): per-m² HC + the legacy-stock BODY degradation.
    OLnmO8cNfiDhd6cW: {
      notesAppend: note("Cost is per square meter of skin covered. Humanity Cost 1d6 per square meter (a single entire limb ≈1d6; the torso ≈2d6). Old stock is still floating around and being used anew: a character implanted with it loses 1 BODY every 2 months for a year. (Chromebook 3 p.35)"),
    },
    // Lead's nails (CB3 p.36): set vs per-nail pricing; Show-Off extras.
    POMGj69ON3zmGXoQ: { notesAppend: note("200eb for a set of 10 nails, or 25eb per single nail. (Chromebook 3 p.36)") },
    "9e7tY4x9hcXqY64r": {
      notesAppend: note("425eb for a set of 10 nails, or 45eb per single nail. A 90eb coloring nail pen is sold separately. The nails may be permanently implanted as cyberware for 2 Humanity Cost per pair of hands or feet. (Chromebook 3 p.36)"),
    },
    // The Chromebook 3 p.22 Dynalar cyberfinger options (7 products): option requirement + limit.
    oC2Znx4VqJKXvTYD: { notesAppend: note(FINGER_NOTE) },   // Probe Link
    JRjY6m94O54GmMas: { notesAppend: note(FINGER_NOTE) },   // Parabolic Microphone
    vIS7tLKn2knqwZYJ: { notesAppend: note(FINGER_NOTE) },   // Flasher
    atR26dOPGVwYD9nv: { notesAppend: note(FINGER_NOTE) },   // IR/UV Flashlight
    SIUDnA5V2TsKt8iE: { notesAppend: note(FINGER_NOTE) },   // Flare
    "6nlw0wJmhdg1z9wu": { notesAppend: note(FINGER_NOTE) }, // Storage Compartment
    Go9manEx2jk02j8i: { notesAppend: note(FINGER_NOTE) },   // Laser Pointer
  },
};

/** The correction entry for a compendium item, or null. */
export function correctionFor(packId, itemId) {
  return DATA_CORRECTIONS[packId]?.[itemId] ?? null;
}

/** The book-corrected cost for a compendium item (falls back to the raw cost when uncorrected). */
export function correctedCost(packId, itemId, rawCost) {
  const c = correctionFor(packId, itemId);
  return c && c.cost !== undefined ? c.cost : rawCost;
}

/** Parse "Compendium.<pack.id>.Item.<docId>" → {packId, itemId}, else null. */
function parseCompendiumSource(uuid) {
  const m = /^Compendium\.(.+)\.Item\.([A-Za-z0-9]{16})$/.exec(String(uuid ?? ""));
  return m ? { packId: m[1], itemId: m[2] } : null;
}

/**
 * Apply a correction to a to-be-created item copy (mutates `data`, returns true if changed).
 * Pure given (data, correction) — exported for the corrections rig test.
 */
export function applyCorrectionToItemData(data, c) {
  if (!c) return false;
  if (c.name) data.name = c.name;
  data.system ??= {};
  if (c.cost !== undefined) data.system.cost = c.cost;
  if (c.flavor !== undefined) data.system.flavor = c.flavor;
  if (c.notesAppend && !String(data.system.notes ?? "").includes(c.notesAppend)) {
    data.system.notes = `${data.system.notes ?? ""}${c.notesAppend}`;
  }
  return true;
}

/** Hook: copies created from a corrected compendium item carry the corrected data. */
export function registerDataCorrections() {
  Hooks.on("preCreateItem", (doc, data) => {
    const src = parseCompendiumSource(doc?._stats?.compendiumSource ?? data?._stats?.compendiumSource);
    if (!src) return;
    const c = correctionFor(src.packId, src.itemId);
    if (!c) return;
    const patch = { name: data.name, system: foundry.utils.deepClone(data.system ?? {}) };
    if (applyCorrectionToItemData(patch, c)) doc.updateSource({ name: patch.name, system: patch.system });
  });
}
