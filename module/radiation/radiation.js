/**
 * R1 — Radiation dose subsystem, CORE (RADIATION-PROPOSAL.md + BUILD-SPEC.md "R1 CORE").
 *
 * The book-accurate Deep Space (pp.19–22) radiation model: a cumulative rad DOSE, reduced per turn
 * by a rad-suit's RSP, feeds the confirmed Radiation Effects Table. Crossing a dose band fires that
 * band's effects ONCE (idempotent per band): a gated stat reduction (temporary BODY loss + permanent
 * stat losses), disease susceptibility (GM-adjudicated note), direct HP damage, and an interactive
 * chance-of-death check. This supersedes the old "radiation as a per-hit typed SP" abstraction; the
 * radsuit's `mechTypedSP{radiation}.sp` is reinterpreted as the actor's RSP (R4 removes the per-hit
 * path — untouched here). Everything is opt-in behind the `radiationEnabled` feature toggle.
 *
 * This file MIRRORS module/mech/drug.js almost 1:1 — the same patterns, idioms, and comment density:
 *   - FLAG STATE (no data-model change): `radState` markers ≙ `drugState`; `radExposure`/`radHistory` track
 *     the running/lifetime dose; `radBandCrossed` = the highest band ENTERED this exposure (event idempotency);
 *     `radExposureSeq` = the incident id, so ONE exposure's peak-band row REPLACES its own stat loss (the
 *     effects table is a dose LOOKUP, not cumulative) while SEPARATE incidents ADD.
 *   - STAT OVERLAY — `applyRadiationStatLoss` ≙ `applyMechDrugBoosts`: a prepareData post-step folds
 *     the active markers' (negative) statBoosts onto the base totals, re-deriving MA/BT if touched.
 *     Registered AFTER drug so the order is base → moddy → drug → radiation.
 *   - ROUND TICK — `runRadiationTickOnce` ≙ `runDrugTickOnce`: the active GM counts the current
 *     combatant's TIMED markers down; untimed (permanent-until-cured) markers never auto-expire.
 *   - INTERACTIVE SAVE CARD — the chance-of-death card ≙ the drug/stun/death save card: a Roll button
 *     carrying a SNAPSHOT payload (so it survives) + token-first actor resolution.
 *   - WRITE SERIALIZATION — every flag read-modify-write goes through `enqueueApply` (light.js queue).
 *   - `registerRadiation` ≙ `registerMechDrug`.
 *
 * The temp/perm marker split is drug.js's timed/untimed split: turnsLeft > 0 = temporary (counts down
 * in combat rounds, wears off) ; turnsLeft ≤ 0 = permanent-until-cured (only a GM cure removes it).
 * Radiation stat mods are NEGATIVE (radiation reduces stats) — save the deliberate ATT +1 book quirk
 * at the 401–500 band (total hair loss reads as stylish). Pure helpers are exported for the keeper;
 * the wrapper + hooks are wired by registerRadiation().
 *
 * ── Handlebars card templates referenced (NAME only — a later agent creates these under
 *    modules/cp2020-augmented/templates/chat/) ──
 *   • radiation-dose.hbs          — the dose SUMMARY card. Context: { body } (JS-assembled clauses,
 *                                    the drug-took.hbs pattern).
 *   • radiation-death-prompt.hbs  — the INTERACTIVE chance-of-death card. Context:
 *                                    { actorName, deathPct, btmClause, over, actorId, tokenId, sceneId,
 *                                      checkJson }. MUST render a Roll button:
 *                                      class="cp-rad-death-roll" data-actor-id data-token-id
 *                                      data-scene-id data-check="{{checkJson}}" (mirrors
 *                                      drug-save-prompt.hbs's .cp-drug-save-roll + data-save).
 *   • radiation-death-result.hbs  — the death-check RESULT card. Context:
 *                                    { actorName, result, chance, deathPct, btm, over, died, outcomeClause }.
 *   • radiation-longterm.hbs      — the LONG-TERM effects REFERENCE card (the GM roller; Deep Space p.22).
 *                                    Context: { actorName, history, hasEffects, rows:[{name,detail}],
 *                                    offspring:{roll,result}|null }. Never auto-applies.
 *   • save-prompt.hbs             — EXISTING (reused via postSavePromptCard) for the wear-off / cleared /
 *                                    cured NOTICE cards. Not created here.
 *
 * ── i18n keys referenced (CYBERPUNK.* namespace — a later agent adds these to lang/en.json; NOT
 *    edited here) ──
 *   RadDoseBody, RadRspClause, RadBandsClause, RadNoBandsClause, RadDiseaseClause, RadDamageClause,
 *   RadDeathPostedClause, RadDeathBtmClause, RadDeathFlavor, RadDeathOccursClause,
 *   RadDeathSurvivesClause, RadEffectPassedBody, RadExposureClearedBody, RadCuredBody,
 *   RadiationSourceDefault.  (Reused EXISTING key: SaveNotOwned.)  The card templates above will also
 *   need their own static label keys (card titles, the Roll-button label) — those belong to the
 *   template author.  The long-term roller adds: RadLongTermTitle, RadLongTermIntro, RadLongTermNone,
 *   RadLt<Effect> + RadLt<Effect>Effect (Mutations/MinorCancers/Cataracts/Stillbirths/Leukemia/
 *   ModerateCancers/Sterility/SevereCancers/FatalCancers), RadOffspring<Result> (Favorable/Harmless/
 *   Deformed/Stillbirth), RadOffspringRolled.
 */

