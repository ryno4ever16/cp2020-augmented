/**
 * Full-conversion cyborg (FBC) whole-body structural damage — the last piece of the cyberlimb arc.
 *
 * RAW (Chromebook 2 p.63-65, prose text layer): a full borg's body is entirely machinery, so the
 * character "takes Structural Damage Points rather than wound damage." Every zone carries its own
 * SP + SDP (Head/limbs disabled at rating-10 / destroyed at rating; Torso = limb+10). The brain sits
 * in the HEAD and the biosystem/life-support in the TORSO (p.64,66), so destroying either kills the
 * borg; a destroyed limb just goes useless. Per-borg SP/SDP tables are in the pack (import-staging
 * /borg-sdp/) and stored on the body item as the `borgBody` flag (per-zone sp + destroyed-SDP maps).
 *
 * This engine (a) detects a full borg, (b) seeds those SDP values into the base's existing per-zone
 * `system.sdp` pools in a prepareData wrap — so ALL the cyberlimb machinery (SDP routing, the sheet's
 * armor-display, absorbCyberlimbHit, repair) works for six zones with no parallel model — and (c)
 * supplies the core-zone death the limb model deliberately lacks. Detection is actor-level (the book:
 * it is a whole-body state, not one implant): an equipped body item carrying `borgBody`, with a manual
 * `fullBorg` flag override (true forces on / false forces off).
 *
 * No import from cyberlimb.js (it imports isFullBorg from here) — kept one-directional to avoid a cycle.
 */
import { localize, localizeParam, combineArmorSP } from "../utils.js";
import { btmFromBT } from "../lookups.js";
import { postSavePromptCard } from "../compat.js";
import { equippedChange } from "./loadout.js";

const SCOPE = "cp2020-augmented";
const ZONES = ["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"];

/** The core zones whose destruction ends the borg: Head (brain) and Torso (biosystem/life-support). */
export const BORG_CORE_ZONES = new Set(["Head", "Torso"]);

/** True when the item is a full-conversion borg body (carries a valid `borgBody` flag). Pure. Keyed on
 *  `.sdp` to match borgBodyOf's own validity test. */
export function isBorgBody(item) {
  const bb = (item?.getFlag?.(SCOPE, "borgBody")) ?? item?.flags?.[SCOPE]?.borgBody;
  return !!bb?.sdp;
}

/** The `borgBody` block from the actor's equipped full-borg body item, else null. First equipped wins. */
export function borgBodyOf(actor) {
  for (const it of (actor?.items ?? [])) {
    if (it?.system?.equipped !== true) continue;
    const bb = (it.getFlag?.(SCOPE, "borgBody")) ?? it?.flags?.[SCOPE]?.borgBody;
    if (bb?.sdp) return bb;
  }
  return null;
}

/**
 * The live full-borg chassis stopping power for a zone: the intrinsic full-body armor (Chr2 p.64 —
 * SP 25 baseline, per-borg from the body item's `borgBody.sp` map) PLUS the equipped Increased-SP
 * steps (+5/step, never past the printed SP 40), else 0. The ONE clamp both applyBorgBody's prepared
 * armor fold and the damage resolver's live-SP re-derivation must agree on — so the live number
 * includes the same equipped Increased-SP steps the prepared number does. Negative delta payloads
 * are floored at 0 (a whole-body SP upgrade only adds). Pure.
 */
export function borgZoneSP(actor, zone) {
  const baseSp = Number(borgBodyOf(actor)?.sp?.[zone]) || 0;
  if (baseSp <= 0) return 0;
  const deltas = borgDeltasOf(actor);
  return Math.min(baseSp + Math.max(0, deltas.sp), Math.max(baseSp, BORG_SP_CAP));
}

/**
 * The full-borg chassis stopping power for a zone, read by the damage resolver's live-SP
 * re-derivation so a naked borg's chassis SP survives ablation + Maximum Metal AV. Delegates to
 * borgZoneSP so the live SP matches the prepared fold — equipped Increased-SP steps included. Pure.
 */
