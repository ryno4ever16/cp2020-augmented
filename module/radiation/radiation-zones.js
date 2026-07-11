/**
 * R? — Radiation ZONES: a per-turn area hazard that irradiates every token standing inside it.
 *
 * The book's reactor/rad-field model (Deep Space "for every turn of exposure, roll 1D10... rads"): a
 * circular zone on the canvas that, each combat round, rolls its rads formula PER token inside and feeds
 * the result to the confirmed dose subsystem (radiation.js#applyRadiationDose) — which already owns the
 * RSP suit subtraction, the Radiation Effects Table, and its own per-actor summary / death cards. This
 * file adds NONE of that; it is purely the "area + per-round tick" shell around it.
 *
 * This file MIRRORS the GAS-CLOUD region system in module/combat/damage-hooks.js almost 1:1 — the same
 * patterns, idioms, and comment density:
 *   - PLACEMENT — `placeRadZone` ≙ `_placeGasCloud`: build a circle via the core-agnostic area-shapes
 *     shim (MeasuredTemplate on v13, Region on v14), tag it with cyberpunk2020-scoped flags, and post a
 *     placement notice through postSavePromptCard.
 *   - ROUND TICK — `runRadZoneTick` ≙ `_runGasCloudTick`: find every flagged zone on the viewed scene,
 *     gather the tokens inside (the shim's testPoint/shape.contains), act on each, then age/remove the
 *     zone. One SHORT per-round card names the zone + who's inside, on TOP of applyRadiationDose's cards.
 *   - PER-TURN HOOK — `_hookRadZonePerTurn` ≙ `_hookGasCloudPerTurn`: the updateCombat handler with the
 *     EXACT gas-cloud + drug + radiation.js gating chain (feature toggle, round-tick master, GM, the
 *     single active GM, a real turn/round change, and the Begin-Combat guard).
 *   - `registerRadiationZones` ≙ the gas-cloud registration — installs the hook. (A later agent wires
 *     this into cp2020-augmented.js — that file is NOT edited here.)
 *
 * THE ONE DELIBERATE DIVERGENCE from the gas cloud: the gas cloud always has a finite duration and its
 * tick opens with `if (turnsLeft <= 0) deleteArea`. A rad zone treats `turnsLeft <= 0` as PERSISTENT — a
 * reactor breach / standing rad field does not disperse on its own — so a persistent zone is NEVER
 * decremented or auto-deleted; only a zone placed with a FINITE `turnsLeft > 0` counts down and self-
 * removes when it hits 0. (Resolved ambiguity — see the build report.)
 *
 * Flags live under scope "cp2020-augmented" (area-shapes namespaces the descriptor's `flags` for us):
 *   { isRadZone: true, radsFormula, sourceLabel, turnsLeft, createdRound }
 * `sourceLabel` is stored RAW (may be "") and its generic fallback is localized at DISPLAY time, so a
 * stored flag never freezes the UI language — the radiation.js `sourceName` discipline.
 *
 * ── Handlebars card templates referenced (NAME only) ──
 *   • save-prompt.hbs  — EXISTING generic notice card, reused via postSavePromptCard (title/body). NOT
 *                        created here; NO new hbs template is introduced by this file.
 *
 * ── i18n keys referenced (CYBERPUNK.* namespace — a later agent adds these to lang/en.json; NOT edited
 *    here) ──
 *   RadZoneTitle            (params { source })                  — placement card title
 *   RadZonePlacedBody       (params { radius, rads, source, durationClause }) — placement card body
 *   RadZoneDurationClause   (params { turns })                   — placement clause for a FINITE zone
 *   RadZonePersistentClause (no params)                          — placement clause for a PERSISTENT zone
 *   RadZoneTurnTitle        (params { source })                  — per-round card title
 *   RadZoneTurnBody         (params { names })                   — per-round card body (who's inside)
 *   RadZoneDispersedBody    (params { source })                  — a FINITE zone's expiry notice
 *   Reused EXISTING key (from radiation.js): RadiationSourceDefault — the generic source-label fallback.
 */

import { localize, localizeParam } from "../utils.js";
import { mechRoundTickEnabled } from "../settings.js";
import { postSavePromptCard } from "../compat.js";
import { createArea, areasByFlag, tokensInArea, deleteArea } from "../combat/area-shapes.js";
import { applyRadiationDose } from "./radiation.js";

const SCOPE = "cp2020-augmented";