import { localize, localizeParam } from "../utils.js";
import { mechRoundTickEnabled } from "../settings.js";
import { postSavePromptCard, renderChatCard } from "../compat.js";
import { onGlobalClick } from "../popout-compat.js";
import { rollDurationTurns } from "../mech/consumable.js";
import { enqueueApply } from "../mech/light.js";
import { applyLocationDamage } from "../combat/DamageApplicator.js";
import { btmFromBT } from "../lookups.js";

const SCOPE = "cp2020-augmented";
const EXPOSURE_FLAG     = "radExposure";      // number — CURRENT-exposure cumulative rads (effects table keys on this)
const HISTORY_FLAG      = "radHistory";       // number — LIFETIME rads (monotonic; the long-term roller keys on this)
const BAND_CROSSED_FLAG = "radBandCrossed";   // number — highest band min ENTERED this exposure (event idempotency)
const SEQ_FLAG          = "radExposureSeq";   // number — current incident id; bumped each new exposure so a fresh
                                              //          incident's stat loss ADDS to prior incidents' (its markers
                                              //          keep the old seq) while WITHIN one exposure the peak band's
                                              //          row REPLACES (the effects table is a dose lookup).
const RAD_FLAG          = "radState";         // marker[] — stat-loss overlays (the drugState analogue); each tagged {seq}

// The Radiation Effects Table columns are book-friendly stat NAMES; the actor's stat schema keys them
// differently (BODY = Body Type "bt"; ATT = Attractiveness "attr"). Map friendly → system key at the
// marker-build seam so the overlay (which does stats[key]) actually lands on a real stat — a mismatch
// would silently no-op. (Verified against systems/cyberpunk2020 template.json: int/ref/tech/cool/attr/
// luck/ma/bt/emp.)
const STAT_KEY = { body: "bt", ref: "ref", att: "attr", int: "int", cool: "cool" };

/**
 * Whether the optional Deep Space radiation subsystem is enabled. Read DEFENSIVELY (try/catch → false),
 * exactly like drug.js reads its toggles: the `radiationEnabled` world setting is registered by R3, so
 * until then (and whenever it is off) the whole subsystem is inert. Default OFF — it is an opt-in
 * subsystem, not core play.
 */
function radiationEnabled() {
  try { return game.settings.get(SCOPE, "radiationEnabled") === true; } catch { return false; }
}

/**
 * ✅ CONFIRMED Radiation Effects Table (RADIATION-PROPOSAL.md, user-confirmed 2026-07-11; Deep Space p.21),
 * transcribed EXACTLY — do NOT invent or "fix" a value. Ordered ascending by dose band `min`:
 *   { min, statRedPct, tempBody:{amt,dur}, perm:{body,ref,att,int,cool}, diseasePct, damage,
 *     deathPct, deathBtm, deathOver }
 * where `dur`/`damage` are dice STRINGS ("2D10+4", "1D6-2", "" = none) and perm values are SIGNED ints
 * (0 = none). Notes on the faithful transcription:
 *   - `tempBody.amt` is the positive MAGNITUDE; the applied mod is −amt. `dur` is the book duration with
 *     its hour/day unit stripped to a bare dice string (the spec's example: "2D10+4 hr" → "2D10+4"),
 *     fed to rollDurationTurns → a countdown in combat rounds (drug.js's short-drug/timed path). The
 *     ">5000" temp loss is book "per 8 hr" (recurring) — modelled as dur "" → turnsLeft 0 → UNTIMED
 *     (permanent-until-cured), the faithful mapping of an open-ended loss onto drug.js's untimed slot.
 *   - Damage dice use ASCII "-" ("1D6-2") so `new Roll()` parses them (the table prints a Unicode minus).
 *   - ATT is +1 at 401–500 — a DELIBERATE book quirk (patchy hair loss is ugly → −2; TOTAL hair loss is
 *     stylish → +1). Keep the positive sign.
 *   - `deathBtm` (added to the spec's listed shape because the "+BTM" mechanic needs it): true where the
 *     printed death chance reads "N%+BTM". `deathOver` is a DISPLAY-only timeframe (never rolled).
 */
export const RAD_EFFECTS = [
  // <50 rads — below the 50-rad harm threshold (Deep Space p.19): no effect.
  { min: 0,    statRedPct: 0,   tempBody: { amt: 0, dur: "" },       perm: { body:  0, ref:  0, att:  0, int:  0, cool:  0 }, diseasePct:   0, damage: "",       deathPct:   0, deathBtm: false, deathOver: "" },
  // 50–100
  { min: 50,   statRedPct: 5,   tempBody: { amt: 1, dur: "2D10+4" }, perm: { body:  0, ref:  0, att:  0, int:  0, cool:  0 }, diseasePct:   0, damage: "",       deathPct:   0, deathBtm: false, deathOver: "" },
  // 101–200
  { min: 101,  statRedPct: 40,  tempBody: { amt: 1, dur: "2D10+4" }, perm: { body:  0, ref: -1, att:  0, int:  0, cool:  0 }, diseasePct:  10, damage: "",       deathPct:   2, deathBtm: true,  deathOver: "2 mo" },
  // 201–300
  { min: 201,  statRedPct: 70,  tempBody: { amt: 2, dur: "2D10+4" }, perm: { body:  0, ref: -1, att:  0, int:  0, cool:  0 }, diseasePct:  30, damage: "",       deathPct:   7, deathBtm: true,  deathOver: "2 mo" },
  // 301–400
  { min: 301,  statRedPct: 90,  tempBody: { amt: 2, dur: "1D6/2" },  perm: { body: -1, ref: -1, att: -2, int:  0, cool:  0 }, diseasePct:  60, damage: "1D6-2",  deathPct:  30, deathBtm: true,  deathOver: "1D6-1 wk" },
  // 401–500 — ATT +1 is the deliberate book quirk (total hair loss reads as stylish); keep the sign.
  { min: 401,  statRedPct: 100, tempBody: { amt: 1, dur: "1D6+1" },  perm: { body: -1, ref:  0, att:  1, int:  0, cool:  0 }, diseasePct: 100, damage: "1D6",    deathPct:  50, deathBtm: true,  deathOver: "3D10 days" },
  // 501–750
  { min: 501,  statRedPct: 100, tempBody: { amt: 1, dur: "1D10+4" }, perm: { body: -1, ref: -1, att:  0, int:  0, cool:  0 }, diseasePct: 100, damage: "1D10-2", deathPct:  75, deathBtm: true,  deathOver: "3D6+2 days" },
  // 751–1000
  { min: 751,  statRedPct: 100, tempBody: { amt: 1, dur: "2D10+1" }, perm: { body: -1, ref: -1, att:  0, int:  0, cool:  0 }, diseasePct: 100, damage: "1D10",   deathPct:  90, deathBtm: false, deathOver: "1D10+4 days" },
  // 1001–5000
  { min: 1001, statRedPct: 100, tempBody: { amt: 2, dur: "3D10" },   perm: { body: -1, ref: -1, att: -1, int: -2, cool: -2 }, diseasePct: 100, damage: "2D6",    deathPct:  95, deathBtm: false, deathOver: "1D6+1 days" },
  // >5000 — temp loss is book "per 8 hr" (recurring) → modelled UNTIMED (dur "" → turnsLeft 0) until cured.
  { min: 5001, statRedPct: 100, tempBody: { amt: 1, dur: "" },       perm: { body: -1, ref: -2, att: -1, int: -3, cool: -3 }, diseasePct: 100, damage: "2D10",   deathPct: 100, deathBtm: false, deathOver: "5D10 hr" },
];

