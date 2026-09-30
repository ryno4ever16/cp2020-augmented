/**
 * ATTACK-ROLL BREAKDOWN (user-relayed Discord request, 2026-09-30; RYNO: "I do prefer for math to not
 * look like a bunch of magic numbers").
 *
 * The base card prints "Attack: N" and the roll's bare terms ("9 + 3 + 0 + 0 + 0 + 0 + 0"). The damage
 * figure beside it explains itself on hover (the base's inline-roll anchor); the attack figure did not,
 * and the base builds that roll from plain numbers - dice.js `makeD10Roll` joins "@stats.ref.total",
 * "@attackSkill", the situational modifiers and "@weaponAccuracy" with no label on any term - so on a
 * vanilla host the only way to say what each number IS is to know how the base built it. That is what
 * this file knows, and it never guesses: the labels it derives are checked term by term against the
 * roll the card carries and against the total the card prints. If they do not reconcile, the card keeps
 * its bare numbers and no hover is drawn.
 *
 * Three pieces, in the order they run:
 *   buildAttackContext(item, attackMods, method)   at the trigger pull (seam-shim fireWrapper): the facts
 *       the labels need, read the way the base reads them (REF, the attack skill and its value, WA, the
 *       situational modifiers in the base's own order, and the parts the module folded into Extra
 *       Modifiers - see setExtraPart).
 *   attackBreakdownRows(roll, ctx, card)            at the card render (seam-shim renderWrapper): pairs
 *       the roll's numeric terms with the context, verifies, and returns the labelled rows or null.
 *   injectAttackBreakdown(html, breakdown)          writes the rows INTO the card's stored markup as an
 *       anchor on the Attack total, so every client - now or after a reload - draws the same hover.
 *   registerAttackBreakdownRender()                 the chat render pass: binds the hover and takes the
 *       zero terms off the visible line (RYNO, 2026-09-30: yes). They stay in the hover.
 *
 * The situational-modifier mirror below is the one coupling to the base: `rangedModRows` restates
 * item.js `__shootModTerms` (values and ORDER) and `meleeModRows` restates `__meleeModTerms`; the martial
 * formula (`__martialBonk`) is read positionally. The reconciliation is what makes that coupling safe -
 * a base that changes the order or a value produces a mismatch, and a mismatch produces nothing.
 */
import { localize, localizeParam, tryLocalize } from "../utils.js";
import { onChatCardRender } from "../chat-render-compat.js";
import { fireModes } from "../lookups.js";

export const ATTACK_ANCHOR_CLASS = "cp-attack-total";
export const ATTACK_DATA_ATTR = "data-cp-breakdown";
export const ZERO_TERM_CLASS = "cp-zero-term";
const TIP_CLASS = "cp-attack-tip";
const SCOPE = "cp2020-augmented";

// The base's range keys (base lookups.js `ranges`), as the attack modifiers carry them.
const RANGE_POINT_BLANK = "RangePointBlank";
const RANGE_CLOSE = "RangeClose";
const RANGE_MEDIUM = "RangeMedium";

/* ───────────────────────── the parts the dialog folded into Extra Modifiers ───────────────────────── */

/** dialog app → Map(key → {key, label, value}). The hooks that seed the Extra Modifiers field (the
 *  multi-action penalty, the declared dodge) record what they seeded here; the sheet's confirm collects
 *  it onto the attack modifiers as `cpExtraParts`. Keyed weakly on the dialog instance so a closed
 *  window takes its parts with it. */
const _extraParts = new WeakMap();
export function setExtraPart(app, key, label, value) {
  if (!app || typeof app !== "object") return;
  const m = _extraParts.get(app) ?? new Map();
  const v = Number(value) || 0;
  if (v === 0) m.delete(key);
  else m.set(key, { key: String(key), label: String(label ?? key), value: v });
  _extraParts.set(app, m);
}
export function extraPartsOf(app) {
  if (!app || typeof app !== "object") return [];
  return [...(_extraParts.get(app)?.values() ?? [])].map(p => ({ ...p }));
}

/* ───────────────────────── the context, captured at the trigger pull ───────────────────────── */

