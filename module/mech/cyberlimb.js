/**
 * Cyberlimb structural damage (SDP) vs the human wound track — the confirmed pre-1.1.0 defect.
 *
 * RAW (CP2020 Core p.89, prose text layer): cyberlimbs are "treated like machinery" — "All cyberlimbs
 * can take up to 20 points of structural damage before they are useless, and up to 30 total points
 * before they are destroyed." A cyberlimb wound "has no pain effects; you don't have to make a saving
 * roll against shock and stun." The book states no death save and no human consequence on destruction;
 * per the user's call there is NO overflow either — a shot that overkills the limb simply destroys it
 * and stops. So a hit to a cyberlimb zone reduces the LIMB's own SDP, never the character's wound track.
 *
 * The per-zone SDP pool ALREADY exists: the base actor sums each equipped, enabled Implant cyberware's
 * `CyberWorkType.SDP` into `system.sdp.sum[zone]` (by MountZone + CyberBodyType.Location →
 * Head/Torso/lArm/rArm/lLeg/rLeg), and `system.sdp.current[zone]` tracks the remaining (rig-confirmed
 * writable + persistent, and edited on the sheet). This module only adds the COMBAT wiring: detect a
 * cyberlimb zone, absorb the hit into `current`, and flag useless/destroyed. Always on — a cyberlimb
 * behaving like flesh is a defect, not a playstyle option (user decision: no setting).
 *
 * Pure helpers are exported for the rig spec; the combat routing lives in combat/DamageApplicator.js.
 */
import { localize, localizeParam } from "../utils.js";
import { postSavePromptCard } from "../compat.js";
import { isFullBorg } from "./borg.js";

const SCOPE = "cp2020-augmented";
const LIMB_ZONES = new Set(["rArm", "lArm", "rLeg", "lLeg"]);
// Every zone, in sheet order — the routing/status set for a full-conversion borg (whole-body machinery).
const ALL_ZONES = ["Head", "Torso", "rArm", "lArm", "rLeg", "lLeg"];

// The "useless" band is the final SDP before "destroyed": Core prints 20/30 and hydraulic rams 30/40
// — both a consistent 10-point gap. If a supplement ever prints a different band, this is the single
// constant to revisit (the user flagged supplements may differ; the amounts flow through via SDP).
export const CYBERLIMB_USELESS_MARGIN = 10;

/** True when `location` is a limb zone carrying cyberlimb structure (SDP sum > 0). Pure-ish. */
export function isCyberlimbZone(actor, location) {
  if (!LIMB_ZONES.has(location)) return false;
  return (Number(actor?.system?.sdp?.sum?.[location]) || 0) > 0;
}

/**
 * True when a location's damage should absorb into per-zone SDP instead of the flesh wound track: a
 * cyberlimb zone, OR — for a full-conversion borg — ANY of the six zones (its whole body is machinery,
 * Head/Torso included, once the borgBody SDP is seeded). The single routing check every apply path
 * uses, so cyberlimbs and borgs funnel through the same seam. Pure-ish.
 */
export function routesToSdp(actor, location) {
  if (isCyberlimbZone(actor, location)) return true;
  return isFullBorg(actor) && (Number(actor?.system?.sdp?.sum?.[location]) || 0) > 0;
}

/** { max, current } SDP for a zone; current defaults to max when unset. Pure-ish. */
export function cyberlimbSdp(actor, zone) {
  const max = Number(actor?.system?.sdp?.sum?.[zone]) || 0;
  const raw = actor?.system?.sdp?.current?.[zone];
  const current = Number.isFinite(Number(raw)) ? Number(raw) : max;
  return { max, current };
}

/** Classify a remaining-SDP value: "ok" | "useless" | "destroyed". Pure. */
export function cyberlimbStatus(remaining) {
  if (remaining <= 0) return "destroyed";
  if (remaining <= CYBERLIMB_USELESS_MARGIN) return "useless";
  return "ok";
}

/**
 * The limb's destroyed/disabled state, from the persisted `limbStatus` flag (the AUTHORITATIVE state).
 * Note: the base actor's prepareData resets `system.sdp.current` back to `sum` whenever it reads exactly
 * 0 (it treats 0 as an unset sheet default — actor.js), so a DESTROYED limb's `current` can't stay 0.
 * The module flag is immune to that, so useless/destroyed lives here, not in `current`. Pure-ish.
 */
export function limbStatusOf(actor, zone) {
  return (actor?.getFlag?.(SCOPE, "limbStatus") ?? actor?.flags?.[SCOPE]?.limbStatus ?? {})[zone] ?? "";
}

/**
 * Absorb a structural hit into a cyberlimb's SDP (no BTM, no wound track, no stun/death save, no
 * overflow). Reduces `system.sdp.current[zone]` and flags the limb disabled/destroyed via the sticky
 * `limbStatus` flag when it crosses a threshold. A limb already destroyed is gone — it soaks nothing
 * further (and RAW routes nothing to the human). `dmg` is the post-armor structural damage.
 * Returns { remaining, max, status }.
 */
