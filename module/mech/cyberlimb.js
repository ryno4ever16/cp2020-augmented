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
import { deleteFieldUpdate, localize, localizeParam, getLimbStatusMap } from "../utils.js";
import { postSavePromptCard, renderChatCard } from "../compat.js";
import { isFullBorg } from "./borg.js";
import { cyberlimbRepairGmOnly } from "../settings.js";

const SCOPE = "cp2020-augmented";
const LIMB_ZONES = new Set(["rArm", "lArm", "rLeg", "lLeg"]);
// Every zone, in sheet order — the routing/status set for a full-conversion borg (whole-body machinery).
const ALL_ZONES = ["Head", "Torso", "rArm", "lArm", "rLeg", "lLeg"];
// prepareData is wrapped once per client (mirrors mech/borg.js's _wrapped guard).
let _sdpWrapped = false;

// The "useless" band is the final SDP before "destroyed": Core prints 20/30 and hydraulic rams 30/40
// — both a consistent 10-point gap. If a supplement ever prints a different band, this is the single
// constant to revisit (the user flagged supplements may differ; the amounts flow through via SDP).
export const CYBERLIMB_USELESS_MARGIN = 10;

// The flesh-limb wound store (M18): the OPTIONAL limb-damage models record their threshold outcomes
// here — "crippled"/"destroyed" (Listen Up) and "disabled"/"severed" (W4RST4R) — under a key SEPARATE
// from the structural `limbStatus`, so a flesh wound is never misread as cyberlimb structure. Written
// by combat/DamageApplicator.js for non-structural zones; read here for the sheet badge + arm notice.
// ⛔ READS go through utils.getLimbStatusMap (the module's single read path — the future base-system
// severance record adapts THERE); this constant is the WRITE-side key only.
const FLESH_STATUS_FLAG = "fleshLimbStatus";
// Flesh wound state → localize key (mechanism words, not fiction). Used by the sheet label + the notice.
const FLESH_STATUS_LABEL = {
  crippled:  "FleshLimbStatusCrippled",
  destroyed: "FleshLimbStatusDestroyed",
  disabled:  "FleshLimbStatusDisabled",
  severed:   "FleshLimbStatusSevered",
};

/**
 * WHICH RULESET EACH RECORDED STATE COMES FROM — the picker's own labelling, and nothing else's.
 *
 * The record's vocabulary is a UNION of three limb models (the reader seam is model-agnostic by
 * design, so a state written under one model is still readable when the world is switched to
 * another). The GM's direct picker therefore offers all four states whatever `limbModel` is set to
 * — which is the ruled behaviour, and also the reported gap: *"some GMs will have no clue what the
 * additional options mean"*. A state word on its own does not say which book it belongs to.
 *
 * So the PICKER's option text names the source; the badge, the arm notice and the confirm sentence
 * keep the bare state word, because in those places the state is a fact about a limb rather than a
 * menu of rules to choose between. That is why this map is separate from FLESH_STATUS_LABEL rather
 * than folded into it.
 *
 * ⚠ `severed` HAS TWO SOURCES and is labelled with both. W4RST4R severs a limb above 12 net
 * (combat/DamageApplicator.js, the W4RST4R branch) and Core's own >8 rule loses the limb outright
 * (the Core branch, same file) — both record this exact string, so naming only one of them would be
 * a false attribution to whichever half of the table the reader plays.
 */
const FLESH_STATUS_SOURCE = {
  crippled:  "FleshLimbSourceListenUp",
  destroyed: "FleshLimbSourceListenUp",
  disabled:  "FleshLimbSourceW4rst4r",
  severed:   "FleshLimbSourceCoreW4rst4r",
};

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

/**
 * The status zone ANY cyberware item occupies, or "" — the base's own fold mapping (actor.js:
 * MountZone Head/Torso direct; Arm/Leg pick the side from CyberBodyType.Location, a module's
 * side from its parent). Mirrored, not invented, so install-time zone resolution always agrees
 * with the pool the base builds. `items` supplies the parent lookup for modules. Zone-less
 * mounts (Nervous, a zoneless chassis) return "". Pure.
 */