/** The situational modifiers of a RANGED attack, in the base's own order and with the base's own
 *  values (item.js `__shootModTerms`). Restated rather than called: the base method needs the item as
 *  `this` and pushes bare numbers; the order restated here is exactly what the reconciliation checks. */
function rangedModRows(attackMods = {}, sys = {}, item = null) {
  const rows = [];
  if (attackMods.targetArea) rows.push({ key: "targetArea", value: -4 });
  const aim = Number(attackMods.aimRounds) || 0;
  if (aim > 0) rows.push({ key: "aim", value: aim, rounds: aim });
  if (attackMods.ambush)        rows.push({ key: "ambush",    value: 5 });
  if (attackMods.blinded)       rows.push({ key: "blinded",   value: -3 });
  if (attackMods.dualWield)     rows.push({ key: "dualWield", value: -3 });
  if (attackMods.fastDraw)      rows.push({ key: "fastDraw",  value: -3 });
  if (attackMods.hipfire)       rows.push({ key: "hipfire",   value: -2 });
  if (attackMods.ricochet)      rows.push({ key: "ricochet",  value: -5 });
  if (attackMods.running)       rows.push({ key: "running",   value: -3 });
  if (attackMods.turningToFace) rows.push({ key: "turnFace",  value: -2 });
  if (attackMods.fireMode === fireModes.fullAuto) {
    // The base's own rounds resolver (a static on the item class), so the count is the one it used.
    const resolve = item?.constructor?._resolveFullAutoRounds;
    const bullets = typeof resolve === "function" ? Number(resolve.call(item.constructor, attackMods, sys)) || 0 : 0;
    const mult = attackMods.range === RANGE_CLOSE ? 1 : attackMods.range === RANGE_POINT_BLANK ? 0 : -1;
    rows.push({ key: "fullAuto", value: mult * Math.floor(bullets / 10), rounds: bullets });
  }
  if (attackMods.fireMode === fireModes.threeRoundBurst && (attackMods.range === RANGE_CLOSE || attackMods.range === RANGE_MEDIUM)) {
    rows.push({ key: "burst", value: 3 });
  }
  rows.push({ key: "extra", value: Number(attackMods.extraMod) || 0 });   // the base always pushes it
  return rows;
}

/** The MELEE modifiers (item.js `__meleeModTerms`): the called shot, and the extra term only when it
 *  is non-zero. */
function meleeModRows(attackMods = {}) {
  const rows = [];
  if (attackMods.targetArea) rows.push({ key: "targetArea", value: -4 });
  const n = Number(attackMods.extraMod);
  if (Number.isFinite(n) && n !== 0) rows.push({ key: "extra", value: n });
  return rows;
}

/** A skill key's display name, resolved the way the base resolves the skill itself (actor.js
 *  getSkillVal: `localize("Skill" + key)`); the raw key when no translation exists. */
function skillLabelFor(key) {
  const loc = tryLocalize("Skill" + key, "");
  return loc && !String(loc).includes("Skill") ? String(loc) : String(key);
}

/**
 * The facts the labels need, read at the trigger pull. `method` is the base fire method this pull went
 * through (`__semiAuto`, `__fullAuto`, `__threeRoundBurst`, `__meleeBonk`, `__martialBonk`).
 * Returns a plain object (it travels on the seam's fire context) or null when the item cannot answer.
 */
export function buildAttackContext(item, attackMods = {}, method = "") {
  try {
    const actor = item?.actor;
    const sys = item?._getWeaponSystem?.() ?? item?.system ?? {};
    const isRanged = item?.isRanged?.() ?? true;
    const martial = method === "__martialBonk";
    const skillKey = String(sys?.attackSkill ?? item?.system?.attackSkill ?? "");
    const parts = Array.isArray(attackMods?.cpExtraParts) ? attackMods.cpExtraParts : [];
    const ctx = {
      method, isRanged, martial,
      ref: Number(actor?.system?.stats?.ref?.total) || 0,
      wa: Number(sys?.accuracy) || 0,
      skillKey, skillVal: 0, skillLabel: "",
      mods: [],
      extraParts: parts.map(p => ({ key: String(p?.key ?? "part"), label: String(p?.label ?? p?.key ?? ""), value: Number(p?.value) || 0 })).filter(p => p.value !== 0),
      martialArt: String(attackMods?.martialArt ?? ""),
      martialAction: String(attackMods?.action ?? ""),
    };
    if (skillKey && !martial) {
      const v = Number(actor?.getSkillVal?.(skillKey));
      ctx.skillVal = Number.isFinite(v) ? v : 0;
      ctx.skillLabel = skillLabelFor(skillKey);
    }
    if (!martial) ctx.mods = isRanged ? rangedModRows(attackMods, sys, item) : meleeModRows(attackMods);
    return ctx;
  } catch (_e) {
    return null;
  }
}

