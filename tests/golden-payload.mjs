/**
 * GOLDEN PAYLOAD — the stored seam emission, and the hydrator that re-fills it.
 *
 * ⭐ WHAT PROBLEM THIS SOLVES. `module/seam-shim.js` assembles the `cyberpunk2020.weaponFired` payload
 * out of the fire method's context, the fire card's computed render data and the loaded ammo's
 * `ammoEffectFields`. The keeper battery used to hand-build that object as a four-field literal at ~68
 * call sites, so the presentation rail was driven against a shape it never receives
 * (VACUOUS-LEG-AUDIT F1). `cp2020-augmented-golden-payload-capture.mjs` records the REAL emission once
 * per fire mode into `golden-weaponfired-payloads.json`; this module loads it and hands suites a
 * hydrator, so a leg that needs an odd field has to SAY SO rather than silently omit forty others.
 *
 * ⛔ THE FIXTURE IS NOT SELF-MAINTAINING, and that is what the contract leg in
 * `cp2020-augmented-b1-seam-payload.mjs` is for: it re-captures a live emission at run time and diffs
 * its field NAMES and TYPES against this fixture's, in both directions. A producer that adds, drops or
 * re-types a field reds there and names the field. Without that leg this file is just a hand-built
 * shape on a slower clock.
 *
 * USAGE (Node side)
 *   import { GOLDEN_MODES, installGoldenHydrator } from "./golden-payload.mjs";
 *   await installGoldenHydrator(page);           // once, after the client is ready
 * USAGE (page side, inside any page.evaluate on that page)
 *   const payload = (over = {}) => __goldenPayload("fullAuto",
 *     { attackerId: actor.id, weaponId: madeIds.rifle, attackerTokenId: tokenDoc.id }, over);
 *
 * The `ids` argument re-fills the `@@…@@` markers the capture wrote in place of world-local
 * identifiers. Any marker left unmapped resolves to null — i.e. the payload says "the seam could not
 * establish it", which is a shape the producer really does emit, not an invented one.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const GOLDEN_PATH = join(HERE, "golden-weaponfired-payloads.json");

export const GOLDEN_MISSING = !existsSync(GOLDEN_PATH);
export const GOLDEN = GOLDEN_MISSING ? null : JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
export const GOLDEN_MODES = GOLDEN?.modes ?? {};

/** The fire modes the fx rail hydrates from — named here so a suite can assert the fixture carries
 *  them by name rather than discovering a missing entry as an `undefined` field halfway down a leg. */
export const REQUIRED_MODES = ["singleShot", "burst", "fullAuto", "shotgunSpread", "areaWarhead"];

/**
 * Put `__GOLDEN` and `__goldenPayload` on the page, once. Every later `page.evaluate` on that page can
 * call the hydrator without re-passing the fixture (the fixture is ~40 fields × 6 modes and would
 * otherwise be re-serialised into a dozen evaluate calls).
 * @returns {Promise<{modes:string[], fields:Record<string,number>}>} what actually landed on the page.
 */
export async function installGoldenHydrator(page) {
  if (GOLDEN_MISSING) throw new Error(`golden payload fixture missing at ${GOLDEN_PATH} — run cp2020-augmented-golden-payload-capture.mjs`);
  return page.evaluate((modes) => {
    globalThis.__GOLDEN = modes;
    globalThis.__goldenPayload = (mode, ids = {}, over = {}) => {
      const src = globalThis.__GOLDEN?.[mode];
      if (!src) throw new Error(`golden fixture has no '${mode}' entry`);
      const map = {
        "@@ATTACKER_ACTOR@@": ids.attackerId ?? null,
        "@@ATTACKER_TOKEN@@": ids.attackerTokenId ?? null,
        "@@WEAPON@@": ids.weaponId ?? null,
        "@@TARGET_TOKEN@@": ids.targetTokenId ?? null,
        "@@TARGET_ACTOR@@": ids.targetActorId ?? null,
        "@@FIRED_BY_USER@@": ids.firedByUserId ?? game.user?.id ?? null,
      };
      const fill = (v) => {
        if (typeof v === "string") return (v in map) ? map[v] : v;
        if (Array.isArray(v)) return v.map(fill);
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
        return v;
      };
      const out = fill(JSON.parse(JSON.stringify(src.values)));
      // The producer writes several fields as `undefined` rather than null and consumers can tell them
      // apart (`Number(null)` is a finite ZERO, `Number(undefined)` is NaN), so the capture recorded
      // which ones they were and they are restored as undefined here.
      for (const k of src.undefinedKeys ?? []) out[k] = undefined;
      return { ...out, ...over };
    };
    return {
      modes: Object.keys(modes),
      fields: Object.fromEntries(Object.entries(modes).map(([k, v]) => [k, v.keys.length])),
    };
  }, GOLDEN_MODES);
}