export function implantZoneOf(item, items = []) {
  const mz = item?.system?.MountZone || "";
  if (mz === "Head" || mz === "Torso") return mz;
  if (mz !== "Arm" && mz !== "Leg") return "";
  let side = item?.system?.CyberBodyType?.Location || "";
  if (!side && item?.system?.Module?.IsModule) {
    const pid = item.system?.Module?.ParentId;
    const parent = pid ? (items.find?.(i => (i.id ?? i._id) === pid) ?? null) : null;
    side = parent?.system?.CyberBodyType?.Location || "";
  }
  if (side === "Left") return mz === "Arm" ? "lArm" : "lLeg";
  if (side === "Right") return mz === "Arm" ? "rArm" : "rLeg";
  return "";
}

/** The SDP zone a STRUCTURAL implant occupies (SDP > 0), or "" — the SDP-pool subset of
 *  implantZoneOf, used by install-time state clearing and the damage routing. Pure. */
export function cyberlimbZoneOf(item, items = []) {
  if ((Number(item?.system?.CyberWorkType?.SDP) || 0) <= 0) return "";
  return implantZoneOf(item, items);
}

/**
 * True when a cyberware item sits in a DESTROYED zone — its host limb is wrecked, so the item's
 * mechanical contribution is gone with it (M19, the user's "in-limb gate" ruling: destroyed only;
 * a "useless" limb keeps its contributions and is surfaced by the attack-time notice instead).
 * Non-cyberware gear and zone-less mounts (Nervous sockets, a zoneless chassis) never gate. Pure-ish.
 */
export function inDestroyedZone(actor, item, items = actor?.items?.contents ?? []) {
  if (item?.type !== "cyberware") return false;
  const zone = implantZoneOf(item, items);
  if (!zone) return false;
  return limbStatusOf(actor, zone) === "destroyed";
}

/**
 * The actor's items minus cyberware whose zone is destroyed — the single list the contribution
 * engines (roll/stat mods, vision, light, hazard protection, the status strip) enumerate, so
 * "installed in a wrecked limb" reads as non-contributing everywhere at once (the gas-save engine
 * adopts this same gate at its resolution site, so strip and engine agree). NOT used by the armor-SP
 * folds: the base's prepared per-location fold can't see this filter, and the module's live fold must
 * stay equal to it (the M16 lesson) — a wrecked limb's plating is inert wreckage still covering the
 * location. Flesh-limb wound state (the separate `fleshLimbStatus` store) is NOT gated through this
 * filter — a flesh zone carries no structural pool — it is read via fleshLimbStatusOf/…Label.
 */
export function contributingItems(actor) {
  const items = actor?.items?.contents ?? [];
  return items.filter(it => !inDestroyedZone(actor, it, items));
}

/** { max, current } SDP for a zone; current defaults to max when unset. Pure-ish. */
export function cyberlimbSdp(actor, zone) {
  const max = Number(actor?.system?.sdp?.sum?.[zone]) || 0;
  const raw = actor?.system?.sdp?.current?.[zone];
  const current = Number.isFinite(Number(raw)) ? Number(raw) : max;
  return { max, current };
}

/**
 * Classify a remaining-SDP value against the pool's `max`: "ok" | "useless" | "destroyed". The
 * "useless" band exists only when the pool is LARGER than the margin (Core 20/30, hydraulic ram
 * 30/40 — always a 10-point band below a bigger max); a pool no bigger than the margin has no
 * useless band and steps straight ok→destroyed. `max` defaults to Infinity so a context-free
 * classify still reports the ordinary band. Pure.
 */
export function cyberlimbStatus(remaining, max = Infinity) {
  if (remaining <= 0) return "destroyed";
  if (remaining <= CYBERLIMB_USELESS_MARGIN && max > CYBERLIMB_USELESS_MARGIN) return "useless";
  return "ok";
}