/* ───────────────────────── the roll, read term by term ───────────────────────── */

/** The roll's numeric terms in order, each SIGNED by the operator before it ("- 3" and "+ -3" both
 *  read as -3). Works on live terms and on the plain objects a serialized roll carries. */
export function signedNumericTerms(roll) {
  const out = [];
  let sign = 1;
  for (const t of roll?.terms ?? []) {
    if (!t) continue;
    if (Array.isArray(t.results)) { sign = 1; continue; }                       // the die
    if (typeof t.operator === "string" && t.number === undefined) {              // an operator
      sign = t.operator.trim() === "-" ? -1 : 1;
      continue;
    }
    const n = Number(t.number);
    if (Number.isFinite(n)) { out.push(sign * n); sign = 1; }
  }
  return out;
}

/** The roll's die: faces, the active results (an exploded d10 carries several) and their sum. */
export function diceOf(roll) {
  const die = (roll?.terms ?? []).find(t => t && Array.isArray(t.results));
  if (!die) return null;
  const results = die.results.filter(r => r && r.active !== false).map(r => Number(r.result) || 0);
  return { faces: Number(die.faces) || 10, results, total: results.reduce((a, b) => a + b, 0) };
}

const LABEL_KEYS = {
  ref: "AttackBreakdownRef", wa: "AttackBreakdownWA", targetArea: "AttackBreakdownTargetArea",
  ambush: "AttackBreakdownAmbush", blinded: "AttackBreakdownBlinded", dualWield: "AttackBreakdownDualWield",
  fastDraw: "AttackBreakdownFastDraw", hipfire: "AttackBreakdownHipfire", ricochet: "AttackBreakdownRicochet",
  running: "AttackBreakdownRunning", turnFace: "AttackBreakdownTurnFace", burst: "AttackBreakdownBurst",
  keyTechnique: "AttackBreakdownKeyTechnique", extra: "AttackBreakdownExtra",
};
function labelFor(e) {
  switch (e.key) {
    case "skill":        return e.name || e.key;
    case "aim":          return localizeParam("AttackBreakdownAim", { rounds: e.rounds });
    case "fullAuto":     return localizeParam("AttackBreakdownFullAuto", { rounds: e.rounds });
    case "martialLevel": return localizeParam("AttackBreakdownMartialLevel", { art: e.art || localize("AttackBreakdownMartialArtUnknown") });
    case "actionBonus":  return localizeParam("AttackBreakdownActionBonus", { action: e.action });
    default:             return LABEL_KEYS[e.key] ? localize(LABEL_KEYS[e.key]) : String(e.key);
  }
}

/**
 * Pair the roll with the context and label it. Returns `{ rows, total, toHit, hit }` or null when the
 * terms do not reconcile (count, each value, and the total all have to agree). `card` is the card's
 * template data (toHit, hit) - optional.
 */
