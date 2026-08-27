/**
 * Radiation-zone Region Behavior (module side).
 *
 * Replaces the old "place a zone through a dialog + track it by a private flag" model with a native
 * Foundry Scene Region carrying a custom "Radiation Zone" behavior. The GM draws / reshapes / moves /
 * deletes / hides the zone with Foundry's own region tools; this module only supplies the behavior
 * TYPE (its two data fields) and the per-round dosing that reads them (radiation-zones.js).
 *
 * Regions and custom Region Behaviors both exist from Foundry v12 onward, so this runs on every core the
 * module supports (v13 + v14) and needs none of the area-shapes MeasuredTemplate/Region shim — that shim
 * stays only for the transient combat areas (gas cloud, suppressive fire).
 *
 * ⚠ Registration is TWO-PART (rig-verified): the subtype must ALSO be declared in module.json under
 * documentTypes.RegionBehavior.radiationZone — Foundry freezes the valid-type list from the manifests at
 * init, so a runtime CONFIG assignment alone is rejected. This file supplies the DataModel half; the
 * manifest supplies the type declaration; both are required.
 *
 * Fields (behavior.system): radsFormula (per-round rads roll, per token inside) + sourceLabel (free text,
 * blank ok — its generic fallback is localized at DISPLAY time so a stored value never freezes the UI
 * language). The auto-generated behavior sheet renders both from their i18n label/hint keys.
 *
 * ⏩ AND ONE THING THAT HAPPENS AT THE MOMENT OF AN EVENT (2026-08-13): entering a zone posts a
 * GM-whispered cue. The dosing is still the per-round sweep in radiation-zones.js — nothing about the
 * mechanics moved here — but a hazard that says nothing until a combat round elapses reads as a dead
 * feature, and out of combat it never elapses at all. See the `static events` block for the event
 * choice and what it does and does not cover.
 */

import { localize, localizeParam } from "../utils.js";
import { postSavePromptCard, getGMUserIds } from "../compat.js";
import { isPrimaryGMSession } from "../gm-session-primary.js";

const SCOPE = "cp2020-augmented";

/**
 * ⭐ THE ENTRY CUE (2026-08-13, user ruling from live testing: *"There should be some kind of
 * feedback"*).
 *
 * Until now a token walking into a radiation field was COMPLETELY SILENT until a combat round
 * elapsed — and out of combat, silent forever, because the dosing rides the round-advance sweep. At
 * the table that reads as the feature being dead, which is exactly what was reported. So entering a
 * zone now says so, once, at the moment it happens.
 *
 * ⛔ GM-WHISPERED, and that is the ruled visibility, not caution. A rad-zone region defaults to
 * GAMEMASTER visibility (see registerRadiationZoneVisibilityDefault) precisely so players are not told
 * they are standing in something until the GM reveals it. A public cue would hand them the answer the
 * region deliberately withholds.
 *
 * ⚠ ONE WHISPER, NOT ONE PER GM CLIENT. A region event is dispatched on EVERY client, so without the
 * active-GM gate a two-GM table gets two of everything — the standing idiom in this module (the
 * per-round tick gates the same way, and for the same reason).
 *
 * The source label is localized AT DISPLAY TIME from a possibly-blank stored value, the discipline the
 * rest of the radiation code follows so a stored string never freezes the UI language.
 */
async function _postRadZoneEntryCue(behaviorSystem, tokenDoc) {
  if (!tokenDoc?.name) return;
  if (!isPrimaryGMSession()) return;
  const sys = behaviorSystem ?? {};
  const source = String(sys.sourceLabel ?? "").trim() || localize("RadiationSourceDefault");
  const formula = String(sys.radsFormula ?? "").trim() || "1d10";
  await postSavePromptCard({
    title: localizeParam("RadZoneEntryTitle", { source }),
    body: localizeParam("RadZoneEntryBody", { name: tokenDoc.name, source, formula }),
    whisper: getGMUserIds(),
  });
}

/** The behavior document type string (module-namespaced, matches module.json). */
export const RAD_ZONE_BEHAVIOR = `${SCOPE}.radiationZone`;

/** The registered DataModel class, or null before registration / on a pre-region core. */
let _radiationZoneBehaviorClass = null;
export function radiationZoneBehaviorClass() { return _radiationZoneBehaviorClass; }

/** The RegionBehaviorType base, or null on a core without Regions (pre-v12). */
function behaviorBase() {
  return foundry?.data?.regionBehaviors?.RegionBehaviorType ?? null;
}

/**
 * Register the Radiation Zone behavior TYPE at init (before scenes load). No-op + returns false on a
 * pre-region core or if the CONFIG map is absent, so the module degrades cleanly. Returns true when the
 * type was installed.
 */
