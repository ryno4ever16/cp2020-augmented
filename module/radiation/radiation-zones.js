/**
 * R? — Radiation ZONES: a per-round area hazard that irradiates every token standing inside it.
 *
 * The book's reactor/rad-field model (Deep Space "for every turn of exposure, roll 1D10... rads"): an
 * area on the canvas that, each combat round, rolls its rads formula PER token inside and feeds the result
 * to the confirmed dose subsystem (radiation.js#applyRadiationDose) — which already owns the RSP suit
 * subtraction, the Radiation Effects Table, and its own per-actor summary / death cards. This file adds
 * NONE of that; it is purely the "area + per-round tick" shell around it.
 *
 * ZONES ARE NATIVE FOUNDRY REGIONS carrying a custom "Radiation Zone" behavior (radiation-zone-behavior.js).
 * The GM draws / reshapes / moves / deletes / hides a zone with Foundry's own region tools — there is no
 * module placement dialog. The behavior holds the two data fields (radsFormula + sourceLabel); this file
 * reads them each round and doses the tokens the region reports inside itself (its native `tokens` Set).
 * Regions + custom behaviors exist v12+, so this needs none of the area-shapes MeasuredTemplate/Region
 * shim (that shim stays for the TRANSIENT combat areas — gas cloud, suppressive fire).
 *
 *   - ROUND TICK — `runRadZoneTick`: dose every native region zone, then every LEGACY flag zone (below).
 *   - PER-TURN HOOK — `_hookRadZonePerTurn`: the updateCombat handler with the gas-cloud + drug gating
 *     chain (feature toggle, round-tick master, GM, the single active GM, a real round change, the
 *     Begin-Combat guard).
 *   - `registerRadiationZones` — installs the tick hook + the one-time legacy migration (ready). The
 *     behavior TYPE is registered separately at init by registerRadiationZoneBehavior.
 *
 * BACK-COMPAT: pre-behavior zones tagged `flags.cp2020-augmented.isRadZone` (v13 MeasuredTemplates, or a
 * v14 region not yet migrated) still tick through the legacy path and keep their old FINITE-countdown
 * behavior (a persistent legacy zone, turnsLeft ≤ 0, never auto-disperses). `migrateLegacyRadZones` (ready,
 * active GM) upgrades legacy v14 regions to the native behavior and drops the flag so they are not
 * double-dosed. `sourceLabel` is stored RAW (may be "") and its generic fallback is localized at DISPLAY
 * time, so a stored value never freezes the UI language — the radiation.js `sourceName` discipline.
 *
 * ── Handlebars card templates referenced (NAME only) ──
 *   • save-prompt.hbs  — EXISTING generic notice card, reused via postSavePromptCard (title/body). No new
 *                        hbs template is introduced by this file.
 *
 * ── i18n keys referenced (CYBERPUNK.* namespace) ──
 *   RadZoneTurnTitle     (params { source })   — per-round card title
 *   RadZoneTurnBody      (params { names })     — per-round card body (who suffered an effect)
 *   RadZoneDispersedBody (params { source })    — a legacy FINITE zone's expiry notice
 *   RadZoneBehaviorLabel (no params)            — the migrated behavior's document name
 *   Reused EXISTING key (from radiation.js): RadiationSourceDefault — the generic source-label fallback.
 */

import { localize, localizeParam } from "../utils.js";
import { mechRoundTickEnabled } from "../settings.js";
import { postSavePromptCard } from "../compat.js";
import { areasByFlag, tokensInArea, deleteArea } from "../combat/area-shapes.js";
import { applyRadiationDose } from "./radiation.js";
import { RAD_ZONE_BEHAVIOR, radiationZoneBehaviorClass } from "./radiation-zone-behavior.js";

const SCOPE = "cp2020-augmented";

/** World completion stamp for the one-time legacy-zone upgrade below. Hidden store, not a user
 *  setting (config:false → no i18n keys), mirroring `civilianSheetMigrated`. */
const RAD_ZONES_MIGRATED = "radZonesMigrated";

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
 * Dose every token in ONE zone this round and post the single per-round zone card. Shared by the native
 * region-behavior path and the legacy flag path. `tokenDocs` is the array of TokenDocuments inside the
 * zone this round.
 *   - applyRadiationDose owns the RSP subtraction, the effects table, and its own per-actor summary /
 *     death cards — we only feed it the rolled rads. perTurn:true so the equipped rad-suit's RSP applies.
 *   - announce:false → routine accrual is silent; a token appears on the zone card ONLY when something
 *     happened this round (a new dose band, HP damage, or a death check), so a field merely accruing dose
 *     doesn't spam a card per token per round.
 */
