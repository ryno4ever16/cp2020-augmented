/**
 * Embark / Disembark token-HUD controls (user request 2026-07-31: boarding should be a player
 * gesture on deployed vehicles — MM doesn't formalise it, the automation is ours).
 *
 * The engine half already exists in vehicle-canvas.js (boardedVehicle flag + crew-follow with
 * the GM relay); this file adds the gesture: select a crew token adjacent to / overlapping a
 * vehicle token and the HUD shows Embark; while boarded it shows Disembark (drops in place —
 * the token simply stops following). Players act on their OWN tokens, so no relay is needed
 * for the gesture itself.
 *
 * Capacity is a SOFT warning (crewSlots + passengerSlots): boarding proceeds — GMs override
 * fiction constantly.
 */

import { boardVehicle, disembark, isVehicleTokenDoc, tokenHeadingOf, hullRectOf } from "./vehicle-canvas.js";
import { pointInRotatedRect } from "./vehicle-layout.js";
import { occupancyOf, toggleOccupantFade, isVehicleFaded } from "./vehicle-occupancy.js";
import { localizeParam, tryLocalize } from "../utils.js";

const SCOPE = "cp2020-augmented";

/**
 * Vehicle placeables whose footprint — grown by one grid square, and TURNED to the vehicle's own
 * heading — contains the token's centre. The rotated test is what makes a car parked at an angle
 * reachable from the kerb it is actually next to, rather than from the corners of a bounding box
 * that contains half a pavement it is nowhere near.
 */
function _vehiclesInReach(tokenDoc) {
  const scene = tokenDoc.parent;
  const grid = scene?.grid?.size ?? 100;
  const cx = tokenDoc.x + (tokenDoc.width * grid) / 2;
  const cy = tokenDoc.y + (tokenDoc.height * grid) / 2;
  const hits = [];
  for (const t of scene?.tokens ?? []) {
    if (t.id === tokenDoc.id || !isVehicleTokenDoc(t) || !t.actor) continue;
    // Reach is measured from the HULL, grown by one square — not from the token's frame square,
    // which on a narrow vehicle already stands half a square proud of the bodywork and would let a
    // pedestrian board a car they are two squares away from.
    const { rect } = hullRectOf(t, grid);
    const reach = {
      x: rect.x - grid, y: rect.y - grid,
      w: rect.w + 2 * grid, h: rect.h + 2 * grid,
    };
    if (pointInRotatedRect({ x: cx, y: cy }, reach, tokenHeadingOf(t))) {
      const vx = rect.x + rect.w / 2, vy = rect.y + rect.h / 2;
      hits.push({ token: t, d2: (vx - cx) ** 2 + (vy - cy) ** 2 });
    }
  }
  return hits.sort((a, b) => a.d2 - b.d2).map(h => h.token);
}

async function _onEmbark(tokenDoc) {
  const vehicle = _vehiclesInReach(tokenDoc)[0];
  if (!vehicle) {
    ui.notifications?.warn?.(tryLocalize("VehicleEmbarkNone", "No vehicle within reach."));
    return;
  }
  const va = vehicle.actor;
  const { count: aboard, capacity: cap } = occupancyOf(va, tokenDoc.parent);
  if (cap > 0 && aboard >= cap) {
    ui.notifications?.warn?.(localizeParam("VehicleEmbarkFull", { name: va.name, count: aboard + 1, cap }));
  }
  await boardVehicle(tokenDoc, va, vehicle);
  ui.notifications?.info?.(localizeParam("VehicleEmbarked", { name: va.name }));
}

async function _onDisembark(tokenDoc) {
  await disembark(tokenDoc);
  ui.notifications?.info?.(tryLocalize("VehicleDisembarked", "Disembarked."));
}

/** One HUD control, in Foundry's own button shape (icon + tooltip + aria label). */
function _hudButton(className, iconClass, label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `control-icon ${className}`;
  btn.dataset.tooltip = label;
  btn.setAttribute("aria-label", label);
  const icon = document.createElement("i");
  icon.className = iconClass;
  btn.appendChild(icon);
  btn.addEventListener("click", onClick);
  return btn;
}

export function registerVehicleBoardingHud() {
  Hooks.on("renderTokenHUD", (hud, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    const tokenDoc = hud?.object?.document;
    if (!root || !tokenDoc) return;
    const col = root.querySelector(".col.right") ?? root;

    // A vehicle can't board a vehicle; its one control fades the people riding it, so a crowded
    // cab stops hiding the hull. Client-local (see vehicle-occupancy.js) — nobody else's view
    // changes, so it needs no ownership beyond being able to see the token.
    if (isVehicleTokenDoc(tokenDoc)) {
      const vehicleId = tokenDoc.actorId;
      if (!vehicleId || occupancyOf(tokenDoc.actor, tokenDoc.parent).count === 0) return;
      const faded = isVehicleFaded(vehicleId);
      const label = faded
        ? tryLocalize("Vehicle.ShowOccupants", "Show occupants")
        : tryLocalize("Vehicle.FadeOccupants", "Fade occupants");
      col.appendChild(_hudButton(
        `cp-vehicle-fade ${faded ? "cp-fade-on" : "cp-fade-off"}`,
        faded ? "fas fa-eye" : "fas fa-eye-slash",
        label,
        (ev) => { ev.preventDefault(); toggleOccupantFade(vehicleId); hud.render?.(true); },
      ));
      return;
    }

    if (!tokenDoc.actor?.isOwner) return;
    const boarded = tokenDoc.flags?.[SCOPE]?.boardedVehicle;
    if (!boarded && _vehiclesInReach(tokenDoc).length === 0) return;

    const label = boarded
      ? tryLocalize("VehicleDisembark", "Disembark")
      : tryLocalize("VehicleEmbark", "Embark");
    col.appendChild(_hudButton(
      `cp-vehicle-board ${boarded ? "cp-board-out" : "cp-board-in"}`,
      boarded ? "fas fa-person-walking-arrow-right" : "fas fa-van-shuttle",
      label,
      async (ev) => {
        ev.preventDefault();
        if (boarded) await _onDisembark(tokenDoc);
        else await _onEmbark(tokenDoc);
        hud.render?.(true);
      },
    ));
  });
}
