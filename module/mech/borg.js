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
 * The full-borg chassis stopping power for a zone (the intrinsic full-body armor, Chr2 p.64 — SP 25
 * baseline, per-borg from the body item's `borgBody.sp` map), else 0. Pure. Read by the damage
 * resolver's live-SP re-derivation so a naked borg's chassis SP survives ablation + Maximum Metal AV.
 */
export function borgArmorSP(actor, zone) {
  return Number(borgBodyOf(actor)?.sp?.[zone]) || 0;
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
  for (const zone of ZONES) {
    // Fold the chassis SP into the derived per-zone armor SP before the SDP seed's early-continue.
    const sp = Number(bb.sp?.[zone]) || 0;
    const loc = hitLocations[zone];
    if (sp > 0 && loc) loc.stoppingPower = combineArmorSP(Number(loc.stoppingPower) || 0, sp);

    const max = Number(bb.sdp[zone]) || 0;
    if (max <= 0) continue;
    sdp.sum[zone] = max;
    if (limbStatus[zone] === "destroyed") { sdp.current[zone] = 0; continue; }
    const rem = Number(stored[zone]);
    sdp.current[zone] = (Number.isFinite(rem) && rem > 0 && rem <= max) ? rem : max;
  }

  applyBorgStats(actor, bb.stats);
}

/**
 * SET the chassis physical stats onto the actor's already-computed totals and re-derive the movement
 * and body-type dependents (run/leap, carry/lift, BTM) the base computes from MA/BODY. `stats` is the
 * body item's `borgBody.stats` block `{ ref, ma, body }` (BODY maps to the `bt` stat key); each is
 * optional. Pure-ish: mutates prepared data only, never persists. No-op without a stats block.
 */
export function applyBorgStats(actor, stats) {
  if (!stats) return;
  const s = actor?.system?.stats;
  if (!s) return;
  const setStat = (key, val) => {
    if (val === undefined || val === null || s[key] === undefined) return;
    const n = Number(val);
    if (Number.isFinite(n)) s[key].total = n;
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
  const live = game.actors.get(actor.id) ?? actor;
  const liveToken = token ?? canvas?.tokens?.placeables?.find(t => t.actor?.id === live.id) ?? null;
  await postSavePromptCard({
    title: localizeParam("BorgCoreDestroyedTitle", { name: live.name }),
    body: localize(zone === "Head" ? "BorgHeadDestroyedBody" : "BorgTorsoDestroyedBody"),
    speaker: ChatMessage.getSpeaker({ actor: live }),
  });
  const deadActor = liveToken?.actor ?? live;
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
}