async function _doseZoneTokens({ radsFormula, sourceLabel, tokenDocs }) {
  const source = String(sourceLabel ?? "").trim() || localize("RadiationSourceDefault");   // display only
  const dosed = [];
  for (const tokDoc of tokenDocs) {
    // Live actor: prefer the world document over the token's synthetic copy — the gas-cloud idiom, so the
    // dose lands on (and re-prepares) the real actor.
    const liveActor = tokDoc.actor ? (game.actors.get(tokDoc.actor.id) ?? tokDoc.actor) : null;
    if (!liveActor) continue;
    const rads = await rollRads(radsFormula);
    const res = await applyRadiationDose(liveActor, rads, { perTurn: true, sourceLabel, announce: false });
    if (res && (res.bandFired != null || res.damageDealt > 0 || res.deathPosted)) dosed.push(tokDoc);
  }
  // ONE short per-round zone card naming the field + who suffered an effect this round, IN ADDITION to
  // applyRadiationDose's own per-actor cards. Posted only when someone crossed a band / took damage.
  if (dosed.length) {
    const names = dosed.map((t) => `<b>${t.name}</b>`).join(", ");
    await postSavePromptCard({
      title: localizeParam("RadZoneTurnTitle", { source }),
      body: localizeParam("RadZoneTurnBody", { names }),
    });
  }
}

/**
 * Native radiation zones on the viewed scene: every Region carrying an ENABLED Radiation Zone behavior,
 * normalized to { radsFormula, sourceLabel, tokenDocs }. Tokens come from the region's native live
 * `tokens` Set (Foundry maintains who is inside). Empty on any scene with no such region.
 */
function regionRadZones(scene) {
  const out = [];
  for (const region of scene?.regions ?? []) {
    const behavior = region.behaviors?.find((b) => !b.disabled && b.type === RAD_ZONE_BEHAVIOR);
    if (!behavior) continue;
    const sys = behavior.system ?? {};
    out.push({
      radsFormula: String(sys.radsFormula ?? "1d10"),
      sourceLabel: String(sys.sourceLabel ?? ""),
      tokenDocs: [...(region.tokens ?? [])],
    });
  }
  return out;
}

/**
 * One per-round pass over every radiation zone on the viewed scene, from TWO sources:
 *   1) NATIVE region zones — Regions carrying the Radiation Zone behavior (the model since this rework;
 *      the GM draws / hides / removes them with Foundry's own region tools).
 *   2) LEGACY flag zones — pre-behavior zones still tagged `flags.cp2020-augmented.isRadZone` (v13
 *      MeasuredTemplates, or a v14 region not yet migrated). These keep their old finite-countdown
 *      behavior. A region that ALSO carries the behavior is skipped here so it is never dosed twice.
 * No feature-toggle gate — both sources are empty until a GM actually places a zone, so this is a no-op
 * until radiation is in play.
 */