export function registerRadiationZoneBehavior() {
  const Base = behaviorBase();
  if (!Base || !CONFIG?.RegionBehavior?.dataModels) return false;

  const fields = foundry.data.fields;

  class RadiationZoneBehavior extends Base {
    /**
     * ⭐ THE EVENT, AND WHY THIS ONE. Core's `RegionBehavior#_handleRegionEvent` looks the event name up
     * in `this.constructor.events` and calls the handler with the behavior's SYSTEM as `this` — the
     * dispatch is byte-identical on v13.350 and v14.364 (both were read from the running cores' own
     * `foundry.mjs` before this was written), and `CONST.REGION_EVENTS` carries the same names on both.
     * So the declared-events route needs no version fork and no external hook.
     *
     * ⚠ TOKEN_ENTER, NOT TOKEN_MOVE_IN — a deliberate widening, recorded rather than quietly taken.
     * `TOKEN_MOVE_IN` fires only when a token's own geometry changes such that it is now inside; core's
     * own documentation for `TOKEN_ENTER` lists four ways a token comes to be inside a region:
     *   · it MOVES in — a drag, a teleport, any x/y/elevation/size change (MOVE_IN's whole scope),
     *   · it is CREATED inside — dropping a figure straight into the reactor room, which is precisely
     *     how this module's own deploy paths put tokens on a map, and which MOVE_IN misses entirely,
     *   · the REGION's boundary changes so the token is now inside — the GM drawing the field over
     *     people who were already standing there,
     *   · the BEHAVIOR becomes active (created or enabled) — the GM adding the hazard to an existing
     *     region, which fires once per token already inside.
     * The last two are one-time bursts when a GM builds a zone on top of occupied ground; they are
     * honest ("you just put a rad field on these three") rather than noise, and the alternative is a cue
     * that stays silent in the two cases a GM is most likely to hit while setting an encounter up.
     */
    static events = {
      [CONST.REGION_EVENTS.TOKEN_ENTER]: async function (event) {
        try {
          await _postRadZoneEntryCue(this, event?.data?.token);
        } catch (e) {
          console.warn(`${SCOPE} | rad-zone entry cue failed`, e);
        }
      },
    };

    static defineSchema() {
      return {
        radsFormula: new fields.StringField({
          required: true, blank: false, initial: "1d10",
          label: "CYBERPUNK.RadZoneBehaviorFormula",
          hint: "CYBERPUNK.RadZoneBehaviorFormulaHint",
        }),
        sourceLabel: new fields.StringField({
          required: false, blank: true, initial: "",
          label: "CYBERPUNK.RadZoneBehaviorSource",
          hint: "CYBERPUNK.RadZoneBehaviorSourceHint",
        }),
      };
    }
  }

  _radiationZoneBehaviorClass = RadiationZoneBehavior;
  CONFIG.RegionBehavior.dataModels[RAD_ZONE_BEHAVIOR] = RadiationZoneBehavior;
  // The "Add Behavior" list reads typeIcons; the label auto-derives TYPES.RegionBehavior.<type> from
  // lang/en.json, so only the icon is set here.
  if (CONFIG.RegionBehavior.typeIcons) {
    CONFIG.RegionBehavior.typeIcons[RAD_ZONE_BEHAVIOR] = "fa-solid fa-radiation";
  }
  return true;
}

/**
 * Give a freshly-created radiation-zone region a sensible default visibility. The native default
 * ("layer" on v13 / "layer-unlocked" on v14) shows the region ONLY while the region tool is active — so
 * the GM can't see their own hazard during play. When our behavior is created on a region still at a
 * layer-only default, bump it to GAMEMASTER: the GM sees the zone during normal play, players do not, and
 * the GM stays free to set it to ALWAYS to reveal it to players (or back to a layer-only mode). Runs on
 * the single active GM to avoid duplicate writes across GM clients.
 */
export function registerRadiationZoneVisibilityDefault() {
  Hooks.on("createRegionBehavior", async (behavior) => {
    try {
      if (behavior?.type !== RAD_ZONE_BEHAVIOR) return;
      if (!isPrimaryGMSession()) return;
      const region = behavior.parent;
      if (!region?.update) return;
      const V = CONST?.REGION_VISIBILITY ?? {};
      // Anything the GM has already set to a genuinely-visible mode is left alone; only the layer-only
      // defaults get nudged.
      const alreadyVisible = new Set([V.GAMEMASTER, V.ALWAYS, V.OBSERVER].filter((v) => v != null));
      if (alreadyVisible.has(region.visibility)) return;
      await region.update({ visibility: V.GAMEMASTER ?? 1 });
    } catch (e) {
      console.warn(`${SCOPE} | rad-zone visibility default failed`, e);
    }
  });
}