/**
 * The limb's destroyed/disabled state, from the persisted `limbStatus` flag (the AUTHORITATIVE state).
 *
 * WHY a flag and not the number (mechanism verified against base actor.js, 2026-07-16): the base's
 * prepareData resets a `current` of exactly 0 back to `sum` — it reads 0 as "unset sheet default". It
 * MEANS to do that only once, guarding on `system.sdp._lastSum`… but `_lastSum` is written to the
 * DERIVED layer and is absent from the stored schema (source carries only sum/current/touched), so the
 * guard never holds and the reset fires on EVERY prepare. Net: the base cannot represent "0 SDP left",
 * so useless/destroyed lives in this flag, not in `current`. (`system.sdp.touched` is declared in
 * template.json but the base's actor code never reads it — vestigial, not a usable lever.)
 * ⚑ UPSTREAM CANDIDATE: the never-persisting `_lastSum` guard is a base defect worth reporting to Tilt.
 * We do NOT patch the base (its files are restored on update) — `applyDestroyedLimbSdp` re-asserts the
 * truth onto the derived number instead. Pure-ish.
 */
export function limbStatusOf(actor, zone) {
  return (actor?.getFlag?.(SCOPE, "limbStatus") ?? actor?.flags?.[SCOPE]?.limbStatus ?? {})[zone] ?? "";
}

/**
 * The recorded FLESH-limb wound state for a zone ("crippled"/"destroyed" from Listen Up,
 * "disabled"/"severed" from W4RST4R), or "" when none is recorded. A zone that carries a structural
 * SDP pool is answered by the cyberlimb store instead — its `limbStatus` is authoritative once a
 * cyberlimb covers the zone — so the flesh store reports "" there and the two never double-badge the
 * same zone. Reads the M18 `fleshLimbStatus` flag; never the shared structural key. Pure-ish.
 */
export function fleshLimbStatusOf(actor, zone) {
  if (cyberlimbSdp(actor, zone).max > 0) return "";
  // The record is read through utils.getLimbStatusMap — the module's single read path (see the
  // constraint on that accessor). The cyberlimb mask above is this model's own concern, not the
  // record's, so it stays here.
  return getLimbStatusMap(actor)[zone] ?? "";
}

/** Localized label for a zone's flesh-limb wound state, or "" when nothing is recorded. Pure-ish. */
export function fleshLimbStatusLabel(actor, zone) {
  const key = FLESH_STATUS_LABEL[fleshLimbStatusOf(actor, zone)];
  return key ? localize(key) : "";
}

/**
 * Absorb a structural hit into a cyberlimb's SDP (no BTM, no wound track, no stun/death save, no
 * overflow). Reduces `system.sdp.current[zone]` and flags the limb disabled/destroyed via the sticky
 * `limbStatus` flag when it crosses a threshold. A limb already destroyed is gone — it soaks nothing
 * further (and RAW routes nothing to the human). `dmg` is the post-armor structural damage.
 * Returns { remaining, max, status }.
 */
export async function absorbCyberlimbHit(actor, zone, dmg) {
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
  const status = alreadyDestroyed ? "destroyed" : cyberlimbStatus(remaining, max);

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
  // Optional permission scoping: some tables run limb repair as a GM-adjudicated Tech/cost flow.
  if (cyberlimbRepairGmOnly() && !game.user?.isGM) {
    ui.notifications?.warn(localize("CyberlimbRepairGmOnlyWarn"));
    return false;
  }
  if (!routesToSdp(actor, zone)) return false;   // a borg's Head/Torso are repairable too
  const max = Number(actor?.system?.sdp?.sum?.[zone]) || 0;
  // Restore SDP + remove ONLY this zone's limbStatus entry. A flag object merges on write, so a
  // deleted key would linger — delete just this zone through deleteFieldUpdate (utils), which picks
  // whichever deletion form the running core supports. Whole-object write (siblings-safe, see
  // absorbCyberlimbHit) + the sticky-flag delete.
  const nextCurrent = { ...(actor.system?.sdp?.current ?? {}), [zone]: max };
  await actor.update({
    "system.sdp.current": nextCurrent,
    ...deleteFieldUpdate(`flags.${SCOPE}.limbStatus.${zone}`)
  }, { render: false, fromCyberpunkDamageSystem: true });
  await postSavePromptCard({
    body: localizeParam("CyberlimbRepairedBody", { limb: localize(zone), max }),
    speaker: ChatMessage.getSpeaker({ actor })
  });
  return true;
}