export function borgArmorSP(actor, zone) {
  return borgZoneSP(actor, zone);
}

/**
 * Per-zone option-space CAPACITY for a full borg, keyed by the cyberware-tab AREA ids
 * (head/body/nervous/l-arm/r-arm/l-leg/r-leg), from the body item's `borgBody.optionSpaces`
 * (shape `{ optic:[L,R], audio, head?, Torso, rArm, lArm, rLeg, lLeg }`). Head aggregates the two
 * optic sockets + audio + the optional `head` pool (non-socket head fixtures — light bars, a sensory
 * boom root); the borg data has no separate Nervous pool (0). The pools are TOTAL capacity (factory
 * fit-out + the book's free spaces) — the sheet's zone tally counts every zone-root item against
 * them, factory or aftermarket alike. Null when the actor is not a full borg or the body carries no
 * optionSpaces. Pure.
 */
export function borgOptionSpaces(actor) {
  const os = borgBodyOf(actor)?.optionSpaces;
  if (!os) return null;
  const optic = Array.isArray(os.optic) ? os.optic.reduce((s, n) => s + (Number(n) || 0), 0) : (Number(os.optic) || 0);
  return {
    head: optic + (Number(os.audio) || 0) + (Number(os.head) || 0),
    body: Number(os.Torso) || 0,
    nervous: 0,
    "l-arm": Number(os.lArm) || 0,
    "r-arm": Number(os.rArm) || 0,
    "l-leg": Number(os.lLeg) || 0,
    "r-leg": Number(os.rLeg) || 0,
  };
}

/**
 * The cyberware-tab AREA id a cyberware item occupies (head/body/nervous/l-arm/r-arm/l-leg/r-leg),
 * from its MountZone + Location — the sheet groups the body map by this same area id so a zone's
 * used-slots tally matches what the zone displays. "" when the item has no placeable zone (a sideless Arm/Leg, or a
 * zoneless body item). Pure.
 */
export function cyberAreaOf(item) {
  const zone = String(item?.system?.MountZone || item?.system?.CyberBodyType?.Type || "");
  const side = String(item?.system?.CyberBodyType?.Location || "");
  switch (zone) {
    case "Head":    return "head";
    case "Torso":   return "body";
    case "Nervous": return "nervous";
    case "Arm":     return side === "Right" ? "r-arm" : side === "Left" ? "l-arm" : "";
    case "Leg":     return side === "Right" ? "r-leg" : side === "Left" ? "l-leg" : "";
    default:        return "";
  }
}

/**
 * Whether the actor is a full-conversion cyborg. Three-state per the user's D2 call: an explicit
 * `fullBorg` flag forces the answer (true/false); otherwise it is derived from an equipped body item.
 */
export function isFullBorg(actor) {
  const flag = actor?.getFlag?.(SCOPE, "fullBorg") ?? actor?.flags?.[SCOPE]?.fullBorg;
  if (flag === true) return true;
  if (flag === false) return false;
  return !!borgBodyOf(actor);
}

/**
 * The actor stat keys (a subset of `ref`/`ma`/`bt`) a full-borg chassis ACTUALLY sets authoritatively
 * this prepare — derived from the equipped body item's `borgBody.stats` block (BODY→`bt`). Empty when
 * there is no such block (an SDP/SP-only body, or a manual-flag borg with no body item): those configs
 * leave the physical stats on the meat value, so a drug/moddy still moves them. The FBC drug-skip and
 * the "boost ignored" advisory gate on THIS, not on isFullBorg — an SDP-only borg never SETs ref/ma/bt,
 * so its physical-stat boosts must NOT be dropped. Pure.
 */
export function borgSetStatKeys(actor) {
  const stats = borgBodyOf(actor)?.stats;
  const keys = new Set();
  if (!stats) return keys;
  if (stats.ref !== undefined && stats.ref !== null) keys.add("ref");
  if (stats.ma !== undefined && stats.ma !== null) keys.add("ma");
  if (stats.body !== undefined && stats.body !== null) keys.add("bt");
  return keys;
}