/* ══════════════════════════════════ Pure helpers (exported for the keeper) ══════════════════════════════════ */

/**
 * The actor's Radiation Stopping Power: the BEST equipped rad-suit's RSP — MAX (not sum) of every
 * equipped item's `mechTypedSP.sp` where its type is "radiation" (you wear ONE suit). This is the same
 * data the old per-hit typed-armor path read; here it becomes a flat per-turn rads subtraction that
 * never ablates. Pure.
 */
export function actorRSP(actor) {
  let best = 0;
  for (const i of actor?.items?.contents ?? []) {
    if (!i?.system?.equipped) continue;
    const typed = i.system?.mechTypedSP;
    if (typed?.type !== "radiation") continue;
    best = Math.max(best, Number(typed.sp) || 0);
  }
  return best;
}

/**
 * The band whose half-open interval [min, nextMin) contains `dose` (>5000 → the last band). RAD_EFFECTS
 * is ascending, so the last band with min ≤ dose is the containing one. Pure.
 */
export function bandForDose(dose) {
  const d = Number(dose) || 0;
  let found = RAD_EFFECTS[0];
  for (const band of RAD_EFFECTS) {
    if (d >= band.min) found = band;
    else break;
  }
  return found;
}

/** True if the band carries ANY nonzero permanent stat change. Pure. */
function hasPerm(band) {
  const p = band?.perm ?? {};
  return !!(p.body || p.ref || p.att || p.int || p.cool);
}

/** Active radiation markers on the actor (the radState flag → array). Pure. Mirrors drugMarkersFor. */
export function radMarkersFor(actor) {
  const raw = actor?.getFlag?.(SCOPE, RAD_FLAG) ?? actor?.flags?.[SCOPE]?.[RAD_FLAG];
  return Array.isArray(raw) ? raw : (raw ? [raw] : []);
}

/** Current-exposure cumulative rads. Pure. */
export function actorExposure(actor) { return Number(actor?.getFlag?.(SCOPE, EXPOSURE_FLAG)) || 0; }
/** Lifetime rads (monotonic). Pure. */
export function actorHistory(actor)  { return Number(actor?.getFlag?.(SCOPE, HISTORY_FLAG))  || 0; }
/** The highest band min ENTERED this exposure (event idempotency — damage/death fire once per new peak). Pure. */
export function actorBandCrossed(actor) { return Number(actor?.getFlag?.(SCOPE, BAND_CROSSED_FLAG)) || 0; }
/** The current incident id (bumped each new exposure). Pure. */
export function actorExposureSeq(actor) { return Number(actor?.getFlag?.(SCOPE, SEQ_FLAG)) || 0; }

/** One tick over rad markers: { surviving, expired }. Untimed markers (turnsLeft ≤ 0) never expire.
 *  Pure — the EXACT mirror of tickDrugMarkers. */
export function tickRadMarkers(markers) {
  const surviving = [];
  const expired = [];
  for (const m of markers ?? []) {
    const t = Number(m?.turnsLeft) || 0;
    if (t <= 0) { surviving.push(m); continue; }   // untimed (permanent): lasts until a GM cure
    const left = t - 1;
    if (left <= 0) expired.push(m);
    else surviving.push({ ...m, turnsLeft: left });
  }
  return { surviving, expired };
}

/** Human summary of a marker's stat changes ("BT −1, REF −1"), or "". Pure. */
export function radStatSummary(marker) {
  const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
  const parts = [];
  for (const b of marker?.statBoosts ?? []) if (b.mod) parts.push(`${String(b.stat).toUpperCase()} ${signed(b.mod)}`);
  return parts.join(", ");
}

/* ══════════════════════════════════ Impure helpers ══════════════════════════════════ */

/** Roll a damage dice string ("1D6-2", "2D10") → a non-negative integer (0 floor). Impure (dice).
 *  The rollDurationTurns shape, but for HP: "1D6-2" can roll below 0, so clamp. */
