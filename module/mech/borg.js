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
import { localize, localizeParam } from "../utils.js";
import { postSavePromptCard } from "../compat.js";

const SCOPE = "cp2020-augmented";
const ZONES = ["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"];

/** The core zones whose destruction ends the borg: Head (brain) and Torso (biosystem/life-support). */
export const BORG_CORE_ZONES = new Set(["Head", "Torso"]);

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
 * prepareData post-step: seed the borg body's per-zone SDP into `system.sdp.sum/current` for all six
 * zones, so the shared cyberlimb SDP path (routing, sheet, absorb, repair) covers Head+Torso too. The
 * body items carry no `CyberWorkType.SDP` (a single item can't span six zones), so the base sum is 0
 * for them — we overwrite it here. `current` follows the base's own rule (persisted remaining if valid,
 * else full), with the sticky `limbStatus` flag authoritative for a destroyed zone (the base resets a
 * derived `current` of 0 back to sum, so a destroyed zone's 0 can't live in `current` — same quirk the
 * cyberlimb pass works around). A manual-flag borg with no body item keeps whatever `system.sdp` holds.
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
  for (const zone of ZONES) {
    const max = Number(bb.sdp[zone]) || 0;
    if (max <= 0) continue;
    sdp.sum[zone] = max;
    if (limbStatus[zone] === "destroyed") { sdp.current[zone] = 0; continue; }
    const rem = Number(stored[zone]);
    sdp.current[zone] = (Number.isFinite(rem) && rem > 0 && rem <= max) ? rem : max;
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
}
