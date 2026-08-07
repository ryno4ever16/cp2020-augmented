/**
 * Cover Zone Region Behavior (module side).
 *
 * Fourth zone type on the native-region rail (radiation, gas, suppressive — this file mirrors
 * those siblings). A cover zone is a piece of the battlefield that stops bullets: a wall, a car
 * body, a concrete pole. Unlike its three siblings it is NOT event-driven and NOT round-ticked —
 * nothing happens when a token enters; the zone is QUERIED at damage-resolution time (the Apply
 * Damage dialog's cover picker reads the zones on the target's scene, and the applicator debits
 * the zone's structure pool after a shot resolves through it). So: no `events`, no per-turn hook,
 * just data + the chew lifecycle in cover.js.
 *
 * Rules basis: Core p.99/p.114 "Common Cover SPs" (the preset table in cover.js) + Maximum Metal
 * p.58 "SDP for Cover Objects": an object with an SP but no SDP has SDP = 3 × SP (a 5 SP wood
 * door sustains 15 SDP before shattering; the GM may scale the multiplier by massiveness). The
 * book's examples count damage RECEIVED against that pool while SP stays constant — so `sp`
 * never degrades here; `pool` drains, and at 0 the zone is destroyed and stops contributing.
 * Example 2 (p.58) shatters "the block which was the focus of the attack", not the whole wall —
 * a zone models the LOCAL cover element, so GMs should size zones per object, not per city block.
 *
 * ⚠ Registration is TWO-PART (rig-proven on the radiation unit): the subtype must ALSO be declared
 * in module.json under documentTypes.RegionBehavior.coverZone — Foundry freezes the valid-type
 * list from the manifests at init, so a runtime CONFIG assignment alone is rejected. And a
 * module.json change means the Foundry SERVER must restart before the type is valid — a page
 * reload is not enough.
 */

const SCOPE = "cp2020-augmented";

/** The behavior document type string (module-namespaced, matches module.json). */
export const COVER_ZONE_BEHAVIOR = `${SCOPE}.coverZone`;

/** The registered DataModel class, or null before registration / on a pre-region core. */
let _coverZoneBehaviorClass = null;
export function coverZoneBehaviorClass() { return _coverZoneBehaviorClass; }

/** The RegionBehaviorType base, or null on a core without Regions (pre-v12). */
function behaviorBase() {
  return foundry?.data?.regionBehaviors?.RegionBehaviorType ?? null;
}

/**
 * Register the Cover Zone behavior TYPE at init (before scenes load). No-op + returns false on a
 * pre-region core or if the CONFIG map is absent, so the module degrades cleanly. Returns true
 * when the type was installed.
 */
export function registerCoverZoneBehavior() {
  const Base = behaviorBase();
  if (!Base || !CONFIG?.RegionBehavior?.dataModels) return false;

  const fields = foundry.data.fields;

  class CoverZoneBehavior extends Base {
    static defineSchema() {
      return {
        sp: new fields.NumberField({
          required: true, integer: true, min: 0, initial: 10,
          label: "CYBERPUNK.CoverZoneSP",
          hint: "CYBERPUNK.CoverZoneSPHint",
        }),
        pool: new fields.NumberField({
          required: true, integer: true, min: 0, initial: 30,
          label: "CYBERPUNK.CoverZonePool",
          hint: "CYBERPUNK.CoverZonePoolHint",
        }),
        poolMax: new fields.NumberField({
          required: true, integer: true, min: 0, initial: 30,
          label: "CYBERPUNK.CoverZonePoolMax",
          hint: "CYBERPUNK.CoverZonePoolMaxHint",
        }),
        material: new fields.StringField({
          required: false, blank: true, initial: "",
          label: "CYBERPUNK.CoverZoneMaterial",
          hint: "CYBERPUNK.CoverZoneMaterialHint",
        }),
        destroyed: new fields.BooleanField({
          initial: false,
          label: "CYBERPUNK.CoverZoneDestroyed",
          hint: "CYBERPUNK.CoverZoneDestroyedHint",
        }),
      };
    }
    // Deliberately no `events`: cover is queried by the damage pipeline, never event-triggered.
  }

  _coverZoneBehaviorClass = CoverZoneBehavior;
  CONFIG.RegionBehavior.dataModels[COVER_ZONE_BEHAVIOR] = CoverZoneBehavior;
  // The "Add Behavior" list reads typeIcons; the label auto-derives TYPES.RegionBehavior.<type>
  // from lang/en.json, so only the icon is set here.
  if (CONFIG.RegionBehavior.typeIcons) {
    CONFIG.RegionBehavior.typeIcons[COVER_ZONE_BEHAVIOR] = "fa-solid fa-shield-halved";
  }
  return true;
}

/**
 * Give a hand-authored cover region a sensible default visibility. Cover is a visible battlefield
 * fact (the map art depicts the barrier; players aim around it), so like the suppressive lane —
 * and per the user's "they should see their own AOEs" ruling — bump a layer-only default to
 * ALWAYS. A visibility the GM already chose deliberately is left alone. Runs on the single active
 * GM to avoid duplicate writes across GM clients.
 */
export function registerCoverZoneVisibilityDefault() {
  Hooks.on("createRegionBehavior", async (behavior) => {
    try {
      if (behavior?.type !== COVER_ZONE_BEHAVIOR) return;
      if (!game.user?.isGM || game.users?.activeGM?.id !== game.user?.id) return;
      const region = behavior.parent;
      if (!region?.update) return;
      const V = CONST?.REGION_VISIBILITY ?? {};
      const alreadyVisible = new Set([V.GAMEMASTER, V.ALWAYS, V.OBSERVER].filter((v) => v != null));
      if (alreadyVisible.has(region.visibility)) return;
      await region.update({ visibility: V.ALWAYS ?? 2 });
    } catch (e) {
      console.warn(`${SCOPE} | cover-zone visibility default failed`, e);
    }
  });
}