// The printed FULL-BORG upgrade ceilings (Chromebook 2 p.84-85): stats REF 15 / MA 25 / BODY 20;
// whole-body SP max 40; SDP max +20 over the chassis. The Increased-option items carry their step
// in a `borgStatDelta` flag; the folds below clamp the summed steps at these maxima.
const BORG_STAT_CAPS = { ref: 15, ma: 25, body: 20 };
const BORG_SP_CAP = 40;
const BORG_SDP_DELTA_CAP = 20;

/**
 * Sum the equipped Increased-option steps: every equipped cyberware item's `borgStatDelta` flag
 * (`{ ref?: n, ma?: n, body?: n, sp?: n, sdp?: n }` — one step per item; buy N copies for +N).
 * This is the mechanism that makes the purchased "Full Borg: Increased …" options DO the printed
 * thing — the chassis payload stays the factory baseline and the options stack on top. Pure.
 */
export function borgDeltasOf(actor) {
  const out = { ref: 0, ma: 0, body: 0, sp: 0, sdp: 0 };
  for (const it of (actor?.items?.contents ?? actor?.items ?? [])) {
    if (it?.type !== "cyberware" || it.system?.equipped !== true) continue;
    const d = (it.getFlag?.(SCOPE, "borgStatDelta")) ?? it?.flags?.[SCOPE]?.borgStatDelta;
    if (!d) continue;
    for (const k of Object.keys(out)) out[k] += Number(d[k]) || 0;
  }
  return out;
}

/**
 * prepareData post-step. Two seeds, both from the equipped body item's `borgBody` block:
 *  1. Per-zone SDP → `system.sdp.sum/current` for all six zones, so the shared cyberlimb SDP path
 *     (routing, sheet, absorb, repair) covers Head+Torso too. The body items carry no
 *     `CyberWorkType.SDP` (a single item can't span six zones), so the base sum is 0 for them — we
 *     overwrite it here. `current` follows the base's own rule (persisted remaining if valid, else
 *     full), with the sticky `limbStatus` flag authoritative for a destroyed zone (the base resets a
 *     derived `current` of 0 back to sum, so a destroyed zone's 0 can't live in `current` — same quirk
 *     the cyberlimb pass works around).
 *  2. Intrinsic chassis SP → folded into the base's derived `system.hitLocations[zone].stoppingPower`
 *     (the single value the damage pipeline reads). The base has already collapsed worn/cyber armor
 *     into that number when this wrap runs, so the chassis is one more innermost layer, combined
 *     proportionally (p.99) exactly as cover is combined at damage time — worn armor over the chassis
 *     still stacks, and AP still halves it (chassis armor is armor). This also surfaces the SP on the
 *     sheet's per-zone armor column for free.
 *  3. Physical stats REF/MA/BODY → SET authoritatively on the already-computed totals (`stats.ref`,
 *     `stats.ma`, `stats.bt`), with the movement/carry/BTM dependents re-derived, when the body item
 *     carries a `borgBody.stats` block. RAW: a full conversion's physical stats ARE the chassis's
 *     (baseline REF 10 / MA 10 / BODY 12, bought up per model). Mental stats (INT/COOL/…) untouched.
 *     This wrap runs after the base AND after the Q7 moddies wrap, so the chassis value is the final
 *     word. Only bodies with a `stats` block set stats — the SDP/SP-only bodies leave stats alone.
 * A manual-flag borg with no body item keeps whatever `system.sdp`/`hitLocations`/`stats` already hold.
 */
