/**
 * Category glyphs for weapons and cyberware that carry only a placeholder picture.
 *
 * The module's own packs store a glyph on every weapon and every piece of cyberware. The base system's
 * packs do not: its weapons all carry one generic weapon icon and its cyberware one generic implant
 * icon, so a shelf that mixes the two reads as two different kinds of thing. The base packs cannot be
 * edited (they are reinstalled with every system update), so the picture is chosen at READ time
 * instead, from the item's own category fields, and nothing is ever written to the item:
 *
 *   - a document (sheet, inventory row, an opened compendium entry) through its data model's
 *     `prepareBaseData` (module/data/weapon-item-data.js, and the cyberware model in
 *     module/data/mech-item-data.js);
 *   - a shop catalog row through the catalog index (module/shop/catalog.js);
 *   - a compendium window's list, which draws index entries rather than documents, through the
 *     `renderCompendium` hook below.
 *
 * An item whose picture is anything other than a known placeholder is left alone: an item someone
 * gave its own art keeps it.
 */

const ICON_DIR = "modules/cp2020-augmented/img/icons/";

/** Pictures that say nothing about the item: the base system's weapon icon (and the module's copy of
 *  it), its two implant icons, and the core defaults an item ends up with when nobody chose one. */
const PLACEHOLDERS = new Set([
  "systems/cyberpunk2020/img/weapon-icon.svg",
  "modules/cp2020-augmented/img/weapon-icon.svg",
  "systems/cyberpunk2020/img/implant-icon-1.svg",
  "systems/cyberpunk2020/img/implant-icon-2.svg",
  "icons/svg/sword.svg",
  "icons/svg/item-bag.svg",
  "icons/svg/mystery-man.svg",
]);

/** The fields a pack index must carry for `glyphForIndexEntry` to answer from an index entry. */
export const GLYPH_INDEX_FIELDS = ["img", "type", "system.weaponType", "system.attackType", "system.cyberwareType", "system.cyberwareSubtype"];

const cleanPath = (img) => String(img ?? "").trim().replace(/^\/+/, "");

/** Is this picture one of the placeholders? PURE. */
export function isPlaceholderIcon(img) {
  return PLACEHOLDERS.has(cleanPath(img));
}

/** The glyph's file name for a weapon's category, or null when the category has none. PURE.
 *  One glyph per category; Heavy and Exotic are split by the attack type the item already carries (the
 *  same families the module's own packs use). Melee is ONE glyph: a base melee weapon carries nothing
 *  that tells a blade from a club (no edged flag, attack type "Melee" on all of them), and a knife drawn
 *  as a club is worse than every melee weapon drawn as a blade. */
function glyphName(weaponType, attackType) {
  const a = String(attackType ?? "").trim().toLowerCase();
  if (a === "shotgun" || a === "autoshotgun") return "sawed-off-shotgun";   // a shotgun whatever type it was filed under
  switch (String(weaponType ?? "")) {
    case "Pistol":  return "pistol-gun";
    case "SMG":     return "mp5";
    case "Rifle":   return "fn-fal";
    case "Shotgun": return "sawed-off-shotgun";
    case "Heavy":
      if (a === "grenade" || a === "explocharge") return "grenade";
      if (a === "auto") return "machine-gun";
      if (a === "flamethrow") return "flamethrower";
      return "missile-launcher";
    case "Melee":
      if (a === "martial") return null;                 // a body technique, not a tool
      return "katana";
    case "Exotic":
      if (a === "archer") return "bow-arrow";
      if (a === "taser") return "electric";
      if (a === "flamethrow") return "flamethrower";
      return "ray-gun";
    default: return null;
  }
}

/**
 * The glyph to SHOW for a weapon, or null to show its own picture. PURE.
 * @param {{img?: string, weaponType?: string, attackType?: string}} w
 * @returns {string|null}
 */
export function weaponGlyph({ img, weaponType, attackType } = {}) {
  if (!isPlaceholderIcon(img)) return null;
  const name = glyphName(weaponType, attackType);
  return name ? `${ICON_DIR}${name}.svg` : null;
}

/** The glyph's file name for a piece of cyberware's KIND, or null when the kind has none. PURE.
 *  The kind is read from the type and subtype the base data already carries (its spellings vary in
 *  case, hence the lower-casing). A cyberlimb is an arm unless its name says leg or foot; skin and
 *  subdermal armor are filed under several types and are caught by their subtype first. */
/** A few base records carry no type at all (three optics among them). The base packs are sorted by kind,
 *  so the pack a record came from answers for it. Only consulted when the type gives no answer. */