async function rollDamageAmount(spec) {
  const s = String(spec ?? "").trim();
  if (!s) return 0;
  try {
    const roll = await new Roll(s).evaluate();
    return Math.max(0, Math.floor(Number(roll.total) || 0));
  } catch (e) {
    console.warn(`${SCOPE} | radiation damage "${s}" is not rollable`, e);
    return 0;
  }
}

/** The raw source label for a marker (may be ""), localizing the generic fallback only at DISPLAY time
 *  so a stored flag never freezes the UI language. */
function sourceName(sourceLabel) {
  const s = String(sourceLabel ?? "").trim();
  return s || localize("RadiationSourceDefault");
}

/** The actor's on-canvas token (placeable) best-effort, for applyLocationDamage's wound-severity
 *  targeting; null when none is drawn. Token-actors carry their own token. */
function tokenForActor(actor) {
  if (!actor) return null;
  if (actor.isToken) return actor.token?.object ?? null;
  return canvas?.tokens?.placeables?.find(t => t.actor?.id === actor.id) ?? null;
}

/** Build the stat-loss markers a band contributes on a successful stat-reduction gate: ONE timed TEMP
 *  BODY marker (turnsLeft from the rolled duration) plus ONE untimed marker per nonzero PERM stat
 *  (turnsLeft 0 = permanent-until-cured). Friendly stat names are mapped to system keys here so the
 *  overlay lands on a real stat. Impure (rolls the temp duration). */
async function buildBandStatMarkers(band, sourceLabel, seq) {
  const source = String(sourceLabel ?? "");
  const out = [];
  if (band.tempBody.amt > 0) {
    // A book hour/day duration is stored as a bare dice string → counts down in combat rounds (drug.js's
    // short-drug path); a "" dur (the >5000 recurring loss) yields 0 turns → an untimed marker.
    const turns = await rollDurationTurns(band.tempBody.dur);
    out.push({
      source, band: band.min, seq,
      statBoosts: [{ stat: STAT_KEY.body, mod: -band.tempBody.amt }],   // BODY loss is NEGATIVE
      turnsLeft: turns
    });
  }
  for (const friendly of ["body", "ref", "att", "int", "cool"]) {
    const mod = Number(band.perm[friendly]) || 0;
    if (!mod) continue;   // 0 = no change (skip); nonzero includes the deliberate ATT +1 at 401–500
    out.push({
      source, band: band.min, seq,
      statBoosts: [{ stat: STAT_KEY[friendly], mod }],
      turnsLeft: 0   // permanent-until-cured
    });
  }
  return out;
}

/** Replace THIS exposure's radiation markers (seq === curSeq) with the current band's full row, keeping every
 *  prior incident's markers — so WITHIN one exposure the peak band's row REPLACES (the effects table is a dose
 *  lookup, never cumulative) while SEPARATE incidents ACCUMULATE. Serialized per actor (light.js queue) like
 *  setDrugMarker. Passing an empty row clears just this incident's markers. */
async function replaceExposureMarkers(actor, curSeq, bandMarkers) {
  return enqueueApply(actor, async () => {
    const kept = radMarkersFor(actor).filter(m => Number(m?.seq) !== curSeq);   // prior incidents persist
    const next = [...kept, ...(bandMarkers ?? [])];
    if (next.length) await actor.setFlag(SCOPE, RAD_FLAG, next);
    else await actor.unsetFlag(SCOPE, RAD_FLAG);
  });
}

/* ══════════════════════════════════ Cards ══════════════════════════════════ */

/** The dose SUMMARY card (JS-assembled clauses, the postTookCard pattern): dose taken, RSP stopped, net
 *  dose, new exposure/lifetime totals, and conditional clauses for the bands fired / disease
 *  susceptibility / HP damage / a posted death check. */
async function postRadiationSummaryCard(actor, info) {
  const { raw, rsp, net, exposure, history, bands, diseaseNotes, damageDealt, deathPosted, sourceLabel } = info;
  const firedMins = bands.map(b => b.min);
  const rspClause     = rsp > 0                ? localizeParam("RadRspClause", { rsp })                                 : "";
  const bandsClause   = firedMins.length       ? localizeParam("RadBandsClause", { bands: firedMins.join(", ") })      : localize("RadNoBandsClause");
  const diseaseClause = diseaseNotes.length    ? localizeParam("RadDiseaseClause", { pct: Math.max(...diseaseNotes) }) : "";
  const damageClause  = damageDealt > 0        ? localizeParam("RadDamageClause", { amount: damageDealt })             : "";
  const deathClause   = deathPosted            ? localize("RadDeathPostedClause")                                      : "";
  const body = localizeParam("RadDoseBody", {
    name: actor.name, source: sourceName(sourceLabel),
    dose: raw, rspClause, net, exposure, history,
    bandsClause, diseaseClause, damageClause, deathClause
  });
  const content = await renderChatCard("radiation-dose.hbs", { body });
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
}

/**
 * Post the INTERACTIVE chance-of-death card (mirrors the drug/stun/death save card). The Roll button
 * carries the SNAPSHOT `checkJson` so the check stays resolvable after the card scrolls off; tokenId/
 * sceneId land an unlinked combatant's roll on its own token actor. The actual roll (with the live BTM
 * for "+BTM" rows) runs in executeRadiationDeathCheck.
 */
async function postRadiationDeathCard(actor, band, sourceLabel) {
  const check = {
    band: band.min, deathPct: band.deathPct, deathBtm: !!band.deathBtm,
    deathOver: band.deathOver, source: String(sourceLabel ?? "")
  };
  const content = await renderChatCard("radiation-death-prompt.hbs", {
    actorName: actor.name,
    deathPct: band.deathPct,
    btmClause: band.deathBtm ? localize("RadDeathBtmClause") : "",
    over: band.deathOver,
    actorId: actor.id,
    tokenId: actor.isToken ? (actor.token?.id ?? "") : "",
    sceneId: actor.isToken ? (actor.token?.parent?.id ?? "") : "",
    checkJson: JSON.stringify(check)
  });
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
}

