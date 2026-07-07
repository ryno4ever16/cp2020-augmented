/**
 * Status visibility (SPECIAL-MECHANICS-PROPOSAL.md §3c — the approved hybrid's data layer).
 *
 * ONE aggregator answers "what is influencing this actor right now": lit emitters, active vision
 * devices, worn protections, running consumable timers, active chip overrides, stat/skill payload
 * sources, and roll-mod providers. The actor sheet renders the rows as a status strip + item-row
 * badges and builds the stat tooltips from the contribution breakdown. Passive like
 * mech/protection.js: no hooks, no writes — pure functions over the actor's items (plus the timer
 * flag), each mirroring the ACTIVITY GATE of the engine it reports on, so a row exists exactly
 * when the influence is live.
 *
 * Rows carry MECHANISM data (kind, numbers, canonical names); the sheet localizes at the render
 * edge. `togglePath` is the boolean system path whose `false` switches the influence off — null
 * when there is no honest quick-off (permanent implants, timers). The quick-toggle convention
 * (§3c semantics defaults): misc → unequip; Activatable cyberware → EffectActive; chips →
 * ChipActive; permanent implants → display-only.
 */

import { cwHasType, cwIsEnabled } from "../utils.js";
import { isEmitting, lightProfileOf } from "./light.js";
import { isViewing, visionProfileOf, desiredVisionFor } from "./vision.js";
import { protectionEntryOf } from "./protection.js";
import { rollModsOf, isRollModActive } from "./roll-mods.js";

const SCOPE = "cp2020-augmented";
const TIMER_FLAG = "consumableState";
const HAZARDS = ["gas", "flash", "sonic"];

/** The boolean system path a strip toggle should set to false, or null (display-only). Pure. */
export function quickTogglePathOf(item) {
  if (item?.type === "misc") return "system.equipped";
  if (item?.type === "cyberware") {
    if (cwHasType(item, "Chip")) return "system.CyberWorkType.ChipActive";
    if (item.system?.EffectMode === "Activatable") return "system.EffectActive";
    return null;
  }
  return "system.equipped";
}

/** Lit emitters (mirrors light.js isEmitting). Pure. */
export function lightRows(items) {
  const out = [];
  for (const it of items ?? []) {
    if (!isEmitting(it)) continue;
    const p = lightProfileOf(it);
    out.push({
      itemId: it.id ?? it._id, kind: "light", name: it.name,
      detail: { range: Math.max(p.bright, p.dim), shape: p.shape },
      togglePath: "system.mechLight.on"
    });
  }
  return out;
}

/** Active vision devices; `governs` marks the one whose profile wins (vision.js rule). Pure. */
export function visionRows(items) {
  const list = (items ?? []).filter(isViewing);
  const governor = desiredVisionFor(list);
  return list.map(it => {
    const p = visionProfileOf(it);
    return {
      itemId: it.id ?? it._id, kind: "vision", name: it.name,
      detail: { mode: p.mode, range: p.range, governs: !!governor && p.mode === governor.mode && p.range === governor.range },
      togglePath: "system.mechVision.on"
    };
  });
}

/** Worn protections (mirrors protection.js: equipped + enabled + any hazard entry). Pure. */
export function protectionRows(items) {
  const out = [];
  for (const it of items ?? []) {
    if (!it?.system?.equipped) continue;
    const hazards = [];
    for (const h of HAZARDS) {
      const e = protectionEntryOf(it, h);
      if (e) hazards.push({ hazard: h, immune: e.immune, mod: e.mod });
    }
    if (!hazards.length) continue;
    out.push({
      itemId: it.id ?? it._id, kind: "protection", name: it.name,
      detail: { hazards },
      // Unequip is honest for worn gear; uninstalling cyberware is not a quick action (§3c).
      togglePath: it.type === "misc" ? "system.equipped" : null
    });
  }
  return out;
}

/** Running consumable timers (the mech/consumable.js marker flag). Display-only. */
export function timerRows(actor) {
  const raw = actor?.getFlag?.(SCOPE, TIMER_FLAG) ?? actor?.flags?.[SCOPE]?.[TIMER_FLAG];
  const markers = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return markers.map(m => ({
    itemId: m.itemId, kind: "timer", name: m.name,
    detail: { turnsLeft: Number(m.turnsLeft) || 0, note: m.note ?? "" },
    togglePath: null
  }));
}

/** Active chip overrides (the base engine's gate: Chip + cwIsEnabled + ChipActive). Pure. */
export function chipRows(items, resolveSkillName) {
  const out = [];
  for (const it of items ?? []) {
    if (it?.type !== "cyberware" || !cwHasType(it, "Chip")) continue;
    if (!cwIsEnabled(it) || !it.system?.CyberWorkType?.ChipActive) continue;
    const skills = [];
    for (const [key, lvl] of Object.entries(it.system?.CyberWorkType?.ChipSkills ?? {})) {
      const n = Number(lvl) || 0;
      if (!n) continue;
      skills.push({ name: resolveSkillName?.(key) ?? key, level: n });
    }
    out.push({
      itemId: it.id ?? it._id, kind: "chip", name: it.name,
      detail: { skills },
      togglePath: "system.CyberWorkType.ChipActive"
    });
  }
  return out;
}