export function applyBorgBody(actor) {
  const bb = borgBodyOf(actor);
  if (!bb?.sdp) return;
  const sdp = actor?.system?.sdp;
  if (!sdp) return;
  sdp.sum = sdp.sum || {};
  sdp.current = sdp.current || {};
  const stored = actor?._source?.system?.sdp?.current ?? {};
  const limbStatus = actor?.flags?.[SCOPE]?.limbStatus ?? {};
  const hitLocations = actor?.system?.hitLocations ?? {};
  // Equipped Increased-option steps (Chr2 whole-body upgrades), clamped at the printed maxima.
  const deltas = borgDeltasOf(actor);
  for (const zone of ZONES) {
    // Fold the chassis SP into the derived per-zone armor SP before the SDP seed's early-continue.
    // Increased SP is a whole-body upgrade: +5/step on every zone, never past the printed SP 40 —
    // the shared borgZoneSP applies that clamp so the live-SP re-derivation stays in lockstep.
    const sp = borgZoneSP(actor, zone);
    const loc = hitLocations[zone];
    if (sp > 0 && loc) loc.stoppingPower = combineArmorSP(Number(loc.stoppingPower) || 0, sp);

    // Increased SDP: +5/step on every zone, never more than +20 over the chassis's own rating —
    // and a negative flag payload is floored at 0, so a structural upgrade can't drop below chassis.
    const baseMax = Number(bb.sdp[zone]) || 0;
    if (baseMax <= 0) continue;
    const max = baseMax + Math.min(Math.max(0, deltas.sdp), BORG_SDP_DELTA_CAP);
    sdp.sum[zone] = max;
    if (limbStatus[zone] === "destroyed") { sdp.current[zone] = 0; continue; }
    // Clamp a persisted remaining that exceeds the recomputed max (an Increased-SDP copy unequipped
    // after damage) DOWN to max — resetting to full would make the taken damage vanish.
    const rem = Number(stored[zone]);
    sdp.current[zone] = (Number.isFinite(rem) && rem > 0) ? Math.min(rem, max) : max;
  }

  // Increased Stats: +1/step per stat on the chassis baseline, clamped at the printed maxima —
  // but never BELOW the chassis's own printed value (a factory REF 15 chassis stays 15).
  let stats = bb.stats;
  if (stats && (deltas.ref || deltas.ma || deltas.body)) {
    const upg = (base, delta, cap) => {
      const b = Number(base);
      if (!Number.isFinite(b) || !delta) return base;
      return Math.max(b, Math.min(b + delta, Math.max(b, cap)));
    };
    stats = {
      ...stats,
      ref: upg(stats.ref, deltas.ref, BORG_STAT_CAPS.ref),
      ma: upg(stats.ma, deltas.ma, BORG_STAT_CAPS.ma),
      body: upg(stats.body, deltas.body, BORG_STAT_CAPS.body),
    };
  }
  applyBorgStats(actor, stats);
}

/**
 * Sum the transient stat overlays the drug/moddy prepare wraps recorded earlier in the chain, for one
 * base stat key (`ref`/`ma`/`bt`): the drug boosts (`actor._mechDrugMods`) and the personality-moddy
 * contributions (`actor._mechStatMods`), each a `{ stat → [{ value }] }` contribution map whose
 * `value` is the delta the status-strip tooltip already advertises. Pure.
 */
function recordedStatDelta(actor, key) {
  let d = 0;
  for (const c of (actor?._mechStatMods?.[key] ?? [])) d += Number(c?.value) || 0;
  for (const c of (actor?._mechDrugMods?.[key] ?? [])) d += Number(c?.value) || 0;
  return d;
}