/**
 * Clear a flesh limb's recorded injury — the medical counterpart to repairCyberlimb, and the missing
 * half of the M18 flesh-limb model. The damage pipeline WRITES `fleshLimbStatus`
 * (crippled/destroyed/disabled/severed) but nothing ever removed it: a cyberlimb only MASKS the badge
 * (fleshLimbStatusOf returns "" once a structural pool covers the zone — the stale flag survives and
 * reappears if the cyberlimb is pulled), and a cloned/meat limb was never a system operation at all.
 * So a recovered limb stayed marked forever with no in-UI way back. This removes the zone's entry.
 * Like repairCyberlimb it is the neutral STATE clear only — the medical event itself (healing time,
 * cost, a cloned limb, a Trauma Team bill) stays the GM's adjudication — and it shares the same
 * optional GM-only gate. Returns true when it ran.
 */
export async function clearFleshLimb(actor, zone) {
  if (cyberlimbRepairGmOnly() && !game.user?.isGM) {
    ui.notifications?.warn(localize("CyberlimbRepairGmOnlyWarn"));
    return false;
  }
  // Read the RAW record through the single read path (not fleshLimbStatusOf, which suppresses under
  // a cyberlimb) so a masked-but-stale entry is also cleared. The sheet control only appears when the
  // badge shows, but the API should clear whatever is recorded.
  const store = getLimbStatusMap(actor);
  if (!(zone in store)) return false;   // nothing recorded for this zone
  // Flag objects MERGE on write, so a deleted key would linger — drop just this zone through
  // deleteFieldUpdate (siblings survive), the same shape repairCyberlimb uses for limbStatus.
  await actor.update({
    ...deleteFieldUpdate(`flags.${SCOPE}.${FLESH_STATUS_FLAG}.${zone}`)
  }, { render: false, fromCyberpunkDamageSystem: true });
  await postSavePromptCard({
    body: localizeParam("FleshLimbClearedBody", { limb: localize(zone) }),
    speaker: ChatMessage.getSpeaker({ actor })
  });
  return true;
}

/**
 * Record the flesh limb under a zone as SEVERED — the meat counterpart to installing a cyberlimb.
 * Fitting an SDP-bearing cyberlimb means the limb it replaces is gone, so the true state of the flesh
 * beneath is "severed" (not merely absent). Masked while the cyberlimb covers the zone (fleshLimbStatusOf
 * returns "" when a structural pool is present) and surfaced only if that cyberlimb is later removed — a
 * severed stump, not a limb that grew back. Called from the sheet install handler, where the chosen side
 * is authoritative (the create/equip hook fires before the side is finalized). Direct flag write: no save,
 * no death check, no notice — installing chrome is not an attack. Limb zones only (Head/Torso are not
 * flesh limbs). Overwrites a lesser prior meat wound (a crippled arm that gets chromed is now severed);
 * idempotent when already severed. Forward-only — no migration backfills limbs installed before this. */
export async function severFleshUnder(actor, zone) {
  if (!LIMB_ZONES.has(zone)) return false;
  // Idempotency guard reads the record through the single read path (utils.getLimbStatusMap).
  if (getLimbStatusMap(actor)[zone] === "severed") return false;   // already recorded — nothing to write
  await actor.update({
    [`flags.${SCOPE}.${FLESH_STATUS_FLAG}.${zone}`]: "severed"
  }, { render: false, fromCyberpunkDamageSystem: true }).catch(() => {});
  return true;
}

/* ═══════════════════ GM direct set of a flesh limb's recorded state (the sheet control) ═══════════════════
 *
 * Until now the `fleshLimbStatus` record had exactly two writers — the damage pipeline
 * (combat/DamageApplicator.js) and the cyberlimb install (severFleshUnder above) — so a GM who simply
 * RULED that a limb is gone (a surgery, an off-screen event, a called shot resolved by hand) had no
 * control at all: only a console `setFlag` incantation. This block is that missing control's engine.
 *
 * ⛔ THE VALUE DOMAIN IS CLOSED. The offered states are exactly FLESH_STATUS_LABEL's keys — the
 * vocabulary the reader seam (utils.getLimbStatusMap / fleshLimbStatusOf) and the badge already
 * understand. No new state string is ever invented here; adding one means adding it to that map (and
 * to every reader that switches on it) first.
 *
 * ⛔ THE WRITE IS THE PIPELINE'S WRITE. Same flag, same per-zone key, same plain string value, so a
 * GM-set severed limb and a pipeline-set one are indistinguishable to every downstream consumer (the
 * sheet badge, the arm-use notice, utils' gone-limb re-roll). The dotted-path form is used rather than
 * a whole-object `setFlag` because flag objects MERGE per key — a dotted write touches only this zone
 * and cannot resurrect or clobber a sibling limb (the same reason severFleshUnder writes this way, and
 * the mirror of clearFleshLimb's deleteFieldUpdate on the way out).
 */

