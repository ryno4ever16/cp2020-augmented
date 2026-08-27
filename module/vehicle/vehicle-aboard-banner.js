/**
 * vehicle-aboard-banner.js — the passenger's own way off the vehicle.
 *
 * A rider is a small token sitting inside a car; on a busy canvas that is a fiddly thing to
 * click. Their CHARACTER SHEET, though, is always one click away in the sidebar and needs no
 * token at all — so while they are aboard, the sheet carries a strip naming the vehicle with a
 * Step Out control.
 *
 * It is injected from a hook rather than added to the character sheet's own template: the banner
 * is a vehicle feature, and this keeps the whole of it — markup, wiring and strings — inside the
 * vehicle module. Structure still lives in a `.hbs` (templates/actor/parts/aboard-banner.hbs);
 * this file only supplies data and binds the click, per the Category-B injected-UI pattern.
 */

import { aboardPlacesFor } from "./vehicle-occupancy.js";
import { disembark } from "./vehicle-canvas.js";

const SCOPE = "cp2020-augmented";
const BANNER_CLASS = "cp-aboard-banner";
const TEMPLATE = `modules/${SCOPE}/templates/actor/parts/aboard-banner.hbs`;

const renderTemplate = (path, data) =>
  (foundry.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate)(path, data);

/** Draw (or clear) the banner on one rendered actor sheet. */
async function _syncBanner(app, root) {
  if (!root) return;
  root.querySelectorAll?.(`.${BANNER_CLASS}`).forEach(el => el.remove());

  const actor = app?.document ?? app?.actor;
  if (!actor || actor.type === `${SCOPE}.vehicle`) return;
  // Prefer the aboard token on the scene being LOOKED AT, so the ordinary case reads as "here" and
  // only a genuinely remote seat reads as remote.
  const places = aboardPlacesFor(actor);
  const here = canvas?.scene?.id ?? null;
  const aboard = places.find(p => p.scene.id === here) ?? places[0] ?? null;
  if (!aboard) return;

  // ⭐ SAY WHERE IT ACTS (field report 2026-08-25). The strip used to name only the vehicle, so a
  // character with a second token on another scene saw a Step Out control with no vehicle in sight
  // and no way to tell that pressing it would act somewhere else entirely. It does act correctly —
  // on the token that is actually aboard — so the fix is to NAME that place, not to hide the
  // control. On the scene you are looking at, the wording stays exactly as it was.
  const html = await renderTemplate(TEMPLATE, {
    vehicleName: aboard.vehicle.name,
    sceneName: aboard.scene.name,
    remote: aboard.scene.id !== here,
    tokenId: aboard.tokenDoc.id,
    sceneId: aboard.scene.id,
  });
  const holder = document.createElement("div");
  holder.innerHTML = html;
  const banner = holder.firstElementChild;
  if (!banner) return;

  banner.querySelector(".cp-aboard-out")?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const scene = game.scenes.get(banner.dataset.sceneId);
    const tokenDoc = scene?.tokens?.get(banner.dataset.tokenId);
    if (tokenDoc) await disembark(tokenDoc);
    app.render(false);
  });

  const anchor = root.querySelector(".cp-actor-sheet-root") ?? root;
  anchor.prepend(banner);
}

export function registerVehicleAboardBanner() {
  // ApplicationV2 fires its render hook once per class in the sheet's inheritance chain, so the
  // ActorSheetV2 name catches every actor sheet — ours and any other registered one.
  Hooks.on("renderActorSheetV2", (app, element) => {
    const root = element instanceof HTMLElement ? element : (element?.[0] ?? app?.element);
    _syncBanner(app, root);
  });

  // Boarding changes a flag on the TOKEN; the banner lives on the ACTOR's sheet, so refresh it
  // when that flag moves (both directions) and the sheet happens to be open.
  Hooks.on("updateToken", (doc, change) => {
    const flagChange = change?.flags?.[SCOPE] ?? {};
    if (!("boardedVehicle" in flagChange) && !("-=boardedVehicle" in flagChange)) return;
    const sheet = doc.actor?.sheet;
    if (sheet?.rendered) sheet.render(false);
  });
}
