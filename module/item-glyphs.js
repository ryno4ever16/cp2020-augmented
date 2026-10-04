/**
 * Category glyphs for weapons that carry only a placeholder picture.
 *
 * The module's own packs store a category glyph on every weapon. The base system's packs do not:
 * every one of its weapons carries the same generic weapon icon, so a shelf that mixes the two reads
 * as two different kinds of thing. The base packs cannot be edited (they are reinstalled with every
 * system update), so the picture is chosen at READ time instead, from the item's own category
 * fields, and nothing is ever written to the item:
 *
 *   - a document (sheet, inventory row, an opened compendium entry) through the weapon data model's
 *     `prepareBaseData` (module/data/weapon-item-data.js);
 *   - a shop catalog row through the catalog index (module/shop/catalog.js);
 *   - a compendium window's list, which draws index entries rather than documents, through the
 *     `renderCompendium` hook below.
 *
 * A weapon whose picture is anything other than a known placeholder is left alone: an item someone
 * gave its own art keeps it.
 */

const ICON_DIR = "modules/cp2020-augmented/img/icons/";

/** Pictures that say nothing about the item: the base system's weapon icon (and the module's copy of
 *  it), and the two core defaults a weapon ends up with when nobody chose one. */
const PLACEHOLDERS = new Set([
  "systems/cyberpunk2020/img/weapon-icon.svg",
  "modules/cp2020-augmented/img/weapon-icon.svg",
  "icons/svg/sword.svg",
  "icons/svg/item-bag.svg",
  "icons/svg/mystery-man.svg",
]);

/** The fields a pack index must carry for `weaponGlyph` to answer from an index entry. */
export const GLYPH_INDEX_FIELDS = ["img", "type", "system.weaponType", "system.attackType"];

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

/** The same answer for a pack INDEX entry (`{ type, img, system: {…} }`). PURE. */
export function weaponGlyphForIndexEntry(entry) {
  if (!entry || entry.type !== "weapon") return null;
  const s = entry.system ?? {};
  return weaponGlyph({ img: entry.img, weaponType: s.weaponType, attackType: s.attackType });
}

/**
 * Compendium windows list index entries, so the document-side rule never reaches them: once a window
 * has drawn, give each listed weapon its glyph. The extra index fields are fetched once per pack
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
        const glyph = weaponGlyphForIndexEntry(index.get(row.dataset.entryId));
        if (glyph && cleanPath(picture.getAttribute("src")) !== glyph) picture.src = glyph;
      }
    } catch (e) {
      console.warn("cp2020-augmented | compendium glyphs skipped", e);
    }
  });
}