/** The "a temporary radiation effect passes" note when a timed marker wears off (the postWoreOffCard
 *  NOTICE idiom). */
async function postRadEffectPassedCard(actor, marker) {
  await postSavePromptCard({
    body: localizeParam("RadEffectPassedBody", { name: actor.name, source: sourceName(marker.source) }),
    speaker: ChatMessage.getSpeaker({ actor })
  });
}

/* ══════════════════════════════════ Engine ══════════════════════════════════ */

/**
 * Apply a radiation dose to an actor (a zone tick, or the GM apply-dose tool). GM/owner-gated. Folds the
 * (RSP-reduced) net rads into exposure + lifetime history, claims every newly-crossed band ONCE, and
 * resolves each band's effects.
 *
 *   net = perTurn ? max(0, rawRads − RSP) : rawRads.  (A direct GM dose may pass perTurn=false to bypass
 *   the suit; a zone/reactor tick passes true so the rad-suit subtracts its RSP that turn.)
 *
 * The exposure/history/bandsFired read-modify-write is serialized per actor (light.js queue) and does
 * the "which bands fire THIS call" decision ATOMICALLY — two doses landing quickly can neither
 * double-fire a band nor lose an increment. The dice + cards + marker writes run AFTER, outside the
 * lock. Not feature-gated itself (an explicit dose applies, like drug.js's takeDrug) — only GM/owner
 * gated; the PASSIVE automation (overlay/tick/button) is what the radiationEnabled toggle gates.
 */
export async function applyRadiationDose(actor, rawRads, { perTurn = true, sourceLabel = "", announce = true } = {}) {
  if (!actor) return null;
  if (!(game.user.isGM || actor.isOwner)) return null;   // GM/owner only ever writes (zone ticks run on the active GM)
  const raw = Math.max(0, Number(rawRads) || 0);
  if (raw <= 0) return null;

  const rsp = perTurn ? actorRSP(actor) : 0;
  const net = perTurn ? Math.max(0, raw - rsp) : raw;

  // Atomic fold + peak-band claim (serialized): add net to exposure + lifetime history, and decide whether we
  // have ENTERED a new, higher peak band this exposure. The effects table is a DOSE LOOKUP — only the band that
  // CONTAINS the current total applies (bandForDose), never the intermediate rows — so a dose jumping several
  // bands fires ONE band's effects, and a character's stat loss never exceeds a printed row. When the suit fully
  // absorbs the dose (net = 0) NOTHING is written (a per-turn zone tick under a rad-suit must not re-prepare the
  // actor each round) — the summary card still reports the block.
  let exposure = actorExposure(actor), history = actorHistory(actor);
  let curBand = null, seq = actorExposureSeq(actor) || 1;
  if (net > 0) {
    await enqueueApply(actor, async () => {
      exposure = actorExposure(actor) + net;
      history  = actorHistory(actor)  + net;
      seq      = actorExposureSeq(actor) || 1;              // 0 (never exposed) → this first incident is seq 1
      const bandNow = bandForDose(exposure);
      if (bandNow.min > actorBandCrossed(actor)) curBand = bandNow;   // a NEW, higher peak — resolve it once
      await actor.setFlag(SCOPE, EXPOSURE_FLAG, exposure);
      await actor.setFlag(SCOPE, HISTORY_FLAG, history);
      if (curBand) await actor.setFlag(SCOPE, BAND_CROSSED_FLAG, curBand.min);
      if (!actorExposureSeq(actor)) await actor.setFlag(SCOPE, SEQ_FLAG, seq);   // stamp the first incident's id
    });
  }

  // Resolve the SINGLE new peak band (if any). Only one band's events fire, even on a multi-band jump.
  const diseaseNotes = [];
  let damageDealt = 0, deathPosted = false;
  if (curBand && curBand.min > 0) {
    // Stat reductions: ONE 1d100 gates the whole row (temp BODY + every perm stat). On success the current
    // band's FULL row REPLACES this exposure's prior radiation stat loss (dose lookup) — other incidents'
    // markers persist; on a FAILED gate this exposure keeps the last band's row it passed.
    if (curBand.statRedPct > 0 && (curBand.tempBody.amt > 0 || hasPerm(curBand))) {
      const gate = await new Roll("1d100").evaluate();
      if (gate.total <= curBand.statRedPct) {
        const markers = await buildBandStatMarkers(curBand, sourceLabel, seq);
        await replaceExposureMarkers(actor, seq, markers);
      }
    }
    // Disease: a susceptibility % — noted on the summary card for the GM, never auto-applied.
    if (curBand.diseasePct > 0) diseaseNotes.push(curBand.diseasePct);
    // Damage: DIRECT HP via the shared apply path — NO SP, NO BTM (radiation is not a per-hit SP hit).
    // Torso, penetrates:true; netDamage == structuralDamage == the rolled amount (a full-borg Torso takes the
    // same flat hit through the SDP route). Mirrors the fire-DOT call, minus the BTM subtract.
    if (curBand.damage) {
      const dmg = await rollDamageAmount(curBand.damage);
      if (dmg > 0) {
        damageDealt += dmg;
        await applyLocationDamage({
          target: actor, location: "Torso",
          netDamage: dmg, structuralDamage: dmg, penetrates: true,
          token: tokenForActor(actor)
        });
      }
    }
    // Death: post the interactive chance-of-death card (resolved by the GM/owner via its Roll button).
    if (curBand.deathPct > 0) { await postRadiationDeathCard(actor, curBand, sourceLabel); deathPosted = true; }
  }

  // Announce discipline: a one-off GM dose (announce default true) always reports; a per-turn ZONE tick
  // passes announce:false so ROUTINE accrual (no new band) is SILENT — radiation is insidious, and a
  // persistent zone would otherwise post a card per token per round while doses merely climb. A band-
  // crossing (or any HP damage / death check) always reports, even from a zone. The sheet readout (R3)
  // tracks the accruing total, so silent accrual is still visible to the GM.
  const fired = !!(curBand && curBand.min > 0);
  if (announce || fired || damageDealt > 0 || deathPosted) {
    await postRadiationSummaryCard(actor, {
      raw, rsp, net, exposure, history,
      bands: fired ? [curBand] : [],
      diseaseNotes, damageDealt, deathPosted, sourceLabel
    });
  }
  return { net, exposure, history, bandFired: fired ? curBand.min : null, damageDealt, deathPosted };
}