export async function absorbCyberlimbHit(actor, zone, dmg, { token = null } = {}) {
  const { max, current } = cyberlimbSdp(actor, zone);
  const prior = limbStatusOf(actor, zone);
  const alreadyDestroyed = prior === "destroyed";
  const hit = Math.max(0, Math.round(Number(dmg) || 0));
  const remaining = alreadyDestroyed ? 0 : Math.max(0, current - hit);
  // Only write `current` while the limb still has structure; a destroyed limb's current is left alone
  // (writing 0 would just be reset to sum by the base prep — limbStatus is the truth).
  if (!alreadyDestroyed) {
    // system.sdp.current is an untyped ObjectField — a dotted per-zone update (…current.${zone}) resets
    // the SIBLING zones to their schema default (0), which loses other damaged zones on a multi-zone
    // actor (a full borg tracks all six). Write the whole current object so the siblings survive.
    const nextCurrent = { ...(actor.system?.sdp?.current ?? {}), [zone]: remaining };
    await actor.update({ "system.sdp.current": nextCurrent }, { render: false, fromCyberpunkDamageSystem: true });
  }
  const status = alreadyDestroyed ? "destroyed" : cyberlimbStatus(remaining);

  // Flag the limb the moment it becomes useless/destroyed (sticky; survives the current-reset quirk).
  const flagged = status === "destroyed" ? "destroyed" : status === "useless" ? "disabled" : "";
  const priorFlagged = prior === "destroyed" ? "destroyed" : prior === "disabled" ? "disabled" : "";
  if (flagged && flagged !== priorFlagged) {
    const cur = foundry.utils.duplicate(actor.getFlag(SCOPE, "limbStatus") ?? {});
    cur[zone] = flagged;
    await actor.setFlag(SCOPE, "limbStatus", cur).catch(() => {});
  }

  // A full borg's whole body is machinery, so its zones (incl. Head/Torso) read as borg chassis, not
  // "cyberlimb"; a plain cyberlimb keeps the limb wording. Same SDP mechanics either way.
  const borg = isFullBorg(actor);
  const limb = localize(zone);
  const statusClause = status === "destroyed" ? localize(borg ? "BorgZoneDestroyedClause" : "CyberlimbDestroyedClause")
                     : status === "useless"   ? localize(borg ? "BorgZoneDisabledClause"  : "CyberlimbUselessClause") : "";
  await postSavePromptCard({
    body: localizeParam(borg ? "BorgZoneHitBody" : "CyberlimbHitBody", { limb, dmg: hit, remaining, max, statusClause }),
    speaker: ChatMessage.getSpeaker({ actor })
  });
  return { remaining, max, status };
}

/**
 * Repair a cyberlimb: restore its SDP to full and clear the disabled/destroyed flag (the sticky
 * `limbStatus`). The GM/owner action behind the sheet's repair button. Returns true when it ran.
 */
export async function repairCyberlimb(actor, zone) {
  if (!routesToSdp(actor, zone)) return false;   // a borg's Head/Torso are repairable too
  const max = Number(actor?.system?.sdp?.sum?.[zone]) || 0;
  // Restore SDP + remove ONLY this zone's limbStatus entry. A flag object merges on write, so a
  // deleted key would linger — use Foundry's `-=` deletion path to drop just this zone.
  // Whole-object write (siblings-safe, see absorbCyberlimbHit) + the sticky-flag `-=` delete.
  const nextCurrent = { ...(actor.system?.sdp?.current ?? {}), [zone]: max };
  await actor.update({
    "system.sdp.current": nextCurrent,
    [`flags.${SCOPE}.limbStatus.-=${zone}`]: null
  }, { render: false, fromCyberpunkDamageSystem: true });
  await postSavePromptCard({
    body: localizeParam("CyberlimbRepairedBody", { limb: localize(zone), max }),
    speaker: ChatMessage.getSpeaker({ actor })
  });
  return true;
}

/**
 * Per-zone cyberlimb state for the sheet: `{ rArm: { status, damaged, current, max }, … }` for every
 * limb zone that carries a cyberlimb. `status` is the TRUE state — from the sticky `limbStatus` flag
 * ("destroyed"/"useless") when set (so a destroyed limb reads correctly even though the base prep
 * resets its `current` to full), else "damaged" when current < max, else "ok". Pure-ish.
 */
export function cyberlimbSheetStatus(actor) {
  const out = {};
  const limbStatus = actor?.getFlag?.(SCOPE, "limbStatus") ?? actor?.flags?.[SCOPE]?.limbStatus ?? {};
  // A full borg surfaces status/repair for ALL six zones (Head+Torso included); a normal character
  // only for the four limb zones that can hold a cyberlimb.
  const zones = isFullBorg(actor) ? ALL_ZONES : LIMB_ZONES;
  for (const zone of zones) {
    const { max, current } = cyberlimbSdp(actor, zone);
    if (max <= 0) continue;   // no structure in this zone
    const flag = limbStatus[zone];
    const status = flag === "destroyed" ? "destroyed"
                 : flag === "disabled"  ? "useless"
                 : (current < max)      ? "damaged" : "ok";
    out[zone] = { status, damaged: status !== "ok", current, max };
  }
  return out;
}