/**
 * Whether the optional Deep Space radiation subsystem is enabled. Read DEFENSIVELY (try/catch → false),
 * exactly like radiation.js reads it: the `radiationEnabled` world setting is registered by R3, so until
 * then (and whenever it is off) the passive zone automation is inert. Default OFF — opt-in, not core play.
 */
function radiationEnabled() {
  try { return game.settings.get(SCOPE, "radiationEnabled") === true; } catch { return false; }
}

/**
 * Roll a rads dice string ("1d10", "2d6+1") → a non-negative integer (0 floor). Impure (dice). The
 * rollDamageAmount shape from radiation.js: a bad/empty formula falls back to the book's 1D10 rate and a
 * non-rollable string warns and yields 0 rather than throwing mid-tick.
 */
async function rollRads(formula) {
  const s = String(formula ?? "").trim() || "1d10";
  try {
    const roll = await new Roll(s).evaluate();
    return Math.max(0, Math.floor(Number(roll.total) || 0));
  } catch (e) {
    console.warn(`${SCOPE} | rad zone formula "${s}" is not rollable`, e);
    return 0;
  }
}

/**
 * Place a radiation zone on the viewed scene and post its placement notice. GM action (like
 * applyRadiationDose / _placeGasCloud it is NOT itself feature-gated — placing a zone is a deliberate
 * act; only the passive per-round tick is gated by radiationEnabled). Mirrors _placeGasCloud.
 *
 *   { x, y }        origin in PIXELS (canvas coords), as the area-shapes descriptor expects.
 *   radiusM         zone radius in METRES (default 3).
 *   radsFormula     per-turn rads roll, PER token inside (default "1d10" — the book reactor rate).
 *   sourceLabel     free-text hazard name (stored raw; its fallback is localized at display time).
 *   turnsLeft       FINITE turns before it self-removes; 0 / absent = PERSISTENT (never counts down).
 *
 * @returns {Promise<object|null>} the created area handle, or null on failure.
 */
export async function placeRadZone({ x, y, radiusM = 3, radsFormula = "1d10", sourceLabel = "", turnsLeft = 0 } = {}) {
  const scene = canvas?.scene;
  if (!scene) return null;

  const radius  = Number(radiusM) || 3;
  const formula = String(radsFormula ?? "").trim() || "1d10";
  const turns   = Number(turnsLeft) || 0;   // 0 / absent = PERSISTENT (a reactor breach does not expire)
  const source  = String(sourceLabel ?? "").trim() || localize("RadiationSourceDefault");

  const handle = await createArea(scene, {
    kind: "circle", x, y, radiusM: radius,
    // A sickly yellow-green, deliberately distinct from the gas cloud's green, so the two area hazards
    // read apart at a glance on the canvas.
    color: "#ccff33", borderColor: "#88aa22",
    flags: {
      isRadZone: true, radsFormula: formula, sourceLabel: String(sourceLabel ?? ""),
      turnsLeft: turns, createdRound: game.combat?.round ?? 0,
    },
  });
  if (!handle?.doc) { console.warn("CP2020 | Rad zone creation failed"); return null; }

  // Placement notice (the _placeGasCloud postSavePromptCard pattern): radius, the per-turn rads rate, the
  // source name, and whether it persists or counts down — the latter as a JS-assembled clause so the two
  // cases share one body key.
  const durationClause = turns > 0
    ? localizeParam("RadZoneDurationClause", { turns })
    : localize("RadZonePersistentClause");
  await postSavePromptCard({
    title: localizeParam("RadZoneTitle", { source }),
    body: localizeParam("RadZonePlacedBody", { radius, rads: formula, source, durationClause }),
  });

  return handle;
}

/**
 * One per-round pass over every radiation zone on the viewed scene: dose each token standing inside, then
 * age/remove any FINITE zone. Gated by the feature toggle at the top (so a future manual-tick caller also
 * respects it, exactly as _runGasCloudTick re-checks gasEnabled). Mirrors _runGasCloudTick.
 */
