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

import { cwHasType, cwIsEnabled, getSkillsPackNames } from "../utils.js";

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

const _skillAliasCache = new Map();

/** EN-skill-name → active-language-skill-name alias map, joined on the stable compendium _id, so a
 *  provider's canonical-EN `skillName` (pack data) still matches a localized skill item's displayed
 *  name. Read-only, synchronous over the already-loaded pack indices (reuses the base pack-discovery
 *  helper getSkillsPackNames); EN worlds short-circuit to empty (exact match already works). Returns
 *  an empty map if indices aren't loaded yet — the caller then just falls back to the exact match. */
function _buildSkillAliasMap(lang) {
  const alias = new Map();
  try {
    if (String(lang).toLowerCase().startsWith("en")) return alias;
    const nameById = (packNames) => {
      const m = new Map();
      for (const pn of packNames ?? []) {
        const idx = game.packs?.get?.(pn)?.index;
        if (!idx) continue;
        for (const e of idx) if (e?._id && e?.name) m.set(e._id, String(e.name).trim().toLowerCase());
      }
      return m;
    };
    const enById = nameById(getSkillsPackNames("en"));
    const locById = nameById(getSkillsPackNames(lang));
    for (const [id, en] of enById) {
      const loc = locById.get(id);
      if (loc && loc !== en) alias.set(en, loc);
    }
  } catch (e) { /* compendium indices not ready — exact match only */ }
  return alias;
}

/** Memoized per active language (skill packs don't change mid-session). A transient empty result
 *  before indices finish loading is NOT cached, so it self-heals once the compendium is ready. */
function _skillAliasMap() {
  const lang = String(game?.i18n?.lang || "en");
  const cached = _skillAliasCache.get(lang);
  if (cached) return cached;
  const alias = _buildSkillAliasMap(lang);
  if (alias.size || lang.toLowerCase().startsWith("en")) _skillAliasCache.set(lang, alias);
  return alias;
}

/** Active providers for rolls of the skill named `skillName` (case-insensitive). Pure over `items`
 *  (the alias map is read once per call, not per item). */
export function skillModProviders(items, skillName) {
  const want = String(skillName ?? "").trim().toLowerCase();
  if (!want) return [];
  // A provider's skillName is canonical-EN pack data; the rolled skill item's name is localized.
  // Match on either the exact (case-folded) name OR the EN name's active-language alias.
  const alias = _skillAliasMap();
  const matches = (providerSkillName) => {
    const n = String(providerSkillName ?? "").trim().toLowerCase();
    return !!n && (n === want || alias.get(n) === want);
  };
  const out = [];
  for (const it of items ?? []) {
    const rm = rollModsOf(it);
    if (!rm || !isRollModActive(it)) continue;
    const id = it.id ?? it._id;
    const auto = rm.auto !== false;
    const mod = Number(rm.skillMod) || 0;
    if (mod && matches(rm.skillName)) out.push({ id, name: it.name, mod, auto });
    // The skillMods list (multi-skill items): one row per matching entry, sharing the item's auto.
    // Each row gets its OWN provider id (item id + entry ordinal): the dialog's checkbox dataPath
    // is gearMod_<id>, so a list entry sharing the flat pair's id would collide with its row.
    for (const [i, e] of (rm.skillMods ?? []).entries()) {
      const emod = Number(e?.mod) || 0;
      if (emod && matches(e?.skillName)) out.push({ id: `${id}-${i + 1}`, name: it.name, mod: emod, auto });
    }
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
