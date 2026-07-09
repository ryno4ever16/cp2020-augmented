/**
 * Q2 — Chip skill grants (SPECIAL-MECHANICS-PROPOSAL.md §3b): chips work UNTRAINED.
 *
 * The base system's chip engine only OVERRIDES a skill the actor already HAS (actor.js: an active
 * chip's ChipSkills sets that skill item's chipLevel/isChipped so realSkillValue returns the chip
 * level). RAW says a skill chip works even for a skill you never learned — so when an active chip
 * names a skill the actor LACKS, this engine CREATES that skill item at natural level 0, flagged
 * chip-granted; the base override then drives its effective value while the chip is active. On
 * deactivate (or chip removal), a chip-granted skill the player never trained (natural level 0,
 * no longer granted by any active chip) is deleted; one the player HAS since trained keeps its
 * points and just loses the flag.
 *
 * Parameterized chips (Language / Martial Art "choose") carry a `(choose)` / `(choose:Category)`
 * ChipSkills key. On first activation the engine prompts for the actual skill and REWRITES that
 * key to the chosen name on the owned chip copy (so the base override, which reads the raw
 * ChipSkills names, can drive it) — the original spec is stashed in a flag so a reset control can
 * restore it.
 *
 * Ownership: embedded skill items are the player's own actor data, so the INITIATING client (the
 * one that toggled ChipActive) that owns the actor performs the writes — no GM relay, no socket
 * (mirrors the consumable engine's initiating-client gate, not the token engines' active-GM gate).
 *
 * Pure helpers are exported for the rig spec; hooks are wired by registerMechChipGrant().
 */

import { cwHasType, cwIsEnabled, localize, localizeParam } from "../utils.js";

const SCOPE = "cp2020-augmented";
const GRANTED_FLAG = "chipGranted";       // on the SKILL item: true when this engine created it
const ORIGINAL_FLAG = "chipChooseOriginal"; // on the CHIP item: the pre-resolution ChipSkills map

/** Escape a string for an HTML attribute (not every core exposes foundry.utils.escapeHTML). */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** REPLACE (not merge) the chip's ChipSkills map. `update` deep-merges an ObjectField, so a plain
 *  `{ChipSkills: next}` update keeps stale keys (e.g. the resolved "(choose)" marker) — delete the
 *  whole object first, then set it fresh. Keys carry colons/spaces (skill names), which the `-=`
 *  per-key deletion path can't express cleanly, so the whole-object swap is the robust route. */
async function replaceChipSkills(chipItem, next) {
  await chipItem.update({ "system.CyberWorkType.-=ChipSkills": null });
  await chipItem.update({ "system.CyberWorkType.ChipSkills": foundry.utils.deepClone(next) });
}

/** A ChipSkills key parsed as a choose-marker: { choose, category } (category "" = any). Pure. */
export function parseChooseKey(key) {
  const m = /^\(choose(?::\s*([^)]+))?\)$/i.exec(String(key ?? "").trim());
  if (!m) return { choose: false, category: "" };
  return { choose: true, category: (m[1] ?? "").trim() };
}

/** Is this cyberware an ACTIVE chip (equipped + enabled + Chip type + ChipActive)? Pure. */
export function isActiveChip(item) {
  return item?.type === "cyberware"
    && cwHasType(item, "Chip")
    && cwIsEnabled(item)
    && !!item.system?.equipped
    && !!item.system?.CyberWorkType?.ChipActive;
}

/** The unresolved choose-keys on a chip's ChipSkills: [{ key, category, level }]. Pure. */
export function unresolvedChooseKeys(item) {
  const skills = item?.system?.CyberWorkType?.ChipSkills ?? {};
  const out = [];
  for (const [key, lvl] of Object.entries(skills)) {
    const parsed = parseChooseKey(key);
    if (parsed.choose) out.push({ key, category: parsed.category, level: Number(lvl) || 0 });
  }
  return out;
}

/** RESOLVED skill grants (name → max level) across all active chips, skipping choose-markers. Pure. */
export function resolvedGrantsFor(items) {
  const out = {};
  for (const it of items ?? []) {
    if (!isActiveChip(it)) continue;
    for (const [key, lvl] of Object.entries(it.system?.CyberWorkType?.ChipSkills ?? {})) {
      if (parseChooseKey(key).choose) continue;
      const n = Number(lvl) || 0;
      if (!n) continue;
      out[key] = Math.max(out[key] ?? 0, n);
    }
  }
  return out;
}

/** True when the actor has a skill item of this exact name. Pure. */
export function actorHasSkill(items, name) {
  return (items ?? []).some(it => it?.type === "skill" && it.name === name);
}

/** Skill names still granted by SOME active chip (the deactivate keep-set). Pure. */
export function stillGrantedNames(items) {
  return new Set(Object.keys(resolvedGrantsFor(items)));
}

/** True when THIS client should perform the grant writes: it initiated the change and owns the actor. */
function iAmTheGranter(actor, userId) {
  return userId === game.user?.id && !!actor?.isOwner;
}

