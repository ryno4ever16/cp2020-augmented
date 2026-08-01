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

import { boardVehicle, disembark, isVehicleTokenDoc } from "./vehicle-canvas.js";
import { localizeParam, tryLocalize } from "../utils.js";

const SCOPE = "cp2020-augmented";

/** Vehicle placeables whose footprint (grown by one grid square) contains the token's centre. */
function _vehiclesInReach(tokenDoc) {
  const scene = tokenDoc.parent;
  const grid = scene?.grid?.size ?? 100;
  const cx = tokenDoc.x + (tokenDoc.width * grid) / 2;
  const cy = tokenDoc.y + (tokenDoc.height * grid) / 2;
  const hits = [];
  for (const t of scene?.tokens ?? []) {
    if (t.id === tokenDoc.id || !isVehicleTokenDoc(t) || !t.actor) continue;
    const x0 = t.x - grid, y0 = t.y - grid;
    const x1 = t.x + t.width * grid + grid, y1 = t.y + t.height * grid + grid;
    if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) {
      const vx = t.x + (t.width * grid) / 2, vy = t.y + (t.height * grid) / 2;
      hits.push({ token: t, d2: (vx - cx) ** 2 + (vy - cy) ** 2 });
    }
  }
  return hits.sort((a, b) => a.d2 - b.d2).map(h => h.token);
}

function _boardedCount(scene, vehicleActorId) {
  return scene.tokens.filter(t => t.flags?.[SCOPE]?.boardedVehicle === vehicleActorId).length;
}

async function _onEmbark(tokenDoc) {
  const vehicle = _vehiclesInReach(tokenDoc)[0];
  if (!vehicle) {
    ui.notifications?.warn?.(tryLocalize("VehicleEmbarkNone", "No vehicle within reach."));
    return;
  }
  const va = vehicle.actor;
  const cap = (Number(va.system?.crewSlots) || 0) + (Number(va.system?.passengerSlots) || 0);
  const aboard = _boardedCount(tokenDoc.parent, va.id);
  if (cap > 0 && aboard >= cap) {
    ui.notifications?.warn?.(localizeParam("VehicleEmbarkFull", { name: va.name, count: aboard + 1, cap }));
  }
  await boardVehicle(tokenDoc, va);
  ui.notifications?.info?.(localizeParam("VehicleEmbarked", { name: va.name }));
}

async function _onDisembark(tokenDoc) {
  await disembark(tokenDoc);
  ui.notifications?.info?.(tryLocalize("VehicleDisembarked", "Disembarked."));
}

export function registerVehicleBoardingHud() {
  Hooks.on("renderTokenHUD", (hud, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    const tokenDoc = hud?.object?.document;
    if (!root || !tokenDoc) return;
    if (isVehicleTokenDoc(tokenDoc)) return;                 // vehicles don't board vehicles
    if (!tokenDoc.actor?.isOwner) return;

    const boarded = tokenDoc.flags?.[SCOPE]?.boardedVehicle;
    if (!boarded && _vehiclesInReach(tokenDoc).length === 0) return;

    const col = root.querySelector(".col.right") ?? root;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `control-icon cp-vehicle-board ${boarded ? "cp-board-out" : "cp-board-in"}`;
    const label = boarded
      ? tryLocalize("VehicleDisembark", "Disembark")
      : tryLocalize("VehicleEmbark", "Embark");
    btn.dataset.tooltip = label;
    btn.setAttribute("aria-label", label);
    const icon = document.createElement("i");
    icon.className = boarded ? "fas fa-person-walking-arrow-right" : "fas fa-van-shuttle";
    btn.appendChild(icon);
    btn.addEventListener("click", async ev => {
      ev.preventDefault();
      if (boarded) await _onDisembark(tokenDoc);
      else await _onEmbark(tokenDoc);
      hud.render?.(true);
    });
    col.appendChild(btn);
  });
}
