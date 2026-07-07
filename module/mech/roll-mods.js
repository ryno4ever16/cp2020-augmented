/**
 * P5 — Roll-modifier providers (SPECIAL-MECHANICS-PROPOSAL.md; smartgun links, targeting scopes,
 * "+2 Diagnose" tools, lock decryptors, recognition chips).
 *
 * Passive like mech/protection.js: no hooks, no token writes. The two Modifiers-dialog call sites
 * (weapon attack + skill roll, actor-sheet.js) CONSULT these helpers: each active provider becomes
 * one extra checkbox row in the dialog (rendered by the system's own fields/boolean partial — the
 * row label is the literal item name, which CPLocal passes through verbatim on a key miss), and the
 * checked rows' mods fold into the roll's `extraMod` — the system's always-present catch-all term —
 * so the roll math itself is untouched.
 *
 * A provider is ACTIVE when the item is equipped; cyberware must also pass cwIsEnabled (Activatable
 * implants apply only while EffectActive) and, for Chip-typed cyberware, ChipActive — the same gates
 * the base system's own payload engine uses. All functions are pure over plain item shapes.
 */

import { cwHasType, cwIsEnabled } from "../utils.js";

/** The item's roll-mods block when enabled, else null. Pure. */
export function rollModsOf(item) {
  const rm = item?.system?.mechRollMods;
  if (!rm?.enabled) return null;
  return rm;
}

/** True when the item's mods currently apply (equipped + cyberware/chip activation gates). Pure. */
export function isRollModActive(item) {
  if (!item?.system?.equipped) return false;
  if (item.type === "cyberware") {
    if (!cwIsEnabled(item)) return false;
    if (cwHasType(item, "Chip") && !item.system?.CyberWorkType?.ChipActive) return false;
  }
  return true;
}

/** Active RANGED-attack providers among `items`: [{ id, name, mod, auto, dualWieldOnly }]. Pure. */
export function attackModProviders(items) {
  const out = [];
  for (const it of items ?? []) {
    const rm = rollModsOf(it);
    const mod = Number(rm?.attackMod) || 0;
    if (!mod || !isRollModActive(it)) continue;
    out.push({ id: it.id ?? it._id, name: it.name, mod, auto: rm.auto !== false, dualWieldOnly: !!rm.dualWieldOnly });
  }
  return out;
}

/** Active providers for rolls of the STAT named `statName` (Q9, Photo Memory): [{ id, name, mod, auto }]. Pure. */
export function statModProviders(items, statName) {
  const want = String(statName ?? "").trim().toLowerCase();
  if (!want) return [];
  const out = [];
  for (const it of items ?? []) {
    const rm = rollModsOf(it);
    const mod = Number(rm?.statMod) || 0;
    const name = String(rm?.statName ?? "").trim().toLowerCase();
    if (!mod || name !== want || !isRollModActive(it)) continue;
    out.push({ id: it.id ?? it._id, name: it.name, mod, auto: rm.auto !== false });
  }
  return out;
}

/** Total unconditional Facedown bonus from active providers (Q9, Facedown Chip): { total, sources }. Pure. */
export function facedownModFor(items) {
  let total = 0;
  const sources = [];
  for (const it of items ?? []) {
    const rm = rollModsOf(it);
    const mod = Number(rm?.facedownMod) || 0;
    if (!mod || !isRollModActive(it)) continue;
    total += mod;
    sources.push({ name: it.name, mod });
  }
  return { total, sources };
}

/** Active providers for rolls of the skill named `skillName` (case-insensitive). Pure. */
export function skillModProviders(items, skillName) {
  const want = String(skillName ?? "").trim().toLowerCase();
  if (!want) return [];
  const out = [];
  for (const it of items ?? []) {
    const rm = rollModsOf(it);
    const mod = Number(rm?.skillMod) || 0;
    const name = String(rm?.skillName ?? "").trim().toLowerCase();
    if (!mod || name !== want || !isRollModActive(it)) continue;
    out.push({ id: it.id ?? it._id, name: it.name, mod, auto: rm.auto !== false });
  }
  return out;
}

/**
 * One Modifiers-dialog group (checkbox row per provider). The label is the literal item name plus
 * a signed "(+N)" — dynamic data, deliberately not localized (the martialOptions literal-choice
 * precedent); the dataPath is underscore-joined so FormDataExtended never dot-expands it. Pure.
 */
export function gearModGroup(providers) {
  return (providers ?? []).map(p => ({
    localKey: `${p.name} (${p.mod >= 0 ? "+" : ""}${p.mod})`,
    dataPath: `gearMod_${p.id}`,
    defaultValue: !!p.auto
  }));
}

/** Sum of the providers whose dialog checkbox came back ticked. Pure. */
export function gearModSum(options, providers) {
  let sum = 0;
  for (const p of providers ?? []) {
    if (options?.[`gearMod_${p.id}`]) sum += p.mod;
  }
  return sum;
}