/** The recorded flesh-limb states this module understands, as sheet-ready `{ value, label, state, source }`
 *  rows in a stable order. Built here — not in the template — so the picker can never drift from the
 *  badge/reader vocabulary (the dynamic-`<select>` idiom: JS builds the option data, the template just
 *  iterates).
 *
 *  `label` is the row the picker shows: the state word with its RULESET named after it, composed here
 *  through one parameterized key rather than as two template fragments, so the whole row is one
 *  translatable sentence and the bracket style is the translator's to choose. `state` and `source` are
 *  carried alongside it for any reader that wants the two halves apart (the keeper reads them). */
export function fleshLimbStateOptions() {
  return Object.keys(FLESH_STATUS_LABEL).map(value => {
    const state = localize(FLESH_STATUS_LABEL[value]);
    const source = localize(FLESH_STATUS_SOURCE[value]);
    return { value, state, source, label: localizeParam("FleshLimbStateOptionLabel", { state, source }) };
  });
}

/** True when `state` is one of the recorded flesh-limb states. The closed-domain guard. Pure. */
export function isFleshLimbState(state) {
  return Object.prototype.hasOwnProperty.call(FLESH_STATUS_LABEL, state);
}

/** The states that mean the limb is GONE rather than merely hurt — the destructive direction, which
 *  gets a confirmation step. Same two the hit-location re-roll treats as gone (utils
 *  `_isGoneLimbZone`), so "needs confirming" and "stops being a valid target" agree. */
const LIMB_LOSS_STATES = new Set(["severed", "destroyed"]);

/** The limb zones a GM may directly set a FLESH state on, as a `{ zone: true }` map for the template's
 *  `lookup`: the four limb zones that carry NO structural SDP pool. A chromed zone is excluded because
 *  fleshLimbStatusOf MASKS the flesh record there — setting it would write a flag nothing renders.
 *  GM-ONLY: an empty map for anyone else, so the control never reaches a player's DOM at all
 *  (setFleshLimbState re-checks, so a stale render cannot bypass it either). Pure-ish. */
export function fleshLimbSetZones(actor) {
  if (!game.user?.isGM) return {};
  const out = {};
  for (const zone of LIMB_ZONES) {
    if (cyberlimbSdp(actor, zone).max > 0) continue;
    out[zone] = true;
  }
  return out;
}

/**
 * Record a flesh limb's state directly — the GM's own hand on the record, with the damage pipeline out
 * of the loop. GM-only unconditionally (this is authored injury, not the optional recovery gate that
 * governs repairCyberlimb/clearFleshLimb). Refuses a non-limb zone and any state outside the closed
 * domain, and no-ops when the zone already reads that state. Returns true when it wrote.
 */
export async function setFleshLimbState(actor, zone, state) {
  if (!game.user?.isGM) { ui.notifications?.warn(localize("FleshLimbSetGmOnlyWarn")); return false; }
  if (!LIMB_ZONES.has(zone)) return false;
  if (!isFleshLimbState(state)) return false;
  if (getLimbStatusMap(actor)[zone] === state) return false;   // already recorded — nothing to write
  await actor.update({
    [`flags.${SCOPE}.${FLESH_STATUS_FLAG}.${zone}`]: state
  }, { render: false, fromCyberpunkDamageSystem: true });
  await postSavePromptCard({
    body: localizeParam("FleshLimbSetBody", { limb: localize(zone), state: localize(FLESH_STATUS_LABEL[state]) }),
    speaker: ChatMessage.getSpeaker({ actor })
  });
  return true;
}

/**
 * The sheet gesture behind the body map's state-set control: pick a recorded state for one flesh limb,
 * confirm the destructive direction, write it. Choosing the empty row routes to clearFleshLimb (the
 * existing removal path) — clearing needs no confirmation; choosing a LIMB-LOSS state does.
 * Returns true when the record changed.
 */