export async function runRadZoneTick(combat) {
  const scene = canvas?.scene;
  if (!scene) return;

  // 1) Native region zones.
  for (const zone of regionRadZones(scene)) {
    await _doseZoneTokens(zone);
  }

  // 2) Legacy flag zones (back-compat).
  for (const zone of areasByFlag(scene, "isRadZone")) {
    if (zone.doc?.behaviors?.some?.((b) => b.type === RAD_ZONE_BEHAVIOR)) continue;   // owned by path 1
    const flags       = zone.doc.flags[SCOPE];
    const radsFormula = String(flags.radsFormula ?? "1d10");
    const sourceLabel = String(flags.sourceLabel ?? "");
    const turnsLeft   = Number(flags.turnsLeft ?? 0);
    const source      = sourceLabel.trim() || localize("RadiationSourceDefault");

    await _doseZoneTokens({
      radsFormula, sourceLabel,
      tokenDocs: tokensInArea(zone, scene.tokens?.contents ?? []),
    });

    // Legacy finite countdown (native zones are removed by the GM with region tools instead). A PERSISTENT
    // legacy zone (turnsLeft ≤ 0) is never auto-removed here.
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
 * One-time upgrade of legacy flag-tagged radiation REGIONS to the native behavior. On a v14 world where
 * zones were placed as flagged regions before the behavior existed, add the Radiation Zone behavior from
 * the stored flag data, then drop the legacy `isRadZone` flag so the tick's legacy path no longer also
 * sees them (no double dose). v13 legacy zones are MeasuredTemplates (not regions) and are untouched — they
 * keep working through the tick's legacy path. Runs once at ready, on the single active GM. Idempotent: a
 * region that already carries the behavior is skipped.
 *
 * ⭐ COMPLETION FLAG (`radZonesMigrated`), AND WHAT IT COSTS.
 * Without a flag this walked every scene's region collection on EVERY GM boot forever — reading
 * `scene.regions` forces each scene's embedded collection resident, on every scene in the world, to find
 * a tag that only pre-behavior worlds ever carried. The flag makes it what it says it is: a one-time
 * upgrade. What the un-flagged version also did, and this no longer does by itself: upgrade a legacy
 * flag-tagged region that arrives LATER (a scene imported from an older world, an adventure restored
 * from a backup). That zone is NOT broken by the flag — `runRadZoneTick`'s legacy path still doses it
 * exactly as before, it just stays on that path instead of gaining the native behavior. A GM who wants
 * such an import upgraded re-runs the pass from a script macro:
 * `game.modules.get("cp2020-augmented").api.migrations.legacyRadZones()`.
 *
 * `force` runs the sweep with the completion flag already set — that same manual re-run path.
 */
export async function migrateLegacyRadZones({ force = false } = {}) {
  if (!game.user?.isGM || game.users?.activeGM?.id !== game.user?.id) return;
  if (!radiationZoneBehaviorClass()) return;   // pre-region core → nothing to migrate onto
  if (!force && game.settings.get(SCOPE, RAD_ZONES_MIGRATED)) return;

  // Flag first, sweep second — same reasoning as the flesh-limb migration in cp2020-augmented.js: a
  // sweep whose completion stamp lands only on success repeats its whole cost on every boot once
  // anything in it throws. The trade is the same too: a run that stops part-way is not retried on its
  // own, so the failure is a console.error naming the re-run path rather than a quiet warn. (Per-region
  // failures are already contained by the inner catch and do not stop the sweep.)
  await game.settings.set(SCOPE, RAD_ZONES_MIGRATED, true);
  try {
    for (const scene of game.scenes ?? []) {
      for (const region of scene.regions ?? []) {
        const flags = region.flags?.[SCOPE];
        if (!flags?.isRadZone) continue;
        if (region.behaviors?.some((b) => b.type === RAD_ZONE_BEHAVIOR)) continue;
        try {
          await region.createEmbeddedDocuments("RegionBehavior", [{
            name: localize("RadZoneBehaviorLabel"),
            type: RAD_ZONE_BEHAVIOR,
            system: {
              radsFormula: String(flags.radsFormula ?? "1d10"),
              sourceLabel: String(flags.sourceLabel ?? ""),
            },
          }]);
          // Drop the tag AND its now-inert data flags (the behavior owns the values from here on); a
          // `-=` delete of a key that was never set is a harmless no-op.
          await region.update({
            [`flags.${SCOPE}.-=isRadZone`]: null,
            [`flags.${SCOPE}.-=radsFormula`]: null,
            [`flags.${SCOPE}.-=sourceLabel`]: null,
            [`flags.${SCOPE}.-=turnsLeft`]: null,
            [`flags.${SCOPE}.-=createdRound`]: null,
          });
        } catch (e) {
          console.warn(`${SCOPE} | rad-zone migration failed for a region`, e);
        }
      }
    }
  } catch (e) {
    console.error(
      `${SCOPE} | the legacy rad-zone migration stopped part-way. Regions it had not reached yet keep `
      + `their legacy tag and keep dosing through the tick's legacy path. It is marked done and will NOT `
      + `run itself again. A GM can re-run it from a script macro: `
      + `game.modules.get("${SCOPE}").api.migrations.legacyRadZones()`, e);
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

/** Install the radiation-zone hooks: the per-round dosing tick, plus a one-time ready migration that
 *  upgrades legacy flag-tagged regions to the native behavior. Called once at init from cp2020-augmented.js.
 *  (The behavior TYPE itself is registered separately, at init, by registerRadiationZoneBehavior.) */
export function registerRadiationZones() {
  game.settings.register(SCOPE, RAD_ZONES_MIGRATED, {
    scope: "world", config: false, type: Boolean, default: false,
  });
  _hookRadZonePerTurn();
  Hooks.once("ready", () => {
    migrateLegacyRadZones().catch((e) => console.warn(`${SCOPE} | rad-zone migration error`, e));
  });
}