export function attackBreakdownRows(roll, ctx, card = {}) {
  if (!roll || !ctx) return null;
  const nums = signedNumericTerms(roll);
  const dice = diceOf(roll);
  if (!dice) return null;
  const total = Number(roll.total ?? roll._total);
  if (!Number.isFinite(total)) return null;
  let expected;
  if (ctx.martial) {
    // `1d10x10 + REF + art level + key technique + action bonus + extraMod + targetAreaMod (+ WA)`
    const withWa = ctx.wa !== 0;
    if (nums.length !== 6 + (withWa ? 1 : 0)) return null;
    if (nums[0] !== ctx.ref) return null;
    if (withWa && nums[6] !== ctx.wa) return null;
    const art = ctx.martialArt ? tryLocalize("Skill" + ctx.martialArt, tryLocalize(ctx.martialArt, ctx.martialArt)) : "";
    const action = ctx.martialAction ? tryLocalize(ctx.martialAction, ctx.martialAction) : "";
    expected = [
      { key: "ref", value: nums[0] }, { key: "martialLevel", value: nums[1], art },
      { key: "keyTechnique", value: nums[2] }, { key: "actionBonus", value: nums[3], action },
      { key: "extra", value: nums[4] }, { key: "targetArea", value: nums[5] },
    ];
    if (withWa) expected.push({ key: "wa", value: nums[6] });
  } else {
    expected = [{ key: "ref", value: ctx.ref }];
    if (ctx.skillKey) expected.push({ key: "skill", value: ctx.skillVal, name: ctx.skillLabel });
    for (const m of ctx.mods ?? []) expected.push({ ...m });
    if (ctx.wa !== 0) expected.push({ key: "wa", value: ctx.wa });
    if (expected.length !== nums.length) return null;
    for (let i = 0; i < nums.length; i++) if (nums[i] !== expected[i].value) return null;
  }
  const sum = dice.total + nums.reduce((a, b) => a + b, 0);
  if (sum !== total) return null;

  const rows = [{ key: "die", label: dice.results.length > 1
      ? localizeParam("AttackBreakdownDieExploded", { results: dice.results.join(" + ") })
      : localize("AttackBreakdownDie"), value: dice.total, die: true }];
  for (const e of expected) {
    if (e.key === "extra") {
      // The seeded parts, by name, then whatever the shooter typed (or typed OVER a seed) as the remainder.
      const parts = (ctx.extraParts ?? []).filter(p => p.value !== 0);
      if (parts.length) {
        const partsSum = parts.reduce((a, p) => a + p.value, 0);
        for (const p of parts) rows.push({ key: `extra:${p.key}`, label: p.label || p.key, value: p.value });
        const typed = e.value - partsSum;
        if (typed !== 0) rows.push({ key: "extra:typed", label: localize("AttackBreakdownExtraTyped"), value: typed });
      } else {
        rows.push({ key: "extra", label: localize("AttackBreakdownExtra"), value: e.value });
      }
      continue;
    }
    // The row keeps the detail its label was built from (rounds fired, the art, the action), so a
    // reader of the stored data has the number and not only the sentence.
    const row = { key: e.key, label: labelFor(e), value: e.value };
    for (const k of ["rounds", "art", "action", "name"]) if (e[k] !== undefined && e[k] !== "") row[k] = e[k];
    rows.push(row);
  }
  return {
    rows, total,
    toHit: Number.isFinite(Number(card?.toHit)) && card?.toHit !== undefined && card?.toHit !== null ? Number(card.toHit) : null,
    hit: typeof card?.hit === "boolean" ? card.hit : null,
  };
}

/* ───────────────────────── into the card's stored markup ───────────────────────── */

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Wrap the Attack total of a rendered multi-hit card in the breakdown anchor. The first match only -
 *  the card has one attack line. Unchanged when the line is not found. */
export function injectAttackBreakdown(html, breakdown) {
  if (typeof html !== "string" || !breakdown?.rows?.length) return html;
  const label = escapeRegExp(game.i18n.localize("CYBERPUNK.Attack"));
  const re = new RegExp(`(<span>${label}: <\\/span>\\s*<span>)(-?\\d+)(<\\/span>)`);
  if (!re.test(html)) return html;
  const json = escapeAttr(JSON.stringify(breakdown));
  const title = escapeAttr(localize("AttackBreakdownHint"));
  return html.replace(re, (_m, a, total, c) => `${a}<a class="${ATTACK_ANCHOR_CLASS}" title="${title}" ${ATTACK_DATA_ATTR}="${json}">${total}</a>${c}`);
}

/* ───────────────────────── the hover, on every client ───────────────────────── */

function fmt(v, signed = true) {
  const n = Number(v) || 0;
  if (!signed) return String(n);
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return "0";
}

