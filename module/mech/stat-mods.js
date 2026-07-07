/**
 * Q7 — Personality moddies (SPECIAL-MECHANICS-PROPOSAL.md §3b): stat modifiers with printed CAPS
 * and combat/non-combat CONTEXT that the base Characteristic-Stat engine (a plain add) can't
 * express — Kick Ass "COOL +2 (11)", Perfect Soldier "INT −2/+2 non-/combat", Xarghis Khan sets.
 *
 * WHY a prepareDerivedData WRAPPER (not a Characteristic-Stat payload): a cap like "max 11" clamps
 * the FINAL stat, which is only known after the base has summed base+temp+cyber+wound. The base
 * actor.js (Tilt's, un-editable) offers no mid-prep hook, so the module wraps the actor's
 * prepareDerivedData and applies moddies as a post-step. Consequences, all deliberate:
 *   - cap/floor clamp the FINAL total — the RAW reading of "COOL +2 (max 11)".
 *   - movement/body derived values (run/leap/carry/lift/BTM) are RE-DERIVED here if a mod touches
 *     MA/BT (none of the shipped chips do, but the engine stays general).
 *   - the humanity pool is NOT recomputed from a moddy'd EMP — a personality overlay is transient,
 *     humanity is permanent essence (documented choice; also sidesteps the EMP→humanity order).
 *   - combat context is refreshed by re-preparing affected actors on combat/combatant changes
 *     (prepareDerivedData is not reactive to combat state on its own).
 *
 * Pure helpers are exported for the rig spec; the wrapper + hooks are wired by registerMechStatMods().
 */

import { cwHasType, cwIsEnabled } from "../utils.js";
import { btmFromBT } from "../lookups.js";

const SCOPE = "cp2020-augmented";

/** True when the item's mods currently apply (equipped + cyberware/chip activation gates). Pure. */
export function isStatModActive(item) {
  if (!item?.system?.mechStatMods?.enabled) return false;
  if (!item.system?.equipped) return false;
  if (item.type === "cyberware") {
    if (!cwIsEnabled(item)) return false;
    if (cwHasType(item, "Chip") && !item.system?.CyberWorkType?.ChipActive) return false;
  }
  return true;
}

/** Active stat-mod entries across `items`, tagged with the source item's id/name. Pure. */
export function activeStatMods(items) {
  const out = [];
  for (const it of items ?? []) {
    if (!isStatModActive(it)) continue;
    for (const m of it.system?.mechStatMods?.mods ?? []) {
      out.push({ ...m, itemId: it.id ?? it._id, itemName: it.name });
    }
  }
  return out;
}

/** The numeric mod an entry contributes given combat context, or null when the context excludes it. Pure. */
export function resolveEntryMod(entry, inCombat) {
  switch (entry?.context) {
    case "combat":    return inCombat ? (Number(entry.mod) || 0) : null;
    case "noncombat": return inCombat ? null : (Number(entry.mod) || 0);
    case "split":     return inCombat ? (Number(entry.combatMod) || 0) : (Number(entry.mod) || 0);
    default:          return Number(entry.mod) || 0;   // "any"
  }
}

/** Apply one entry to a running stat total: { value, delta } (delta = 0 when the context excludes it). Pure. */
export function applyEntry(total, entry, inCombat) {
  const before = Number(total) || 0;
  let value = before;
  if (entry?.isSet) {
    value = Number(entry.set) || 0;
  } else {
    const mod = resolveEntryMod(entry, inCombat);
    if (mod === null) return { value: before, delta: 0 };
    value = before + mod;
  }
  const cap = Number(entry?.cap) || 0;
  const floor = Number(entry?.floor) || 0;
  if (cap > 0) value = Math.min(value, cap);
  if (floor) value = Math.max(floor, value);
  return { value, delta: value - before };
}

