/**
 * damage-breakdown.js — THE ONE RENDERER FOR "WHERE DID THAT NUMBER COME FROM".
 *
 * ⭐⭐ WHY THIS FILE EXISTS (user ruling 2026-08-28, option A on the area-card transparency question):
 * *each caught figure's row on the spread and blast resolution cards gains a collapsed per-figure
 * breakdown rendered by the SAME builder the Apply Damage window uses.* The emphasis is the whole point.
 * The Apply window has had an expandable math line since the layering pass — roll, each armour layer by
 * the item's own name, the proportional table's layering bonus, any armour multiplier, cover as the
 * outermost layer, the AP halving, BTM, final — and the AREA cards had nothing: a corridor of shells or
 * a detonation printed a rolled number per figure and the applied result appeared elsewhere, with no
 * statement of what happened in between. A reader could not tell a soaked hit from a bad roll.
 *
 * ⛔ ONE SITE, NOT A COPY. The obvious alternative — build the same rows again in the card builder —
 * is the defect this project keeps closing: two derivations of one fact drift, and a card that
 * contradicts the window is worse than a card that says nothing. So the assembly moved OUT of
 * `DamageDialog._breakdownRows` and into this function, the window calls it, and the card builders call
 * it. The window's own rendering is unchanged by construction: its method is now one line long and this
 * body is what stood in it.
 *
 * ⛔ AND THE DATA IS ONE SITE TOO. The `breakdown` object these rows are made from is built by
 * `DamageApplicator` — by BOTH of its resolvers, from one shared assembly (`hitBreakdown` there) — so
 * the window's preview rows and the apply loop's own results describe the same arithmetic. That is what
 * makes the card's numbers equal to what the pipeline applied rather than a second opinion about it.
 *
 * THIS FILE IS THE RENDER EDGE: every label here is localized, and the resolver that produces the data
 * stays i18n-free. It imports nothing but the localizers and the net-damage rule, so a chat-card builder
 * may call it without dragging the apply window's application class along behind it.
 */

import { localize, localizeParam } from "../utils.js";
import { computeNetDamage } from "./DamageApplicator.js";

/**
 * Turn one hit's structural breakdown into the labelled label/value pairs the expandable math line
 * renders. Every component is named: armor pieces by the item's own name, the cover object by its
 * label, the borg chassis by a localized stand-in — the whole point of the line is that the SP column
 * stops being one opaque number and says what made it.
 *
 * The order IS the arithmetic, top to bottom: roll → each armor layer → the layering bonus the
 * proportional table grants → any armor multiplier → combined armor → cover → effective SP → the
 * AP halving → the subtraction → the penetrating multiplier → a GM override if there was one →
 * BTM → final. Steps that did not happen emit no row, so an unarmoured hit with no cover shows
 * three lines rather than twelve.
 *
 * @param {object} hit            one resolver/apply result row — carries `breakdown`, and `coverChew`
 *                                when the round was shot through a valued object
 * @param {number} btm            the body's own toughness modifier
 * @param {number} afterSP        the after-SP value in force (the GM's override when there was one)
 * @param {boolean} overridden    whether that value was typed rather than derived
 * @param {boolean} [sdp]         whether this row lands in a machine zone's structure rather than flesh;
 *                                defaults to the row's own flag under EITHER of the two names the two
 *                                resolvers give it (`sdp` in the sync preview, `cyberlimb` in the apply)
 * @returns {Array<{label:string, value:string, drain:boolean}>}
 */
