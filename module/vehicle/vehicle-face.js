/**
 * WHICH FACE a vehicle actor's sheet shows — the one place that answer is computed.
 *
 * A vehicle actor has three sheet LAYOUTS ("faces"): the standard civilian sheet (an item-sheet
 * mirror), the Maximum Metal combat sheet (armor facings, mounts, countermeasures), and the ACPA
 * powered-armor sheet. Which one renders has always been driven by the stored pair
 * {system.isACPA, system.isMMVehicle} — this module does NOT change that storage, it only decides
 * which pair a picker writes and which face a given pair produces.
 *
 * Two things this replaces:
 *  1. The face controls were scattered — a checkbox buried in the civilian sheet's identity block
 *     (isMMVehicle) and an isACPA checkbox on the two combat faces. The MM combat face carried no
 *     control that clears isMMVehicle at all, so selecting it was ONE-WAY: nothing on the rendered
 *     sheet could return the vehicle to the civilian layout.
 *  2. Nothing said what a catalog (compendium-deployed) vehicle should look like, so a deployed
 *     tank opened on the civilian sheet. A catalog vehicle now DERIVES its face from its own data
 *     and offers no picker; the picker belongs to custom vehicles, which is where the choice is
 *     actually a choice.
 *
 * ⛔ No schema change and no migration: `designatedFace` READS the stored pair and `facePatch`
 * WRITES it; a stored designation is never re-derived or rewritten by this module.
 */

import { parseCompendiumSource } from "../data-corrections.js";
import { normalizeVehicleType } from "./vehicle-deploy-request.js";

const SCOPE = "cp2020-augmented";

export const FACE_STANDARD = "standard";
export const FACE_MM       = "mm";
export const FACE_ACPA     = "acpa";
export const FACES = [FACE_STANDARD, FACE_MM, FACE_ACPA];

/**
 * The stored designation each option means. ONE table — the picker writes from it and the reader
 * below reads back through it, so the two can never disagree about what "Maximum Metal" is.
 */
export const FACE_DESIGNATIONS = {
  [FACE_STANDARD]: { isACPA: false, isMMVehicle: false },
  [FACE_MM]:       { isACPA: false, isMMVehicle: true  },
  [FACE_ACPA]:     { isACPA: true,  isMMVehicle: false },
};

/**
 * The ONE atomic update a face choice produces. Both booleans travel in a single `Actor#update`
 * call so a vehicle is never momentarily observed as both a suit and an MM combat vehicle (or as
 * neither) by a hook, a re-render, or another client.
 */
export function facePatch(face) {
  const d = FACE_DESIGNATIONS[face] ?? FACE_DESIGNATIONS[FACE_STANDARD];
  return { "system.isACPA": d.isACPA, "system.isMMVehicle": d.isMMVehicle };
}

/**
 * The face the STORED pair designates, or "" when nothing is designated (both flags false).
 * A stored `true` is authoritative everywhere — it is what a GM (or a past deploy) put there.
 */
export function designatedFace(system) {
  if (system?.isACPA === true) return FACE_ACPA;
  if (system?.isMMVehicle === true) return FACE_MM;
  return "";
}

/**
 * The compendium address a vehicle actor traces back to, or null.
 *
 * Provenance is recorded by the deploy path as `flags.cp2020-augmented.sourceItemUuid` — the uuid
 * of the ITEM the actor was built from (vehicle-deploy-request.js `createVehicleActorFromItem`).
 * That uuid is either a pack address itself (deployed straight from a compendium) or the address
 * of an owned/world copy, whose own pack origin lives in `_stats.compendiumSource` — the same
 * id-based chain the corrections layer matches on, never a name match.
 *
 * A pack address is answered WITHOUT loading the document: `fromUuidSync` on an unloaded pack
 * returns an index stub that carries no `_stats`. A source item that no longer resolves returns
 * null, i.e. the actor is treated as custom and keeps its picker — the forgiving direction.
 */