/** Stat payload sources (the base engine's gate: equipped + enabled + Characteristic + Stat). Pure. */
export function statRows(items) {
  const out = [];
  for (const it of items ?? []) {
    if (it?.type !== "cyberware" || !it.system?.equipped) continue;
    if (!cwIsEnabled(it) || !cwHasType(it, "Characteristic")) continue;
    const stats = [];
    for (const [stat, val] of Object.entries(it.system?.CyberWorkType?.Stat ?? {})) {
      const n = Number(val) || 0;
      if (n) stats.push({ stat, mod: n });
    }
    if (!stats.length) continue;
    out.push({
      itemId: it.id ?? it._id, kind: "stat", name: it.name,
      detail: { stats },
      togglePath: quickTogglePathOf(it)
    });
  }
  return out;
}

/** Skill payload sources (base `_getCharacteristicSkillMod` gate; keys are skill ids or names). Pure. */
export function skillRows(items, resolveSkillName) {
  const out = [];
  for (const it of items ?? []) {
    if (it?.type !== "cyberware" || !it.system?.equipped) continue;
    if (!cwIsEnabled(it) || !cwHasType(it, "Characteristic")) continue;
    const skills = [];
    for (const [key, val] of Object.entries(it.system?.CyberWorkType?.Skill ?? {})) {
      const n = Number(val) || 0;
      if (n) skills.push({ name: resolveSkillName?.(key) ?? key, mod: n });
    }
    if (!skills.length) continue;
    out.push({
      itemId: it.id ?? it._id, kind: "skill", name: it.name,
      detail: { skills },
      togglePath: quickTogglePathOf(it)
    });
  }
  return out;
}

/** Roll-mod providers (mirrors roll-mods.js isRollModActive + non-empty mods). Pure. */
export function rollModRows(items) {
  const out = [];
  for (const it of items ?? []) {
    const rm = rollModsOf(it);
    if (!rm || !isRollModActive(it)) continue;
    const attackMod = Number(rm.attackMod) || 0;
    const skillMod = Number(rm.skillMod) || 0;
    const skillName = String(rm.skillName ?? "").trim();
    if (!attackMod && !(skillMod && skillName)) continue;
    out.push({
      itemId: it.id ?? it._id, kind: "roll", name: it.name,
      detail: { attackMod, skillName, skillMod },
      togglePath: quickTogglePathOf(it)
    });
  }
  return out;
}

/**
 * Every active influence on the actor, in stable kind order. `resolveSkillName` maps a skill-item
 * id to its name (payload Skill/ChipSkills keys may be either — the base engine's own fallback).
 */
export function activeInfluencesFor(actor) {
  const items = actor?.items?.contents ?? actor?.items ?? [];
  const resolveSkillName = (key) => {
    const byId = actor?.items?.get?.(key);
    return byId?.type === "skill" ? byId.name : key;
  };
  return [
    ...lightRows(items),
    ...visionRows(items),
    ...protectionRows(items),
    ...timerRows(actor),
    ...chipRows(items, resolveSkillName),
    ...statRows(items),
    ...skillRows(items, resolveSkillName),
    ...rollModRows(items)
  ];
}

/**
 * Named contribution breakdown for one PREPARED stat — the parts the base data prep composed into
 * `total` (base + temp + per-item cyberware + encumbrance/penalties + wounds + humanity loss),
 * with any residual reported as "other" so the tooltip never lies if the base math grows a new
 * term. Reads prepared actor data; returns [{ kind, name?, value }].
 */
export function statContributionsFor(actor, key) {
  const stat = actor?.system?.stats?.[key];
  if (!stat) return [];
  const parts = [{ kind: "base", value: Number(stat.base) || 0 }];
  const temp = Number(stat.tempMod) || 0;
  if (temp) parts.push({ kind: "temp", value: temp });

  const items = actor?.items?.contents ?? actor?.items ?? [];
  for (const it of items) {
    if (it?.type !== "cyberware" || !it.system?.equipped || !cwIsEnabled(it)) continue;
    if (cwHasType(it, "Characteristic")) {
      const n = Number(it.system?.CyberWorkType?.Stat?.[key]) || 0;
      if (n) parts.push({ kind: "item", name: it.name, value: n });
    }
    if (cwHasType(it, "Armor")) {
      const p = Number(it.system?.CyberWorkType?.Penalties?.[key]) || 0;
      if (p) parts.push({ kind: "item", name: it.name, value: -p });
    }
  }

  if (key === "ref") {
    const enc = Number(stat.armorMod) || 0;
    if (enc) parts.push({ kind: "encumbrance", value: enc });
  }
  const wound = Number(stat.woundMod) || 0;
  if (wound) parts.push({ kind: "wounds", value: wound });
  if (key === "emp") {
    const hl = Number(actor?.system?.stats?.emp?.humanity?.loss) || 0;
    const empLoss = Math.floor(hl / 10);
    if (empLoss) parts.push({ kind: "humanity", value: -empLoss });
  }

  const named = parts.reduce((s, p) => s + p.value, 0);
  const residual = (Number(stat.total) || 0) - named;
  if (residual) parts.push({ kind: "other", value: residual });
  return parts;
}
