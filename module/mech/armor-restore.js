/**
 * Armor catalog restore — put a worn garment's stopping power back to the number its pack entry
 * prints.
 *
 * WHY IT IS NEEDED. Armor degradation is destructive in place: `ablateLocationOnce` /
 * `ablateLocationByAmount` (combat/DamageApplicator.js) write the reduced number straight into
 * `system.coverage.<Zone>.stoppingPower` on the owned item. There is no separate "current vs
 * maximum" field on the armor model — the schema carries one SP per zone plus an `ablation` number
 * our engines never read — so once a jacket has eroded, its original rating exists nowhere on the
 * actor. Repairing it meant a GM retyping six boxes from the compendium by hand. This is that
 * gesture, done from the record instead of from memory.
 *
 * WHERE THE NUMBER COMES FROM. The owned copy's pack origin (`_stats.compendiumSource`, or the
 * legacy `flags.core.sourceId`), parsed by the corrections layer's own `parseCompendiumSource` —
 * the same id-based join the create-time corrections use, never a name match. The pack document is
 * then run through the SAME two correction passes a freshly-bought copy gets
 * (`applyPackRulesToItemSystem` + `applyCorrectionToItemData`), so the restored figure equals what
 * the catalog shows and what a re-purchase would deliver — not a raw pack value the catalog
 * disagrees with.
 *
 * SCOPE. Stopping power only. Nothing else on the item is touched: no name, no cost, no notes, no
 * equipped state, no module flags. An item with no resolvable pack source (hand-made armor, a
 * homebrew garment) is not restorable and offers no control at all.
 */

import { parseCompendiumSource, correctionFor, applyCorrectionToItemData, applyPackRulesToItemSystem } from "../data-corrections.js";
import { localize } from "../utils.js";

/** The zones an armor item's coverage block carries, in the base system's own order. */
export const ARMOR_COVERAGE_ZONES = ["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"];

/**
 * The pack origin of an owned armor item, or null.
 *
 * SYNC on purpose: the sheet decides whether to render the control during `_prepareContext`, and a
 * pack-document fetch there would make every armor sheet await a compendium read. Existence is
 * settled from the pack registry and its already-built index; the document itself is fetched only
 * when the control is actually pressed.
 *
 * @param {Item} item
 * @returns {{packId:string,itemId:string}|null}
 */
export function armorPackSource(item) {
  if (!item || item.type !== "armor") return null;
  const src = parseCompendiumSource(item?._stats?.compendiumSource ?? item?.flags?.core?.sourceId);
  if (!src) return null;
  const pack = game?.packs?.get?.(src.packId);
  if (!pack) return null;
  // The index is built at world init; if it is populated, require the id to be in it, so a stale
  // origin pointing at a document that no longer exists offers no control. An empty index (a pack
  // that has not indexed yet) is not treated as proof of absence.
  if (pack.index?.size > 0 && !pack.index.get(src.itemId)) return null;
  return src;
}

/** True when this item can be restored from a pack entry. The sheet's render gate. */
export function canRestoreArmor(item) {
  return armorPackSource(item) !== null;
}

/** Read the six zone SP values off an armor `system` block as numbers. Pure. */
export function coverageSp(system) {
  const out = {};
  for (const zone of ARMOR_COVERAGE_ZONES) {
    out[zone] = Math.max(0, Number(system?.coverage?.[zone]?.stoppingPower) || 0);
  }
  return out;
}

/** The highest zone SP in a coverage map — the single number a garment is spoken of by. Pure. */
export function peakSp(spByZone) {
  return Math.max(0, ...ARMOR_COVERAGE_ZONES.map(z => Number(spByZone?.[z]) || 0));
}

/**
 * The catalog stopping power for an owned armor item: the pack document's coverage after the same
 * corrections a bought copy receives. Null when there is no resolvable pack source.
 *
 * @param {Item} item
 * @returns {Promise<{Head:number,Torso:number,lArm:number,rArm:number,lLeg:number,rLeg:number}|null>}
 */
export async function armorCatalogSp(item) {
  const src = armorPackSource(item);
  if (!src) return null;
  let doc = null;
  try { doc = await game.packs.get(src.packId)?.getDocument(src.itemId); } catch { doc = null; }
  if (!doc) return null;

  // Mirror the create-time correction order exactly: pack RULES normalize first, the per-item ENTRY
  // patches over them. Operates on a detached copy — the compendium document is never written.
  const data = { name: doc.name, system: foundry.utils.deepClone(doc.toObject().system ?? {}) };
  applyPackRulesToItemSystem(src.packId, data.system);
  const c = correctionFor(src.packId, src.itemId);
  if (c) applyCorrectionToItemData(data, c);
  return coverageSp(data.system);
}

/**
 * Restore an owned armor item's per-zone stopping power to its catalog values.
 *
 * GM-only: it rewrites another player's equipment from a source they cannot see, so the same tier
 * that owns the compendium owns the gesture. Returns false and says why on every refusal path.
 *
 * @param {Item}    item
 * @param {object}  [opts]
 * @param {boolean} [opts.confirm=true]  show the catalog-vs-current confirm before writing
 * @returns {Promise<boolean>} true when SP was written
 */
export async function restoreArmorToCatalog(item, { confirm = true } = {}) {
  if (!item || item.type !== "armor") return false;
  if (!game.user?.isGM) { ui.notifications?.warn(localize("ArmorRestoreGmOnly")); return false; }

  const catalog = await armorCatalogSp(item);
  if (!catalog) { ui.notifications?.warn(localize("ArmorRestoreNoSource")); return false; }

  const current = coverageSp(item.system);
  const changedZones = ARMOR_COVERAGE_ZONES.filter(z => current[z] !== catalog[z]);
  if (!changedZones.length) { ui.notifications?.info(localize("ArmorRestoreAlreadyAtCatalog")); return false; }

  if (confirm) {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: localize("ArmorRestoreTitle") },
      content: `<p>${localize("ArmorRestoreBody", {
        name: item.name, catalog: peakSp(catalog), current: peakSp(current), zones: changedZones.length
      })}</p>`,
      yes: { callback: () => true },
      no: { default: true, callback: () => false },
    });
    if (!ok) return false;
  }

  // FULL coverage-object write, not dot-notation paths: this is an ObjectField, and a partial
  // dot-path update merges rather than replaces — the same idiom ablateLocationOnce uses when it
  // writes the reduced number ([[feedback-datamodel-partial-updates]]).
  const coverage = foundry.utils.deepClone(item.system?.coverage ?? {});
  for (const zone of ARMOR_COVERAGE_ZONES) {
    coverage[zone] = { ...(coverage[zone] ?? {}), stoppingPower: catalog[zone] };
  }
  // fromCyberpunkDamageSystem is the flag the live-sheet refresh hook watches, so every client's
  // open actor sheet repaints the new SP — the same signal the ablation writes carry.
  await item.update({ "system.coverage": coverage }, { fromCyberpunkDamageSystem: true });
  ui.notifications?.info(localize("ArmorRestoreDone", { name: item.name, sp: peakSp(catalog) }));
  return true;
}