/**
 * Prompt for the skill a choose-chip grants. Returns the chosen name (string) or null (cancelled).
 * A datalist of category-matching default skills + the actor's own matching skills seeds it; the
 * player may pick one or type a freeform name (e.g. a specific language). Impure (dialog + index).
 */
export async function promptChooseSkill(actor, category) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  const suggestions = await chooseSuggestions(actor, category);
  const listId = `cp-chip-choose-${foundry.utils.randomID()}`;
  const catLabel = category ? localizeParam("ChipChooseForCategory", { category }) : localize("ChipChooseAny");
  const content = `<div class="cp-chip-choose"><p>${catLabel}</p>`
    + `<input type="text" name="skill" list="${listId}" style="width:100%" autofocus />`
    + `<datalist id="${listId}">${suggestions.map(s => `<option value="${esc(s)}"></option>`).join("")}</datalist></div>`;
  if (!DialogV2) return null;
  const chosen = await DialogV2.prompt({
    window: { title: localize("ChipChooseTitle") },
    content,
    ok: {
      label: localize("ChipChooseConfirm"),
      callback: (_ev, button) => String(button.form.elements.skill?.value ?? "").trim()
    },
    rejectClose: false
  }).catch(() => null);
  return chosen || null;
}

/** Category-matching skill-name suggestions for the picker (default skills + actor's own). */
async function chooseSuggestions(actor, category) {
  const names = new Set();
  for (const it of actor?.items ?? []) if (it?.type === "skill") names.add(it.name);
  try {
    const pack = game.packs?.get("cyberpunk2020.default-skills-en") ?? game.packs?.get("cyberpunk2020.default-skills");
    if (pack) {
      const idx = await pack.getIndex();
      for (const e of idx) names.add(e.name);
    }
  } catch (_e) { /* index unavailable — the actor's own skills still seed it */ }
  const cat = String(category ?? "").trim().toLowerCase();
  const all = [...names];
  if (!cat) return all.sort();
  // "Martial Art" → the "Martial Arts: X" family; other categories → name-substring match.
  const needle = cat === "martial art" ? "martial arts" : cat;
  const matched = all.filter(n => n.toLowerCase().includes(needle));
  return (matched.length ? matched : all).sort();
}

/**
 * Resolve a chip's choose-keys by prompting, rewriting ChipSkills to the chosen names on the owned
 * copy, and stashing the original map so a reset can restore it. Returns true if it resolved (or
 * had nothing to resolve), false if the player cancelled a prompt (activation should roll back).
 */
export async function resolveChooseKeys(chipItem) {
  const pending = unresolvedChooseKeys(chipItem);
  if (!pending.length) return true;
  const original = foundry.utils.deepClone(chipItem.system?.CyberWorkType?.ChipSkills ?? {});
  const next = { ...original };
  for (const { key, category, level } of pending) {
    const chosen = await promptChooseSkill(chipItem.actor, category);
    if (!chosen) return false;                 // cancelled → leave the chip unresolved
    delete next[key];
    next[chosen] = Math.max(Number(next[chosen]) || 0, level);
  }
  if (chipItem.getFlag(SCOPE, ORIGINAL_FLAG) === undefined) {
    await chipItem.setFlag(SCOPE, ORIGINAL_FLAG, original);
  }
  await replaceChipSkills(chipItem, next);
  return true;
}

/** Restore a resolved choose-chip to its pre-choice ChipSkills (the item-sheet reset control):
 *  deactivate it (so a fresh choice is prompted on the next activation), restore the "(choose)"
 *  markers, drop the stash, and prune the now-orphaned granted skill. */
export async function resetChipChoice(chipItem) {
  const original = chipItem?.getFlag?.(SCOPE, ORIGINAL_FLAG);
  if (original === undefined) return false;
  await chipItem.update({
    "system.CyberWorkType.ChipActive": false,
    [`flags.${SCOPE}.-=${ORIGINAL_FLAG}`]: null
  });
  await replaceChipSkills(chipItem, original);
  if (chipItem.actor) await pruneGrantedSkills(chipItem.actor);
  return true;
}

/** Build a new skill item's data for `name`: copy a matching default skill (correct stat/diffMod)
 *  or a neutral generic (stat int) — flagged chip-granted. Impure (pack lookup). */
async function grantedSkillData(actor, name) {
  let base = { level: 0, chipLevel: 0, ip: 0, diffMod: 1, isChipped: false, isRoleSkill: false, stat: "int", flavor: "", notes: "" };
  try {
    const pack = game.packs?.get("cyberpunk2020.default-skills-en") ?? game.packs?.get("cyberpunk2020.default-skills");
    const idx = pack ? await pack.getIndex() : null;
    const hit = idx?.find(e => e.name === name);
    if (hit) {
      const doc = await pack.getDocument(hit._id);
      base = { ...foundry.utils.deepClone(doc.system), level: 0, chipLevel: 0, isChipped: false, ip: 0 };
    }
  } catch (_e) { /* fall back to the generic */ }
  return { name, type: "skill", system: base, flags: { [SCOPE]: { [GRANTED_FLAG]: true } } };
}

