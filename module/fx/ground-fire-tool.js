/**
 * THE GROUND-FIRE CLEAR CONTROL — the referee's way to put out flames that are not going to go out on
 * their own, and the second half of the `groundFirePersistent` world setting (approved 2026-08-19:
 * persistent ground fire as a referee's environmental-hazard tool, default OFF).
 *
 * ⭐ THE SMALLEST SURFACE THAT DOES THE JOB, and it is deliberately the same idiom the module's two
 * other referee controls already use (`radiation/radiation-tools.js`, `fx/trauma-team-tool.js`):
 * augment an EXISTING scene-control group's `tools` with one momentary button. No window, no canvas
 * layer, no dialog. The macro path is the same verb behind the same referee gate, exposed as
 * `game.cpAugmented.fx.clearGroundFires()`.
 *
 * ⛔ IT DRAWS NOTHING AND WRITES NOTHING. The whole action is `fxClearGroundFires`, which ends the
 * effects the census already knows about, through the engine's own manager — the same relay the scene
 * cap's oldest-out eviction has always used, so every client's copy goes out together.
 *
 * ⚠ SHOWN TO ANY REFEREE, WHATEVER THE SETTING SAYS, and that is a decision rather than an oversight.
 * Gating its visibility on `groundFirePersistent` would hide the control in exactly the situation that
 * needs it most: switch the setting on, light a hazard, switch it off again, and the flames that are
 * already burning would have nothing left to put them out. It is also useful with the setting off —
 * "clear the ground now" rather than waiting out the 25 s burn — so the button is honest in both modes.
 *
 * ⭐ Review·Shooter parity is satisfied by construction, on the trauma-team control's own reasoning:
 * this element is not payload-driven, so a firing range cannot reach it; its trigger IS a one-click
 * control present on every scene for every referee, which is a lower bar to exercise than any bench
 * gun. The thing it acts ON is reachable from the bench — rows 07 and 12 are the burning-ground rows.
 */

import { fxClearGroundFires } from "./effects.js";
import { localize, localizeParam } from "../utils.js";

const SCOPE = "cp2020-augmented";

/**
 * THE CONTROL'S HANDLER — the referee gate that actually refuses, and it reports what it did BY VALUE
 * so the refusal, the empty case and the real clear are each assertable rather than inferred from a
 * notification. Shared by the scene-control button and the API entry point, so the two can never
 * disagree about who may press it.
 */
export async function onGroundFireClearTool() {
  if (game.user?.isGM !== true) return { skipped: "permission" };
  const out = await fxClearGroundFires();
  if (out.cleared > 0) ui.notifications?.info?.(localizeParam("GroundFireCleared", { count: out.cleared }));
  else ui.notifications?.info?.(localize("GroundFireClearNone"));
  return out;
}

/**
 * Add the clear control to the token scene-control group (pure of the hook — exported for the keeper).
 * Augments an EXISTING group's `tools`; no bespoke canvas layer. Referee-only. Returns true when the
 * control was added, for the keeper's negative case.
 */
export function addGroundFireClearTool(controls) {
  if (game.user?.isGM !== true) return false;
  const tokens = controls?.tokens;
  if (!tokens?.tools) return false;
  tokens.tools["cp-fire-clear"] = {
    name: "cp-fire-clear",
    title: localize("GroundFireClearTool"),
    icon: "fa-solid fa-fire-extinguisher",
    button: true,
    order: Object.keys(tokens.tools).length,
    onChange: () => { onGroundFireClearTool().catch((e) => console.warn(`${SCOPE} | ground fire clear control failed`, e)); },
  };
  return true;
}

/** Install the control (the getSceneControlButtons hook). Wrapped so a control-API shift cannot break
 *  the scene controls. Wired once from cp2020-augmented.js. */
export function registerGroundFireClearTool() {
  Hooks.on("getSceneControlButtons", (controls) => {
    try { addGroundFireClearTool(controls); } catch (e) { console.warn(`${SCOPE} | ground fire clear control failed`, e); }
  });
}