const PACK_KIND_GLYPH = {
  "cyberpunk2020.cyberoptic": "cyber-eye",
  "cyberpunk2020.cyberaudio": "human-ear",
  "cyberpunk2020.neuralware": "brain",
  "cyberpunk2020.chipware": "microchip",
  "cyberpunk2020.cyberlimbs": "mechanical-arm",
  "cyberpunk2020.cyberweapons": "wolverine-claws",
  "cyberpunk2020.implants": "internal-organ",
  "cyberpunk2020.bioware": "dna1",
  "cyberpunk2020.fashonware": "lipstick",
};

/** The pack a document came from: its own pack when it is a compendium document, else the pack its
 *  compendium source names ("Compendium.<pack id>.Item.<id>"), else "". PURE. */
export function sourcePackId(item) {
  if (item?.pack) return String(item.pack);
  const m = String(item?._stats?.compendiumSource ?? "").match(/^Compendium\.(.+)\.Item\.[^.]+$/);
  return m ? m[1] : "";
}

function cyberwareGlyphName(cyberwareType, cyberwareSubtype, name) {
  const t = String(cyberwareType ?? "").trim().toLowerCase();
  const sub = String(cyberwareSubtype ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (sub === "skinweave" || sub === "skin weave" || sub === "subdermal armor" || t === "body plating") return "muscular-torso";
  if (t === "cyberweapon" || sub === "weapon") return "wolverine-claws";
  switch (t) {
    case "chipware":      return "microchip";
    case "cyberoptic":    return "cyber-eye";
    case "cyberaudio":    return "human-ear";
    case "neuralware":    return "brain";
    case "cyberleg":
    case "cyberfoot":     return "robot-leg";
    case "cyberarm":
    case "cyberhand":
    case "cybernetic system": return "mechanical-arm";   // limb coverings and options (etched design, waterproofing)
    case "cyberlimb":     return /\b(leg|legs|foot|feet)\b/i.test(String(name ?? "")) ? "robot-leg" : "mechanical-arm";
    case "implant":
    case "cybervocal":    return "internal-organ";
    case "bioware":       return "dna1";
    case "fashionware":   return "lipstick";
    case "linear frames": return "cyborg-face";
    default: return null;
  }
}

/**
 * The glyph to SHOW for a piece of cyberware, or null to show its own picture. PURE.
 * @param {{img?: string, cyberwareType?: string, cyberwareSubtype?: string, name?: string, packId?: string}} c
 * @returns {string|null}
 */
export function cyberwareGlyph({ img, cyberwareType, cyberwareSubtype, name, packId } = {}) {
  if (!isPlaceholderIcon(img)) return null;
  const glyph = cyberwareGlyphName(cyberwareType, cyberwareSubtype, name) ?? PACK_KIND_GLYPH[String(packId ?? "")] ?? null;
  return glyph ? `${ICON_DIR}${glyph}.svg` : null;
}

/** The same answers for a pack INDEX entry (`{ type, name, img, system: {…} }`) of the pack `packId`. PURE. */
export function glyphForIndexEntry(entry, packId = "") {
  if (!entry) return null;
  const s = entry.system ?? {};
  if (entry.type === "weapon") return weaponGlyph({ img: entry.img, weaponType: s.weaponType, attackType: s.attackType });
  if (entry.type === "cyberware") return cyberwareGlyph({ img: entry.img, cyberwareType: s.cyberwareType, cyberwareSubtype: s.cyberwareSubtype, name: entry.name, packId });
  return null;
}

/**
 * Compendium windows list index entries, so the document-side rule never reaches them: once a window
 * has drawn, give each listed weapon and piece of cyberware its glyph. The extra index fields are fetched once per pack
 * (core keeps the index it has already loaded) and only for a pack somebody opened.
 */
export function registerItemGlyphs() {
  Hooks.on("renderCompendium", async (app, element) => {
    try {
      const pack = app?.collection;
      if (!pack || pack.documentName !== "Item") return;
      const root = element instanceof HTMLElement ? element : (element?.[0] ?? app.element);
      if (!root?.querySelectorAll) return;
      const index = await pack.getIndex({ fields: GLYPH_INDEX_FIELDS });
      for (const row of root.querySelectorAll("[data-entry-id]")) {
        const picture = row.querySelector("img");
        if (!picture) continue;
        const glyph = glyphForIndexEntry(index.get(row.dataset.entryId), pack.collection);
        if (glyph && cleanPath(picture.getAttribute("src")) !== glyph) picture.src = glyph;
      }
    } catch (e) {
      console.warn("cp2020-augmented | compendium glyphs skipped", e);
    }
  });
}