/**
 * SET the chassis physical stats onto the actor's already-computed totals and re-derive the movement
 * and body-type dependents (run/leap, carry/lift, BTM) the base computes from MA/BODY. `stats` is the
 * body item's `borgBody.stats` block `{ ref, ma, body }` (BODY maps to the `bt` stat key); each is
 * optional. Pure-ish: mutates prepared data only, never persists. No-op without a stats block.
 *
 * The chassis value replaces the MEAT stat as the base, but the situational penalties the base
 * prep already folded still degrade a borg (user-ruled 2026-07-10): worn-armor encumbrance
 * (stat.armorMod, REF), cyber-armor stat penalties (stat.armorImplantMod), and the wound-state
 * REF reduction — recomputed against the chassis value, because the deep-wound bands are
 * fractions of the CURRENT total (base actor.js woundStat), not flat deltas, and the base's
 * recorded woundMod was derived from the meat total this SET just replaced. INT/COOL keep the
 * base's own wound fold untouched (the chassis never writes them).
 *
 * The SET also discards the drug-boost + stat-moddy deltas the earlier wraps applied to ref/ma/bt
 * (their contribution records still render, so the tooltip lists a delta the total lacked) — so the
 * refold list above is extended: re-apply the recorded deltas (recordedStatDelta) on top of the
 * chassis value here. The printed rules are silent on drugs/moddies over a chassis, so this is
 * PERMISSIVE by design (favors the borg): clamped never above the printed cap (BORG_STAT_CAPS) and
 * never below the PENALTY-REDUCED total (so the wound/encumbrance reductions folded just above always
 * survive the refold — flooring at the raw chassis value would erase them); GMs restrict at the table.
 */
export function applyBorgStats(actor, stats) {
  if (!stats) return;
  const s = actor?.system?.stats;
  if (!s) return;
  const woundState = Number(actor?.woundState?.() ?? 0);
  const capFor = { ref: BORG_STAT_CAPS.ref, ma: BORG_STAT_CAPS.ma, bt: BORG_STAT_CAPS.body };
  const setStat = (key, val) => {
    if (val === undefined || val === null || s[key] === undefined) return;
    const n = Number(val);
    if (!Number.isFinite(n)) return;
    let total = n
      + (key === "ref" ? (Number(s.ref?.armorMod) || 0) : 0)
      + (Number(s[key].armorImplantMod) || 0);
    if (key === "ref") {
      if (woundState >= 4)      { s[key].woundMod = -(total - Math.ceil(total / 3)); total = Math.ceil(total / 3); }
      else if (woundState === 3){ s[key].woundMod = -(total - Math.ceil(total / 2)); total = Math.ceil(total / 2); }
      else if (woundState === 2){ s[key].woundMod = -2; total -= 2; }
    }
    // Refold the drug/moddy overlays the SET just discarded — permissive: clamp above at the printed
    // cap, below at the PENALTY-REDUCED total (never the raw chassis n — flooring there would cancel
    // the wound/encumbrance reductions folded just above). A positive delta stacks on the degraded
    // value; a negative moddy can't push below it.
    const delta = recordedStatDelta(actor, key);
    if (delta) {
      const cap = capFor[key] ?? 0;
      const floor = total;
      total = Math.max(floor, cap > 0 ? Math.min(floor + delta, Math.max(floor, cap)) : floor + delta);
    }
    s[key].total = total;
  };
  setStat("ref", stats.ref);
  setStat("ma", stats.ma);
  setStat("bt", stats.body);
  if (stats.ma !== undefined && s.ma) {
    s.ma.run = s.ma.total * 3;
    s.ma.leap = Math.floor(s.ma.run / 4);
  }
  if (stats.body !== undefined && s.bt) {
    s.bt.carry = s.bt.total * 10;
    s.bt.lift = s.bt.total * 40;
    s.bt.modifier = btmFromBT(s.bt.total);
  }
}

/**
 * End a borg whose Head or Torso was destroyed: post the notice and set the "dead" status (mirrors the
 * head-wound death path in DamageApplicator.assessWoundSeverity). Called from applyLocationDamage after
 * a core zone's SDP reaches destroyed.
 */