function buildTip(data) {
  const tip = document.createElement("div");
  tip.className = `cp-dice-tooltip ${TIP_CLASS}`;
  const rowsEl = document.createElement("div");
  rowsEl.className = "cp-attack-tip-rows";
  for (const r of data.rows) {
    const row = document.createElement("div");
    row.className = `cp-attack-row${r.die ? " cp-attack-row-die" : ""}`;
    const l = document.createElement("span"); l.textContent = r.label;
    const v = document.createElement("span"); v.textContent = fmt(r.value, !r.die);
    row.append(l, v);
    rowsEl.append(row);
  }
  const tot = document.createElement("div");
  tot.className = "cp-attack-row cp-attack-row-total";
  const tl = document.createElement("span"); tl.textContent = localize("AttackBreakdownTotal");
  const tv = document.createElement("span"); tv.textContent = fmt(data.total, false);
  tot.append(tl, tv);
  rowsEl.append(tot);
  if (data.toHit !== null && data.toHit !== undefined) {
    const dc = document.createElement("div");
    dc.className = "cp-attack-row cp-attack-row-dc";
    const dl = document.createElement("span"); dl.textContent = localizeParam("AttackBreakdownVsToHit", { dc: data.toHit });
    const dv = document.createElement("span"); dv.textContent = data.hit === null ? "" : localize(data.hit ? "AttackBreakdownHit" : "AttackBreakdownMiss");
    dc.append(dl, dv);
    rowsEl.append(dc);
  }
  tip.append(rowsEl);
  return tip;
}

function positionTip(anchor, tip) {
  const r = anchor.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  let top = r.top - tr.height - 8;
  if (top < 4) top = r.bottom + 8;
  let left = r.left + (r.width / 2) - (tr.width / 2);
  left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
}

function bindHover(anchor, data) {
  let tip = null;
  const hide = () => { if (tip) { tip.remove(); tip = null; } };
  const show = () => {
    hide();
    tip = buildTip(data);
    document.body.appendChild(tip);
    positionTip(anchor, tip);
  };
  anchor.addEventListener("mouseenter", show);
  anchor.addEventListener("mouseleave", hide);
  anchor.addEventListener("pointerdown", hide);
  anchor.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); }, { capture: true });
}

/** Take the zero terms off the visible line: the "0" span and the operator span before it. Only the
 *  numeric spans - a die that rolled its face is never a zero, and never hidden. */
export function hideZeroTerms(resultsEl) {
  const spans = [...resultsEl.querySelectorAll(".roll-result.inactive")];
  let hidden = 0;
  for (let i = 0; i < spans.length; i++) {
    const t = spans[i].textContent.trim();
    if (t !== "0" && t !== "-0" && t !== "+0") continue;
    spans[i].classList.add(ZERO_TERM_CLASS); hidden++;
    const prev = spans[i - 1];
    if (prev && /^[+-]$/.test(prev.textContent.trim()) && !prev.classList.contains(ZERO_TERM_CLASS)) { prev.classList.add(ZERO_TERM_CLASS); hidden++; }
  }
  return hidden;
}

function _renderAttackBreakdown(_message, html) {
  const root = html instanceof HTMLElement ? html : (html?.[0] ?? null);
  if (!root?.querySelectorAll) return;
  for (const a of root.querySelectorAll(`a.${ATTACK_ANCHOR_CLASS}[${ATTACK_DATA_ATTR}]`)) {
    if (a.dataset.cpBound === "1") continue;
    a.dataset.cpBound = "1";
    let data = null;
    try { data = JSON.parse(a.getAttribute(ATTACK_DATA_ATTR)); } catch (_e) { continue; }
    if (!Array.isArray(data?.rows) || !data.rows.length) continue;
    // Zeros leave the visible line only where a breakdown exists to explain them.
    const results = a.closest(".field")?.querySelector(".roll-results");
    if (results) hideZeroTerms(results);
    bindHover(a, data);
  }
}

/** Registered through onChatCardRender so the log's first scrollback batch (rendered before `ready`)
 *  gets the hover too - the same reason the apply control and the card lock register that way. */
export function registerAttackBreakdownRender() {
  onChatCardRender(_renderAttackBreakdown);
}