export function damageBreakdownRows(hit, btm, afterSP, overridden, sdp = undefined) {
  const b = hit?.breakdown;
  if (!b) return [];
  // ⚠ THE TWO RESOLVERS NAME THIS FLAG DIFFERENTLY and always have (DamageApplicator: `sdp` on the sync
  // preview row, `cyberlimb` on the apply row). Read both rather than renaming either — the names are
  // load-bearing at their own call sites — so one renderer answers for a row from either path.
  const machineZone = (sdp === undefined) ? !!(hit.sdp ?? hit.cyberlimb) : !!sdp;
  const rows = [];
  const add = (label, value, kind = "") => rows.push({ label, value, drain: kind === "drain" });
  const spTag = (n) => `[${n}]`;

  add(localize("DamageDlgBdRoll"), String(b.raw));
  for (const layer of b.layers) add(layer.chassis ? localize("DamageDlgBdChassis") : layer.name, spTag(layer.sp));
  if (b.layers.length > 1) add(localize("DamageDlgBdLayerBonus"), `+${b.layerBonus}`);
  if (b.armorMult !== 1) add(localize("DamageDlgBdArmorMult"), `×${b.armorMult}`);
  if (b.layers.length) add(localize("DamageDlgBdArmorSp"), String(b.armorSP));
  if (b.coverSP > 0) add(b.coverName || localize("DamageDlgBdCover"), spTag(b.coverSP));
  if (b.coverSP > 0 && b.armorSP > 0) add(localize("DamageDlgBdEffectiveSp"), String(b.effectiveSP));
  if (b.apHalved) add(localize("DamageDlgBdApHalf"), String(b.spUsed));
  add(localize("DamageDlgBdAfterSp"), b.penetrates ? String(b.afterSPRaw) : localize("DamageDlgBdStopped"));
  if (b.penetrates && b.penMult !== 1) add(localizeParam("DamageDlgBdPenMult", { mult: b.penMult }), String(b.afterSP));
  if (overridden) add(localize("DamageDlgBdOverride"), String(afterSP));

  if (machineZone) {
    // A machine zone takes the structural value with no BTM and no doubling — mirror what Apply
    // writes rather than showing a toughness subtraction that never happens there.
    add(localize("DamageDlgBdStructural"), String(hit.penetrates ? Math.max(0, Math.round(afterSP)) : 0));
  } else {
    // Toughness only enters the arithmetic when something got through — a stopped hit goes
    // straight to a final of nothing, and printing a subtraction that never ran would read as
    // if BTM were what stopped it.
    if (hit.penetrates) add(localize("DamageDlgBdBtm"), `−${btm}`);
    add(localize("DamageDlgBdFinal"), String(computeNetDamage(afterSP, btm, hit.penetrates, hit.location)));
  }

  // What this round cost the object it was shot through — the receipt the applicator's ledger
  // wrote for this exact round, so the reader sees the pool fall bullet by bullet.
  const chew = hit.coverChew;
  if (chew) {
    add(chew.label, chew.destroyed
      ? localizeParam("DamageDlgBdDrainDestroyed", { damage: chew.absorbed })
      : localizeParam("DamageDlgBdDrain", { damage: chew.absorbed, pool: chew.poolAfter, poolMax: chew.poolMax }),
      "drain");
  }
  return rows;
}

/**
 * THE COLLAPSED DISCLOSURE A CHAT CARD SHOWS FOR ONE CAUGHT FIGURE — the same rows, plus the two things
 * a card needs that the window does not.
 *
 * ⭐ COLLAPSED BY DEFAULT, and that is the ruling rather than a preference: a five-victim detonation
 * card has to stay scannable, so the math is there for the reader who wants it and out of the way of
 * the reader who does not. The template renders a `<details>` with no `open` attribute; nothing in this
 * module ever writes one.
 *
 * ⛔ N ROUNDS ARE N BREAKDOWNS, not one. Each shell of a burst is its own trip through the armour
 * pipeline (SP is subtracted per hit, and a valued barrier's pool falls between them), so a figure hit
 * by three shells gets three blocks under one summary — which is exactly what the window shows for the
 * same three rows.
 *
 * @param {Array<object>} hits   the applied result rows for ONE figure, in the order they landed
 * @param {number} btm           that body's toughness modifier
 * @returns {{summary:string, blocks:Array<{rows:Array,index:number,multi:boolean}>}|null}
 *          null when no row carries a breakdown (a caller on a path that produced none)
 */
export function cardBreakdownFor(hits, btm) {
  const list = (Array.isArray(hits) ? hits : []).filter(h => h?.breakdown);
  if (!list.length) return null;
  const multi = list.length > 1;
  return {
    summary: localize("AreaCardBreakdown"),
    blocks: list.map((h, i) => ({
      index: i + 1,
      multi,
      // A card reports what the apply DID, so nothing here is overridden — the override is a control
      // that only the window has. `afterSP` is the row's own resolved value under either resolver's
      // name for it (`damageAfterSP` on both, kept explicit so a future rename is a red rather than a
      // silent zero).
      rows: damageBreakdownRows(h, btm, Number(h.damageAfterSP ?? h.afterSP ?? 0), false),
    })),
  };
}