/** Is the actor a participant in the active combat? Pure-ish (reads game.combats). */
export function inCombatFor(actor) {
  try {
    const id = actor?.id;
    return !!game.combats?.active?.combatants?.some(c => c.actorId === id);
  } catch (_e) { return false; }
}

/**
 * The prepareDerivedData post-step: apply active moddies to the actor's already-computed stat
 * totals, record the contributions (for the status strip/tooltips), and re-derive movement/body
 * if MA/BT changed. Mutates prepared data only — never persists.
 */
export function applyMechStatMods(actor) {
  if (!actor || (actor.type !== "character" && actor.type !== "npc")) return;
  const stats = actor.system?.stats;
  if (!stats) return;
  const entries = activeStatMods(actor.items?.contents ?? actor.items ?? []);
  if (!entries.length) { actor._mechStatMods = null; return; }
  const inCombat = inCombatFor(actor);

  const contrib = {};   // stat → [{ name, value }]
  let touchedMA = false, touchedBT = false;
  for (const e of entries) {
    const key = String(e.stat ?? "").toLowerCase();
    const stat = stats[key];
    if (!stat) continue;
    const { value, delta } = applyEntry(stat.total, e, inCombat);
    if (value === stat.total) continue;
    stat.total = value;
    (contrib[key] ??= []).push({ name: e.itemName, value: delta, set: !!e.isSet, to: value });
    if (key === "ma") touchedMA = true;
    if (key === "bt") touchedBT = true;
  }

  if (touchedMA) {
    stats.ma.run = stats.ma.total * 3;
    stats.ma.leap = Math.floor(stats.ma.run / 4);
  }
  if (touchedBT) {
    stats.bt.carry = stats.bt.total * 10;
    stats.bt.lift = stats.bt.total * 40;
    stats.bt.modifier = btmFromBT(stats.bt.total);
  }

  actor._mechStatMods = Object.keys(contrib).length ? contrib : null;
}

/** Re-prepare + re-render an actor so a combat-context change takes effect immediately. */
function refreshActor(actor) {
  try {
    actor?.reset?.();
    for (const app of Object.values(actor?.apps ?? {})) app?.render?.(false);
  } catch (_e) { /* non-fatal */ }
}

/** All actors that carry a combat/split-context moddy (the only ones a combat change affects). */
function contextSensitiveActors() {
  const out = [];
  for (const actor of game.actors ?? []) {
    const has = (actor.items?.contents ?? []).some(it =>
      isStatModActive(it) && (it.system?.mechStatMods?.mods ?? []).some(m => m.context === "combat" || m.context === "noncombat" || m.context === "split"));
    if (has) out.push(actor);
  }
  return out;
}

let _wrapped = false;
export function registerMechStatMods() {
  // Wrap the actor's prepareData once. ⚠ The base computes stat totals in prepareData() itself
  // (NOT prepareDerivedData) — and calls super.prepareData() (which fires prepareDerivedData)
  // BEFORE that computation — so a prepareDerivedData wrap runs while stats are still undefined and
  // is then overwritten. Wrapping prepareData applies moddies AFTER the base's full stat pass.
  const proto = CONFIG?.Actor?.documentClass?.prototype;
  if (proto && !_wrapped) {
    const orig = proto.prepareData;
    proto.prepareData = function () {
      orig.call(this);
      try { applyMechStatMods(this); } catch (e) { console.warn(`${SCOPE} | mech stat-mods failed`, e); }
    };
    _wrapped = true;
  }
  // Combat context is not reactive on its own — re-prepare context-sensitive actors when combat
  // starts/ends or its combatants change, so split/combat moddies switch live.
  const onCombatChange = () => { for (const a of contextSensitiveActors()) refreshActor(a); };
  Hooks.on("updateCombat", onCombatChange);
  Hooks.on("deleteCombat", onCombatChange);
  Hooks.on("createCombatant", onCombatChange);
  Hooks.on("deleteCombatant", onCombatChange);
}