export async function killBorgCore(actor, zone, token = null) {
  // Resolve the token from the DAMAGED actor: a synthetic (unlinked) actor carries its own
  // TokenDocument, so prefer actor.token?.object before the first-placeable scan — the placeable
  // scan maps a synthetic actor back to the world prototype and picks the wrong token for a
  // multi-token/unlinked actor. The card names/speaks as the damaged actor, not the world one.
  const liveToken = token ?? actor?.token?.object
    ?? canvas?.tokens?.placeables?.find(t => t.actor?.id === actor.id) ?? null;
  await postSavePromptCard({
    title: localizeParam("BorgCoreDestroyedTitle", { name: actor.name }),
    body: localize(zone === "Head" ? "BorgHeadDestroyedBody" : "BorgTorsoDestroyedBody"),
    speaker: ChatMessage.getSpeaker({ actor }),
  });
  const deadActor = liveToken?.actor ?? actor;
  if (deadActor?.toggleStatusEffect) {
    await deadActor.toggleStatusEffect("dead", { active: true }).catch(() => {});
  }
}

let _wrapped = false;
/** Wrap prepareData once so the borg SDP seed runs after the base's stat/SDP pass (mirrors drug.js). */
export function registerBorg() {
  const proto = CONFIG?.Actor?.documentClass?.prototype;
  if (proto && !_wrapped) {
    const orig = proto.prepareData;
    proto.prepareData = function () {
      orig.call(this);
      try { applyBorgBody(this); } catch (e) { console.warn(`${SCOPE} | borg body seed failed`, e); }
    };
    _wrapped = true;
  }

  // At most one full conversion installed at a time: veto equipping a second borg body. Without this a
  // second body silently materializes its loadout while borgBodyOf ("first equipped wins") ignores it.
  // Sync preUpdateItem returning false cancels the write before it commits (mirrors consumable.js).
  Hooks.on("preUpdateItem", (item, changes) => {
    if (equippedChange(changes) !== "on" || !isBorgBody(item)) return;
    const actor = item.actor;
    if (!actor) return;
    const other = actor.items.find(it => it.id !== item.id && it.system?.equipped === true && isBorgBody(it));
    if (!other) return;
    ui.notifications?.warn(localizeParam("BorgBodyAlreadyInstalled", { name: other.name }));
    return false;
  });

  // Batch guard: a single updateEmbeddedDocuments flipping TWO chassis to equipped at once passes both
  // preUpdate checks (neither sibling is committed when either check runs), landing two equipped
  // bodies. Re-verify post-commit and demote all but the first — borgBodyOf's own "first equipped
  // wins" order (collection order), so the retained body is the one the rest of the engine already
  // treats as authoritative. The demote write flips equipped:false (equippedChange "off" → no re-entry).
  Hooks.on("updateItem", async (item, changes, options, userId) => {
    if (userId !== game.user?.id) return;
    if (equippedChange(changes) !== "on" || !isBorgBody(item)) return;
    const actor = item.actor;
    if (!actor || !actor.isOwner) return;
    const equipped = actor.items.filter(it => it.system?.equipped === true && isBorgBody(it));
    if (equipped.length <= 1) return;
    const [keep, ...extra] = equipped;
    ui.notifications?.warn(localizeParam("BorgBodyAlreadyInstalled", { name: keep.name }));
    await actor.updateEmbeddedDocuments("Item", extra.map(it => ({ _id: it.id, "system.equipped": false })));
  });

  // The same rule on the CREATE path (a copied/imported body arrives with equipped baked in and
  // never passes preUpdateItem): a second chassis lands as CARRIED instead — spare bodies are
  // legitimate property; only the equipped slot is exclusive. The loadout createItem hook then
  // sees equipped:false and correctly skips materialization.
  Hooks.on("preCreateItem", (doc, data) => {
    // Read the POST-CLEAN document, not raw creation data: the schema default is equipped:true, so a
    // create that omits the key still lands equipped and must be caught by the demote rule.
    if (doc?.system?.equipped !== true || !isBorgBody(doc)) return;
    const actor = doc?.parent;
    if (!actor?.items?.find) return;
    const other = actor.items.find(it => it.system?.equipped === true && isBorgBody(it));
    if (!other) return;
    ui.notifications?.warn(localizeParam("BorgBodyAlreadyInstalled", { name: other.name }));
    doc.updateSource({ "system.equipped": false });
  });
}