/**
 * End the current exposure event (GM control): reset radExposure + radBandsFired so a FRESH exposure
 * re-arms every band, while lifetime radHistory is KEPT (monotonic). Serialized per actor.
 */
export async function clearExposure(actor) {
  if (!actor) return;
  if (!(game.user.isGM || actor.isOwner)) return;
  await enqueueApply(actor, async () => {
    // End the incident: reset the running dose + peak band, and BUMP the incident id so the NEXT exposure's
    // stat loss ADDS to this one's (its markers keep the old seq and persist). Lifetime radHistory is KEPT.
    await actor.unsetFlag(SCOPE, EXPOSURE_FLAG);
    await actor.unsetFlag(SCOPE, BAND_CROSSED_FLAG);
    await actor.setFlag(SCOPE, SEQ_FLAG, (actorExposureSeq(actor) || 1) + 1);
  });
  await postSavePromptCard({
    body: localizeParam("RadExposureClearedBody", { name: actor.name }),
    speaker: ChatMessage.getSpeaker({ actor })
  });
}

/**
 * Cure radiation stat loss (GM control — drugs / therapy / surgery per the book). By default removes the
 * PERMANENT (untimed) markers and leaves the temporary ones running; { temp:true } also clears the
 * temporaries. Serialized per actor; re-prepares on the flag write so the stats recover.
 */
export async function cureRadiation(actor, { temp = false, perm = true } = {}) {
  if (!actor) return;
  if (!(game.user.isGM || actor.isOwner)) return;
  let removed = 0;
  await enqueueApply(actor, async () => {
    const markers = radMarkersFor(actor);
    const kept = markers.filter(m => {
      const timed = (Number(m?.turnsLeft) || 0) > 0;
      if (timed && temp)  { removed++; return false; }   // temporary (counts down)
      if (!timed && perm) { removed++; return false; }   // permanent-until-cured
      return true;
    });
    if (kept.length) await actor.setFlag(SCOPE, RAD_FLAG, kept);
    else await actor.unsetFlag(SCOPE, RAD_FLAG);
  });
  await postSavePromptCard({
    body: localizeParam("RadCuredBody", { name: actor.name, count: removed }),
    speaker: ChatMessage.getSpeaker({ actor })
  });
}

/**
 * The prepareData post-step: fold every active radiation marker's stat losses onto the actor's
 * already-computed stat totals, record the contributions (for tooltips), and re-derive movement/body
 * if a marker touches MA/BT. The EXACT mirror of applyMechDrugBoosts — it runs AFTER the base stat pass
 * AND after the drug overlay (registerRadiation wraps last), i.e. radiation lands on top of the already-
 * boosted total. Mutates prepared data only; never persists.
 */
export function applyRadiationStatLoss(actor) {
  if (!actor || (actor.type !== "character" && actor.type !== "npc")) return;
  const stats = actor.system?.stats;
  if (!stats) { actor._radStatMods = null; return; }
  const markers = radMarkersFor(actor);
  if (!markers.length) { actor._radStatMods = null; return; }

  const contrib = {};   // stat → [{ source, value }]
  let touchedMA = false, touchedBT = false;
  for (const m of markers) {
    for (const b of m.statBoosts ?? []) {
      const key = String(b.stat ?? "").toLowerCase();
      const stat = stats[key];
      const mod = Number(b.mod) || 0;
      if (!stat || !mod) continue;
      stat.total = (Number(stat.total) || 0) + mod;   // radiation mods are negative (save the ATT +1 quirk)
      (contrib[key] ??= []).push({ source: m.source, value: mod });
      if (key === "ma") touchedMA = true;
      if (key === "bt") touchedBT = true;
    }
  }

  if (touchedMA && stats.ma) {
    stats.ma.run = stats.ma.total * 3;
    stats.ma.leap = Math.floor(stats.ma.run / 4);
  }
  if (touchedBT && stats.bt) {
    stats.bt.carry = stats.bt.total * 10;
    stats.bt.lift = stats.bt.total * 40;
    stats.bt.modifier = btmFromBT(stats.bt.total);
  }

  actor._radStatMods = Object.keys(contrib).length ? contrib : null;
}

/**
 * Count the CURRENT combatant's TIMED radiation markers down by one turn: wear off any that reach zero
 * (posting the "temporary effect passes" note) and persist the survivors. Untimed markers (turnsLeft ≤ 0
 * — the permanent-until-cured losses) are left untouched. The EXACT mirror of runDrugTickOnce; no
 * settings gate here (the updateCombat handler gates before calling). Exported for a GM manual-tick button.
 */