export async function openFleshLimbStateDialog(actor, zone) {
  if (!game.user?.isGM) { ui.notifications?.warn(localize("FleshLimbSetGmOnlyWarn")); return false; }
  if (!LIMB_ZONES.has(zone)) return false;
  const current = getLimbStatusMap(actor)[zone] ?? "";
  const render = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  const content = await render(`modules/${SCOPE}/templates/dialog/flesh-limb-state.hbs`, {
    name: actor?.name ?? "",
    limb: localize(zone),
    noneSelected: current === "",
    options: fleshLimbStateOptions().map(o => ({ ...o, selected: o.value === current })),
  });

  // `wait` resolves to the clicked button's callback result — the chosen state for "set", the bare
  // action string for the plain cancel button, and null when the window is dismissed.
  const picked = await foundry.applications.api.DialogV2.wait({
    window: { title: localize("FleshLimbSetTitle"), icon: "fa-solid fa-user-injured" },
    content,
    rejectClose: false,
    buttons: [
      {
        action: "set", default: true, icon: "fa-solid fa-check", label: localize("FleshLimbSetBtn"),
        callback: (ev, btn, dialog) => String(dialog?.element?.querySelector?.("select.cp-flesh-state-pick")?.value ?? ""),
      },
      { action: "cancel", icon: "fa-solid fa-xmark", label: localize("Cancel") },
    ],
  });
  if (picked === null || picked === undefined || picked === "cancel") return false;
  if (picked === current) return false;
  if (picked === "") return clearFleshLimb(actor, zone);

  if (LIMB_LOSS_STATES.has(picked)) {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: localize("FleshLimbSetConfirmTitle") },
      rejectClose: false,
      content: await renderChatCard("confirm-body.hbs", {
        body: localizeParam("FleshLimbSetConfirmBody", {
          name: actor?.name ?? "", limb: localize(zone), state: localize(FLESH_STATUS_LABEL[picked]),
        }),
      }),
      yes: { callback: () => true },
      no: { default: true, callback: () => false },
    });
    if (!ok) return false;
  }
  return setFleshLimbState(actor, zone, picked);
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

/**
 * Hooks: installing a structural implant into a zone clears that zone's sticky `limbStatus` entry.
 * A fresh limb replaces whatever cyberlimb was there: a replaced wreck's destroyed/useless state must
 * leave with the wreck, or the new limb would read destroyed and soak nothing. (Flesh limb wounds
 * live under a separate `fleshLimbStatus` flag now — M18 — so they no longer poison this path; this
 * clear is the cyberlimb-swap guard.) Its SDP pool also restarts at full (the base re-derives `sum`;
 * `current` is whole-object-rewritten to keep the siblings, the same quirk-safe shape
 * absorbCyberlimbHit uses). (The MEAT-limb sever on install is written from the sheet install handler
 * `_cpEquipCyberIntoZone` via severFleshUnder, where the chosen side is authoritative — the create/equip
 * hook fires before the side is finalized, so it cannot target the correct zone.)
 */
/**
 * Post-prep truth pass: a DESTROYED zone's derived `current` reads 0.
 *
 * The base's prep resets any `current` of exactly 0 back to `sum` on every pass (see limbStatusOf for
 * the mechanism), so a destroyed limb rendered its FULL pool — "30 / 30" sitting next to a red
 * DESTROYED badge. That is a straight contradiction on the sheet, and players read the number first.
 * `limbStatus` already holds the truth, so re-assert it onto the derived value here: every reader —
 * the sheet's SDP pair, cyberlimbSdp, cyberlimbStatus — then agrees that a wrecked limb has 0 left.
 *
 * Derived-only: this never writes the document (the stored `current` is already 0 — the base's reset
 * lives in the prepared layer, not on disk), so there is nothing to migrate and nothing to undo. A
 * repair clears the flag, so the next prep leaves the restored number alone. Pure-ish (mutates the
 * actor's prepared data, like the base's own prep does).
 */
export function applyDestroyedLimbSdp(actor) {
  const current = actor?.system?.sdp?.current;
  if (!current) return;
  const store = actor?.getFlag?.(SCOPE, "limbStatus") ?? actor?.flags?.[SCOPE]?.limbStatus ?? {};
  for (const [zone, state] of Object.entries(store)) {
    if (state !== "destroyed") continue;
    if (!(zone in current)) continue;
    current[zone] = 0;
  }
}