/** Create skill items for resolved grants the actor lacks (idempotent). */
async function grantMissingSkills(actor) {
  const items = actor.items?.contents ?? actor.items ?? [];
  const grants = resolvedGrantsFor(items);
  const toCreate = [];
  for (const name of Object.keys(grants)) {
    if (!actorHasSkill(items, name)) toCreate.push(await grantedSkillData(actor, name));
  }
  if (toCreate.length) await actor.createEmbeddedDocuments("Item", toCreate);
}

/** Delete / unflag chip-granted skills no longer granted by any active chip (idempotent). */
async function pruneGrantedSkills(actor) {
  const items = actor.items?.contents ?? actor.items ?? [];
  const keep = stillGrantedNames(items);
  const toDelete = [];
  const toUnflag = [];
  for (const it of items) {
    if (it.type !== "skill") continue;
    if (!it.getFlag?.(SCOPE, GRANTED_FLAG)) continue;
    if (keep.has(it.name)) continue;                        // still granted → leave it
    if ((Number(it.system?.level) || 0) > 0) toUnflag.push(it.id);  // trained → keep, drop flag
    else toDelete.push(it.id);                              // untrained → remove
  }
  if (toDelete.length) await actor.deleteEmbeddedDocuments("Item", toDelete);
  for (const id of toUnflag) await actor.items.get(id)?.unsetFlag(SCOPE, GRANTED_FLAG);
}

/** Full pass: create missing grants + prune orphans. Owner/initiating-client only. */
export async function applyChipGrants(actor) {
  if (!actor) return;
  await grantMissingSkills(actor);
  await pruneGrantedSkills(actor);
}

/** Did this item update flip ChipActive? Returns "on" | "off" | null. */
function chipActiveChange(changes) {
  const v = foundry.utils.getProperty(changes ?? {}, "system.CyberWorkType.ChipActive");
  return v === true ? "on" : v === false ? "off" : null;
}

/** Active chips on the actor, excluding `exceptId` (the one being toggled). Pure. */
export function activeChipCount(actor, exceptId = null) {
  const items = actor?.items?.contents ?? actor?.items ?? [];
  return items.filter((i) => (i.id ?? i._id) !== exceptId && isActiveChip(i)).length;
}

export function registerMechChipGrant() {
  // The book's running cap: "You may 'run' as many separate chip programs at one time as your
  // current INT stat" (Core p.82). An activation past the cap is refused on the initiating
  // client, with a confirm that re-issues the same update as an override — so the limit is one
  // click to accept and one click to wave through.
  Hooks.on("preUpdateItem", (item, changes, options, userId) => {
    if (userId !== game.user.id) return;
    if (options?.cp2020ChipCapOverride) return;
    if (chipActiveChange(changes) !== "on") return;
    if (item.type !== "cyberware" || !cwHasType(item, "Chip")) return;
    const actor = item.actor;
    if (!actor?.system?.stats) return;
    const cap = Number(actor.system.stats.int?.total);
    if (!Number.isFinite(cap) || cap <= 0) return;   // no honest INT value → no cap to enforce
    const running = activeChipCount(actor, item.id);
    if (running < cap) return;
    const redo = foundry.utils.deepClone(changes);
    (async () => {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: localize("ChipCapTitle") },
        content: `<p>${localizeParam("ChipCapBody", { name: item.name, cap, count: running })}</p>`,
        rejectClose: false,
      });
      if (ok) await item.update(redo, { cp2020ChipCapOverride: true }).catch(() => {});
    })();
    return false;
  });

  Hooks.on("updateItem", async (item, changes, options, userId) => {
    const change = chipActiveChange(changes);
    if (!change) return;
    if (item.type !== "cyberware" || !cwHasType(item, "Chip")) return;
    const actor = item.actor;
    if (!actor || !iAmTheGranter(actor, userId)) return;
    if (change === "on") {
      // Resolve any choose-markers first; a cancelled prompt rolls the activation back.
      const resolved = await resolveChooseKeys(item);
      if (!resolved) { await item.update({ "system.CyberWorkType.ChipActive": false }).catch(() => {}); return; }
    }
    await applyChipGrants(actor);
  });

  // A chip removed while active: prune the skills it granted.
  Hooks.on("deleteItem", async (item, options, userId) => {
    if (item.type !== "cyberware" || !cwHasType(item, "Chip")) return;
    const actor = item.actor;
    if (!actor || !iAmTheGranter(actor, userId)) return;
    await pruneGrantedSkills(actor);
  });

  // A chip imported already-active (e.g. a pre-configured drop) should grant on arrival.
  Hooks.on("createItem", async (item, options, userId) => {
    if (!isActiveChip(item)) return;
    const actor = item.actor;
    if (!actor || !iAmTheGranter(actor, userId)) return;
    if (unresolvedChooseKeys(item).length) return;   // choose-chips resolve on an explicit toggle
    await applyChipGrants(actor);
  });
}