export async function runRadiationTickOnce(combat) {
  const actor = combat?.combatant?.actor;
  if (!actor) return;
  const markers = radMarkersFor(actor);
  if (!markers.length) return;
  const { surviving, expired } = tickRadMarkers(markers);
  // Persist whenever a timed marker exists (its turnsLeft just changed); early-out ONLY when everything
  // is untimed (nothing to count down) — mirrors runDrugTickOnce.
  if (!expired.length && !markers.some(m => (Number(m?.turnsLeft) || 0) > 0)) return;
  if (surviving.length) await actor.setFlag(SCOPE, RAD_FLAG, surviving);
  else await actor.unsetFlag(SCOPE, RAD_FLAG);
  for (const m of expired) await postRadEffectPassedCard(actor, m);
}

/**
 * Resolve the chance-of-death check (the death card's Roll button). Rolls 1d100 against the band's death
 * chance; "+BTM" rows adjust the chance by the actor's Body Type Modifier. On a roll ≤ the chance the GM
 * is told death occurs over the printed timeframe — this NEVER auto-kills (radiation death unfolds over
 * days/months; the GM adjudicates). Owner/GM only (mirrors the stun/death save gate); token-first actor
 * resolution so an unlinked combatant resolves on its own token actor.
 *
 * BTM sign: the table prints the death rows as "N%+BTM". In CP2020 the Body Type Modifier is canonically
 * a NEGATIVE number (a harm-reducer, e.g. −2), so a tougher body LOWERS its death chance. This codebase
 * stores BTM as a POSITIVE magnitude (btmFromBT → stats.bt.modifier) — the very value fire-DOT SUBTRACTS
 * to soften a burn — so we SUBTRACT it here too. (Resolved ambiguity — see the build report.)
 */
export async function executeRadiationDeathCheck({ actorId, tokenId, sceneId, check = null }) {
  const tokenActor = tokenId && sceneId ? game.scenes.get(sceneId)?.tokens?.get(tokenId)?.actor : null;
  const actor = tokenActor ?? game.actors.get(actorId);
  if (!actor) return;
  if (!(game.user.isGM || actor.isOwner)) {
    ui.notifications?.warn(localizeParam("SaveNotOwned", { name: actor.name }));
    return;
  }

  const deathPct  = Number(check?.deathPct) || 0;
  const deathBtm  = !!check?.deathBtm;
  const deathOver = String(check?.deathOver ?? "");
  const btm = deathBtm ? (Number(actor.system?.stats?.bt?.modifier) || 0) : 0;
  const chance = Math.max(0, deathPct - btm);

  const roll = await new Roll("1d100").evaluate();
  const died = roll.total <= chance;   // ≤ chance = death occurs (over the timeframe)

  const content = await renderChatCard("radiation-death-result.hbs", {
    actorName: actor.name,
    result: roll.total, chance, deathPct, btm, over: deathOver, died,
    outcomeClause: died ? localizeParam("RadDeathOccursClause", { over: deathOver })
                        : localize("RadDeathSurvivesClause")
  });
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: localizeParam("RadDeathFlavor", { chance }),
    content
  });
  // Deliberately NO status change — the GM decides how the timeframe plays out.
}

/* ══════════════════════════════════ Long-term effects (GM roller) ══════════════════════════════════ */

/**
 * The LONG-TERM Radiation Effects table (Deep Space p.22, user-confirmed 2026-07-11), keyed by LIFETIME
 * radiation history (the monotonic radHistory flag). Unlike the immediate effects table, this one is
 * EXPLICITLY Referee's judgment (p.19: "depend more on Referee discretion than on dice rolling") and
 * unfolds over game-YEARS — so the roller is a REFERENCE card: it lists which effects have onset at the
 * actor's lifetime dose (with the book's dynamic odds) and rolls the one concrete sub-table (offspring
 * mutation). It NEVER auto-applies a stat/status change (the ratified automation boundary: immediate
 * effects automated, long-term effects a GM roller). Onset doses transcribed EXACTLY; the two rows the
 * book prints with a BLANK dose column (Stillbirths, Moderate Cancers) are grouped under the dose
 * directly above them (300 / 400) per the user's 2026-07-11 confirmation. `offspring:true` marks the row
 * whose "See below" points at the Offspring Mutation Table. Ordered ascending by onset `min`.
 */
export const RAD_LONGTERM = [
  { min: 100, key: "Mutations", offspring: true },
  { min: 200, key: "MinorCancers"    },
  { min: 300, key: "Cataracts"       },
  { min: 300, key: "Stillbirths"     },
  { min: 400, key: "Leukemia"        },
  { min: 400, key: "ModerateCancers" },
  { min: 450, key: "Sterility"       },
  { min: 600, key: "SevereCancers"   },
  { min: 750, key: "FatalCancers"    },
];

/**
 * The Offspring Mutation Table (Deep Space p.22, user-confirmed): a 1d10 rolled when a character with
 * ≥100 rads of lifetime history has offspring. Half-open bands by roll; transcribed exactly. The
 * "Deformed" result's stat loss is Referee-determined and applies to the OFFSPRING (an NPC) — never to
 * the irradiated character — so this roller only REPORTS the rolled result.
 */
export const OFFSPRING_MUTATION = [
  { min: 1, max:  1, key: "Favorable"  },
  { min: 2, max:  3, key: "Harmless"   },
  { min: 4, max:  7, key: "Deformed"   },
  { min: 8, max: 10, key: "Stillbirth" },
];

/** Long-term rows whose onset dose ≤ the lifetime history. Pure (exported for the keeper). */
export function longTermEffectsFor(history) {
  const h = Number(history) || 0;
  return RAD_LONGTERM.filter((r) => h >= r.min);
}

/** Permanent-sterility chance % at a lifetime history (Deep Space p.22 step function). Pure. */
export function sterilityChancePct(history) {
  const h = Number(history) || 0;
  if (h >= 750) return 100;
  if (h >= 650) return 99;
  if (h >= 600) return 90;
  if (h >= 550) return 50;
  if (h >= 500) return 25;
  if (h >= 450) return 10;
  return 0;
}

