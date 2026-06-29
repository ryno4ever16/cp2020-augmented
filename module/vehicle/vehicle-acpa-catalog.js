/**
 * vehicle-acpa-catalog.js — compendium seed for the ACPA systems catalog (Maximum Metal p.61-79).
 *
 * The catalog data lives in vehicle-acpa-systems.js (PURE, ACPA_SYSTEMS). This module turns those
 * entries into Items in the "ACPA Systems (MM)" compendium so GMs can drag them onto a powered-armor
 * suit, exactly like the Vehicle Weapons (MM) pack. Idempotent by name.
 */

import { ACPA_SYSTEMS } from "./vehicle-acpa-systems.js";
import { mmEnabled } from "../settings.js";

const PACK_ID = "cp2020-augmented.acpa-systems";
const ICON = "icons/svg/chest.svg";
const SOURCE = "Maximum Metal";

/** A catalog def → the system data for a CyberpunkAcpaSystemData Item (area defaults to torso). */
function defToSystem(def) {
  return {
    category: def.category, mount: def.mount, area: "torso",
    spaces: def.spaces, sp: def.sp, sdp: def.sdp, shots: def.shots ?? 0,
    weight: def.weight, cost: def.cost,
    catalogKey: def.key, source: SOURCE,
  };
}

/**
 * Populate the ACPA Systems (MM) compendium from ACPA_SYSTEMS. Idempotent — creates only entries whose
 * name isn't already present (unless force). GM-only.
 * @returns {Promise<{ok:boolean, created?:number, reason?:string}>}
 */
export async function seedAcpaSystemCompendium({ force = false } = {}) {
  const pack = game.packs?.get(PACK_ID);
  if (!pack) return { ok: false, reason: "pack-missing" };
  if (!game.user?.isGM) return { ok: false, reason: "not-gm" };

  const wasLocked = !!pack.locked;
  try {
    if (wasLocked) await pack.configure({ locked: false });
    // On a brand-new pack the unlock can lose a race with the ready hook. If it didn't take, skip
    // quietly (retried next launch) rather than letting createDocuments raise a locked-pack warning.
    if (pack.locked) return { ok: false, reason: "locked" };
    const index = await pack.getIndex();
    // `force` UPDATES existing entries in place; otherwise back-fill missing names only. (Filtering all
    // names through createDocuments on force DUPLICATED the catalog rather than refreshing it.)
    const idByName = new Map(index.map(e => [e.name, e._id]));
    const toCreate = [], toUpdate = [];
    for (const def of Object.values(ACPA_SYSTEMS)) {
      const id = idByName.get(def.label);
      if (id == null) toCreate.push({ name: def.label, type: "cp2020-augmented.acpaSystem", img: ICON, system: defToSystem(def) });
      else if (force) toUpdate.push({ _id: id, img: ICON, system: defToSystem(def) });
    }
    if (toCreate.length) await Item.createDocuments(toCreate, { pack: pack.collection });
    if (toUpdate.length) await Item.updateDocuments(toUpdate, { pack: pack.collection });
    return { ok: true, created: toCreate.length, updated: toUpdate.length };
  } catch (err) {
    console.warn("Cyberpunk2020 | ACPA-system compendium seed failed", err);
    return { ok: false, reason: "error" };
  } finally {
    if (wasLocked) await pack.configure({ locked: true }).catch(() => {});
  }
}

/** Ready-time one-shot: seed the compendium if it exists and is missing entries. Active GM only. */
export async function ensureAcpaSystemSeed() {
  if (!mmEnabled()) return;                                   // Maximum Metal off → don't seed the MM compendium
  if (!game.user?.isGM || game.users?.activeGM?.id !== game.user.id) return;
  const pack = game.packs?.get(PACK_ID);
  if (!pack) return;
  try {
    await seedAcpaSystemCompendium();
  } catch (err) {
    console.warn("Cyberpunk2020 | ensureAcpaSystemSeed failed", err);
  }
}