export function registerMechCyberlimb() {
  // Wrap prepareData so a destroyed limb's SDP reads 0 instead of the base's reset-to-full (mirrors
  // mech/borg.js's wrap shape). Registered AFTER registerBorg/registerTypedArmorDisplay in
  // cp2020-augmented.js, so `orig` already includes the base prep + the borg chassis-SDP seed and this
  // truth pass lands last.
  const proto = CONFIG?.Actor?.documentClass?.prototype;
  if (proto && !_sdpWrapped) {
    const orig = proto.prepareData;
    proto.prepareData = function () {
      orig.call(this);
      try { applyDestroyedLimbSdp(this); } catch (e) { console.warn(`${SCOPE} | destroyed-limb SDP pass failed`, e); }
    };
    _sdpWrapped = true;
  }

  const clearZoneOnInstall = async (item, userId) => {
    if (userId !== game.user?.id) return;
    const actor = item.actor;
    if (!actor?.isOwner) return;
    if (item.type !== "cyberware" || !item.system?.equipped) return;
    const zone = cyberlimbZoneOf(item, actor.items?.contents ?? []);
    if (!zone) return;
    if (!limbStatusOf(actor, zone)) return;
    const nextCurrent = { ...(actor.system?.sdp?.current ?? {}) };
    delete nextCurrent[zone];   // unset → the base prep re-seeds it to the new sum
    await actor.update({
      "system.sdp.current": nextCurrent,
      ...deleteFieldUpdate(`flags.${SCOPE}.limbStatus.${zone}`)
    }, { render: false, fromCyberpunkDamageSystem: true }).catch(() => {});
  };
  Hooks.on("createItem", (item, options, userId) => clearZoneOnInstall(item, userId));
  Hooks.on("updateItem", (item, changes, options, userId) => {
    if (foundry.utils.getProperty(changes ?? {}, "system.equipped") !== true) return;
    return clearZoneOnInstall(item, userId);
  });

  // M19 notice: the roll pipeline has no held-in-which-hand model, so when an actor with a wrecked
  // ARM uses a weapon, post an informational card naming each affected arm and its state — the GM
  // adjudicates whether that hand was the holding one (notice, never a block). Both a STRUCTURAL
  // cyberlimb arm (destroyed/useless) and any wounded FLESH arm (crippled/disabled/severed/destroyed)
  // qualify; a
  // structural pool supersedes flesh for the same zone (fleshLimbStatusOf already reports "" there).
  // All affected arms collect into a SINGLE card per use event (both arms down = one card, not two).
  // The hook is local to the initiating client, so the card posts exactly once per use.
  Hooks.on("cyberpunk2020.weaponFired", (payload) => {
    try {
      const actor = game.actors.get(payload?.attackerId ?? payload?.actorId ?? "");
      if (!actor || actor.type === "cp2020-augmented.vehicle") return;
      const lines = [];
      for (const zone of ["rArm", "lArm"]) {
        const st = limbStatusOf(actor, zone);
        if (st === "destroyed" || st === "disabled") {
          const stateWord = localize(st === "destroyed" ? "CyberlimbStatusDestroyed" : "CyberlimbStatusUseless");
          lines.push(localizeParam("CyberlimbArmNoticeBody", { name: actor.name, limb: localize(zone), state: stateWord }));
          continue;   // structural pool is authoritative for this zone
        }
        const fs = fleshLimbStatusOf(actor, zone);
        if (fs === "severed" || fs === "disabled" || fs === "destroyed" || fs === "crippled") {
          lines.push(localizeParam("FleshArmNoticeBody", { name: actor.name, limb: localize(zone), state: localize(FLESH_STATUS_LABEL[fs]) }));
        }
      }
      if (!lines.length) return;
      postSavePromptCard({
        title: localize("CyberlimbArmNoticeTitle"),
        body: lines.join("<br>"),
        speaker: ChatMessage.getSpeaker({ actor }),
      });
    } catch (err) {
      console.warn(`${SCOPE} | arm state notice failed:`, err);
    }
  });
}