export function vehiclePackSource(actor) {
  const uuid = actor?.flags?.[SCOPE]?.sourceItemUuid;
  if (!uuid) return null;
  const direct = parseCompendiumSource(uuid);
  if (direct) return direct;
  let item = null;
  try { item = fromUuidSync(uuid); } catch (e) { return null; }
  return parseCompendiumSource(item?._stats?.compendiumSource ?? null);
}

/** True when the vehicle came from a compendium item — a CATALOG vehicle, not a custom build. */
export function isCatalogVehicle(actor) {
  return vehiclePackSource(actor) !== null;
}

/**
 * The face a catalog vehicle's own data implies, used ONLY where nothing is designated.
 * Powered armor is its own face; tanks and APCs are combat vehicles; everything else is civilian.
 * Both the normalized handling class (`vehicleType`) and the book's verbatim class string
 * (`vehicleTypeText`, run through the same normalizer the deploy path uses) are consulted, because
 * a deployed suit stores `vehicleType: "car"` and carries "ACPA" only in the verbatim string.
 */
export function derivedFace(system) {
  const keys = [
    String(system?.vehicleType ?? "").trim().toLowerCase(),
    normalizeVehicleType(system?.vehicleTypeText).type.trim().toLowerCase(),
  ];
  if (keys.includes("acpa")) return FACE_ACPA;
  if (keys.some(k => k === "tank" || k === "apc")) return FACE_MM;
  return FACE_STANDARD;
}

/**
 * The whole answer for one actor.
 *
 * @param {Actor} actor
 * @param {boolean} mmOn  the world's Maximum Metal gate — the SAME predicate that gated the MM
 *                        combat face before this control existed (`mmEnabled()`), so nothing about
 *                        which face renders changes for an existing world.
 * @returns {{face:string, chosen:string, stored:string, derived:string, catalog:boolean,
 *            showPicker:boolean, mmGated:boolean}}
 *   face       the layout to render
 *   chosen     the designation in force (what the picker shows selected) BEFORE the world gate
 *   stored     the stored designation, "" when none
 *   derived    the data-derived face for a catalog vehicle, "" for a custom one
 *   catalog    came from a compendium item
 *   showPicker the face picker is offered (custom vehicles only)
 *   mmGated    the MM option is unavailable in this world
 */
export function resolveVehicleFace(actor, { mmOn = false } = {}) {
  const system = actor?.system ?? {};
  const catalog = isCatalogVehicle(actor);
  const stored = designatedFace(system);
  const derived = catalog ? derivedFace(system) : "";
  // Stored FIRST, always: a designation someone put on this actor is never re-derived away.
  const chosen = stored || (catalog ? derived : FACE_STANDARD);
  // The world gate falls the MM face back to standard for the render only — the designation stays
  // stored, so turning Maximum Metal back on restores the combat sheet with nothing re-entered.
  // The ACPA face is deliberately NOT gated: a suit rendered as a suit in a Core world before this
  // control existed, and still does.
  const face = (chosen === FACE_MM && !mmOn) ? FACE_STANDARD : chosen;
  return { face, chosen, stored, derived, catalog, showPicker: !catalog, mmGated: !mmOn };
}

/**
 * True when the vehicle carries combat data the civilian face does not show and the Maximum Metal
 * resolver does read: armor in any facing other than the front (the only SP the civilian sheet
 * prints), mounted weapons, or any of the MM system fittings.
 */
export function carriesMMCombatData(actor) {
  const s = actor?.system ?? {};
  const sp = s.sp ?? {};
  if ([sp.side, sp.rear, sp.top, sp.bottom].some(v => (Number(v) || 0) !== 0)) return true;
  const mounts = actor?.items?.filter?.(i => i.type === `${SCOPE}.vehicleWeapon`) ?? [];
  if (mounts.length > 0) return true;
  if (Array.isArray(s.countermeasures) && s.countermeasures.length > 0) return true;
  if (s.compositeArmor === true || s.reactiveArmor === true || s.sensors === true || s.antiMissile === true) return true;
  if ((Number(s.fireControl) || 0) !== 0) return true;
  return false;
}