export async function runRadZoneTick(combat) {
  if (!radiationEnabled()) return;

  const scene = canvas?.scene;
  if (!scene) return;

  const zones = areasByFlag(scene, "isRadZone");

  for (const zone of zones) {
    const flags       = zone.doc.flags[SCOPE];
    const radsFormula = String(flags.radsFormula ?? "1d10");
    const sourceLabel = String(flags.sourceLabel ?? "");   // RAW label passed straight to applyRadiationDose
    const turnsLeft   = Number(flags.turnsLeft ?? 0);
    const source      = sourceLabel.trim() || localize("RadiationSourceDefault");   // localized only for display

    // Tokens inside the zone (shim: RegionDocument#testPoint on v14, shape.contains on v13).
    const tokensInZone = tokensInArea(zone, scene.tokens?.contents ?? []);

    const dosed = [];
    for (const tokDoc of tokensInZone) {
      // Live actor: prefer the world document over the token's synthetic copy — the gas-cloud idiom, so
      // the dose lands on (and re-prepares) the real actor.
      const liveActor = tokDoc.actor ? (game.actors.get(tokDoc.actor.id) ?? tokDoc.actor) : null;
      if (!liveActor) continue;
      const rads = await rollRads(radsFormula);
      // applyRadiationDose owns the RSP subtraction, the effects table, and its own per-actor summary /
      // death cards — we only feed it the rolled rads. perTurn:true so the equipped rad-suit's RSP applies.
      // announce:false → routine accrual is silent; the dose card fires only on a band-crossing (or HP
      // damage / death), so a persistent field doesn't spam a card per token per round while doses climb.
      const res = await applyRadiationDose(liveActor, rads, { perTurn: true, sourceLabel, announce: false });
      // Surface a token on the zone card ONLY when something happened this round (a new dose band, HP
      // damage, or a death check) — mirroring the dose card's own silence on routine accrual.
      if (res && (res.bandFired != null || res.damageDealt > 0 || res.deathPosted)) dosed.push(tokDoc);
    }

    // ONE short per-round zone card naming the field + who suffered an effect this round, IN ADDITION to
    // applyRadiationDose's own per-actor cards (mirrors _runGasCloudTick's per-turn card). Posted only when
    // someone crossed a band / took damage — a field that is merely accruing dose is silent.
    if (dosed.length) {
      const names = dosed.map((t) => `<b>${t.name}</b>`).join(", ");
      await postSavePromptCard({
        title: localizeParam("RadZoneTurnTitle", { source }),
        body: localizeParam("RadZoneTurnBody", { names }),
      });
    }

    // Countdown / removal. Unlike the gas cloud (which always expires), a rad zone ages ONLY when it was
    // placed FINITE (turnsLeft > 0): decrement, and delete + post the dispersal notice when it reaches 0.
    // A PERSISTENT zone (turnsLeft ≤ 0 from placement) is never decremented or auto-deleted here — a
    // standing rad field only goes away when the GM removes it.
    if (turnsLeft > 0) {
      await zone.doc.update({ [`flags.${SCOPE}.turnsLeft`]: turnsLeft - 1 }).catch(() => {});
      if (turnsLeft - 1 <= 0) {
        await deleteArea(zone);
        await postSavePromptCard({ body: localizeParam("RadZoneDispersedBody", { source }) });
      }
    }
  }
}

/**
 * Per-turn hook: run the zone tick when a combat turn/round elapses. Gated EXACTLY like the gas-cloud and
 * drug/radiation per-turn hooks — the feature toggle, the round-tick automation master, GM-only, the
 * SINGLE active GM (else duplicate doses/updates across GM clients), a real turn/round change, and the
 * Begin-Combat guard (tokens already standing in a zone must not be dosed — and the zone must not lose a
 * turn — the moment the GM clicks Begin Combat). Mirrors _hookGasCloudPerTurn.
 */
function _hookRadZonePerTurn() {
  Hooks.on("updateCombat", async (combat, updateData) => {
    if (!radiationEnabled()) return;
    if (!mechRoundTickEnabled()) return;
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;
    // Per-ROUND, not per-combatant-turn: a zone doses everyone inside ONCE per combat round (Deep Space
    // "for every turn of exposure" — a CP2020 turn = one 3-second round), and a finite zone counts down
    // once per round. Firing on every turn advance would dose each token N× per round (N = combatant
    // count) and expire a finite zone N× too fast. Fire only on a real round advance.
    if (updateData.round === undefined) return;
    const prevRound = combat.previous?.round;
    if (prevRound !== undefined && prevRound < 1) return;   // Begin Combat is not a round elapsing
    await runRadZoneTick(combat);
  });
}

/** Install the radiation-zone hooks. Called once at init (wired by a later agent — cp2020-augmented.js is
 *  NOT edited here). Mirrors the gas-cloud registration. */
export function registerRadiationZones() {
  _hookRadZonePerTurn();
}