/** Leukemia odds at a lifetime history: 1-in-300 at 400 rads, DOUBLING every +50 (Deep Space p.22).
 *  Returns { denom, pct } (1-in-`denom`, ≈`pct`%), or null below the 400-rad onset. Pure. */
export function leukemiaOdds(history) {
  const h = Number(history) || 0;
  if (h < 400) return null;
  const doublings = Math.floor((h - 400) / 50);
  const denom = 300 / Math.pow(2, doublings);      // 1 in `denom`; halves each doubling as the chance doubles
  const pct = Math.min(100, 100 / denom);
  return { denom: Math.max(1, Math.round(denom)), pct: Math.round(pct * 10) / 10 };
}

/** The offspring-mutation band containing a 1d10 roll. Pure. */
export function offspringResultFor(roll) {
  const r = Number(roll) || 0;
  return OFFSPRING_MUTATION.find((b) => r >= b.min && r <= b.max) ?? OFFSPRING_MUTATION[OFFSPRING_MUTATION.length - 1];
}

/** Roll the Offspring Mutation Table (1d10) → { roll, band }. Impure (dice). */
async function rollOffspringMutation() {
  const roll = await new Roll("1d10").evaluate();
  const total = Number(roll.total) || 0;
  return { roll: total, band: offspringResultFor(total) };
}

/**
 * Post the LONG-TERM effects REFERENCE card for an actor (the panel's "Long-Term Effects" button / a GM
 * tool). Lists every long-term effect whose onset dose ≤ the actor's LIFETIME history — the dynamic book
 * odds (sterility %, leukemia 1-in-N) assembled as clauses in JS, the template just loops (Tilt's way) —
 * and, once the character has reached the Mutations threshold (≥100 lifetime rads), rolls the Offspring
 * Mutation Table once and reports it. NEVER auto-applies a stat/status change: long-term radiation is
 * Referee-adjudicated over game-years. GM/owner gated (mirrors the other radiation controls).
 */
export async function postLongTermCard(actor) {
  if (!actor) return;
  if (!(game.user.isGM || actor.isOwner)) return;
  const history = actorHistory(actor);
  const effects = longTermEffectsFor(history);

  // Localized rows built here (dynamic content assembled in JS; the template only loops).
  const rows = effects.map((r) => {
    let detail;
    if (r.key === "Sterility") {
      detail = localizeParam("RadLtSterilityEffect", { pct: sterilityChancePct(history) });
    } else if (r.key === "Leukemia") {
      const o = leukemiaOdds(history);
      detail = localizeParam("RadLtLeukemiaEffect", { denom: o?.denom ?? 300, pct: o?.pct ?? 0.3 });
    } else {
      detail = localize(`RadLt${r.key}Effect`);
    }
    return { name: localize(`RadLt${r.key}`), detail };
  });

  // Offspring mutation: rolled once when the character has reached the Mutations onset. Reported, never applied.
  let offspring = null;
  if (history >= 100) {
    const { roll, band } = await rollOffspringMutation();
    offspring = { roll, result: localize(`RadOffspring${band.key}`) };
  }

  const content = await renderChatCard("radiation-longterm.hbs", {
    actorName: actor.name,
    history,
    hasEffects: rows.length > 0,
    rows,
    offspring,
  });
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
}

/* ══════════════════════════════════ Registration ══════════════════════════════════ */

let _wrapped = false;
export function registerRadiation() {
  // Overlay: wrap prepareData once so the radiation stat loss applies AFTER the base stat pass — and
  // after the drug overlay, so long as registerRadiation() is invoked AFTER registerMechDrug() (order:
  // base → moddy → drug → radiation). Same reason stat-mods.js/drug.js wrap prepareData. Gated by the
  // feature toggle inside the wrap so a live toggle enables/disables it without a re-wrap.
  const proto = CONFIG?.Actor?.documentClass?.prototype;
  if (proto && !_wrapped) {
    const orig = proto.prepareData;
    proto.prepareData = function () {
      orig.call(this);
      if (!radiationEnabled()) return;
      try { applyRadiationStatLoss(this); } catch (e) { console.warn(`${SCOPE} | radiation stat loss failed`, e); }
    };
    _wrapped = true;
  }

  // The death-check card's Roll button (mirrors the drug/stun/death save button wiring in save-rolls.js).
  onGlobalClick(async (ev) => {
    const btn = ev.target?.closest?.(".cp-rad-death-roll");
    if (!btn || btn.disabled) return;
    if (!radiationEnabled()) return;
    ev.preventDefault();
    let check = null;
    try { check = btn.dataset.check ? JSON.parse(btn.dataset.check) : null; } catch (_e) { /* legacy card */ }
    await executeRadiationDeathCheck({
      actorId: btn.dataset.actorId,
      tokenId: btn.dataset.tokenId ?? "", sceneId: btn.dataset.sceneId ?? "", check
    });
  });

  // Round tick — the ACTIVE GM counts the CURRENT combatant's timed radiation markers down when their
  // turn comes up (the drug/consumable per-turn pattern, incl. the multi-GM + begin-combat guards).
  // Gated by the feature toggle AND the round-tick toggle: off = durations run narratively, the GM
  // cure controls still work.
  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!radiationEnabled()) return;
    if (!mechRoundTickEnabled()) return;
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;
    if (updateData.turn === undefined && updateData.round === undefined) return;
    const prevRound = combat.previous?.round;
    if (prevRound !== undefined && prevRound < 1) return;   // Begin Combat is not a turn elapsing
    await runRadiationTickOnce(combat);
  });
}
