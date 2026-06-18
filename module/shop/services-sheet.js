import { shoppingEnabled, canShop } from "../settings.js";
import { classifyService, servicePeriodOf, payService } from "./services.js";
import { localize } from "../utils.js";

/**
 * In-sheet Recurring Services panel — the shop slice's "Services tab" deferral.
 *
 * The system surfaces recurring services as a dedicated nav TAB; we deliberately do NOT inject a nav
 * tab (it would fight the user's tab-bar restyler modules + the V2 tab controller — see
 * [[reference-ui-modules-tab-restyle]]). Instead the panel is appended to the GEAR tab body, the
 * natural home for recurring bills, via renderCyberpunkActorSheet (fires on his vanilla V1 + our V2
 * sheet; `.tab[data-tab="gear"]` is identical on both).
 *
 * When the module is active the base system stands its own Services surface down (its shoppingEnabled()
 * is false), so there's no nav tab to collide with — but the service items still render in the gear
 * inventory, so we de-duplicate them out of the gear list (the panel is their home now). De-dup is
 * chrome-agnostic: hide the nearest row ancestor of each service's [data-item-id]; the panel's own
 * rows use data-service-id, so they're never matched.
 */

const SCOPE = "cp2020-augmented";
const PANEL_TPL = "modules/cp2020-augmented/templates/shop/services-panel.hbs";

export function registerServicesSheet() {
  Hooks.on("renderCyberpunkActorSheet", injectServices);
}

async function injectServices(app, html, _context) {
  try {
    if (!shoppingEnabled()) return;
    const actor = app?.actor ?? app?.document ?? app?.object;
    if (!actor) return;
    const root = _rootEl(html);
    if (!root) return;

    const gearTab = root.querySelector('.tab[data-tab="gear"]');
    if (!gearTab || gearTab.querySelector(".cp2020ae-services-panel")) return;  // idempotent

    const recurring = actor.items.filter(i => i.type === "misc" && classifyService(i) === "recurring");
    const services = recurring
      .map(i => ({ id: i.id, name: i.name, img: i.img, cost: Math.max(0, Math.round(Number(i.system?.cost) || 0)), period: servicePeriodOf(i) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const servicesTotal = services.reduce((s, x) => s + x.cost, 0);

    // De-dup: the recurring services live in the panel now — hide their gear-inventory rows.
    for (const svc of services) {
      gearTab.querySelectorAll(`[data-item-id="${svc.id}"]`).forEach((el) => {
        if (el.closest(".cp2020ae-services-panel")) return;
        (el.closest(".field, .item, li, tr") ?? el).style.display = "none";
      });
    }

    const render = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
    gearTab.insertAdjacentHTML("beforeend", await render(PANEL_TPL, { services, servicesTotal }));

    const panel = gearTab.querySelector(".cp2020ae-services-panel");
    if (!panel) return;
    const itemOf = (el) => actor.items.get(el?.dataset?.serviceId);

    panel.querySelector(".cp2020ae-service-add")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      if (!canShop()) { ui.notifications?.warn(localize("ShopNotAllowed")); return; }
      const [created] = await actor.createEmbeddedDocuments("Item", [{
        name: localize("ServiceNew"), type: "misc", system: { cost: 0 },
        flags: { [SCOPE]: { serviceMode: "recurring", servicePeriod: "month" } },
      }]);
      created?.sheet?.render(true);
    });
    panel.querySelectorAll(".cp2020ae-service-pay").forEach((btn) => btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const item = itemOf(btn);
      if (item) await payService(actor, item);
    }));
    panel.querySelectorAll(".cp2020ae-service-edit").forEach((btn) => btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      itemOf(btn)?.sheet?.render(true);
    }));
    panel.querySelectorAll(".cp2020ae-service-delete").forEach((btn) => btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const item = itemOf(btn);
      if (item) await item.delete();
    }));
  } catch (e) {
    console.warn("cp2020-augmented | services panel injection failed", e);
  }
}

/** Normalize the render hook's 2nd arg to a root HTMLElement (V2 passes the element; V1 jQuery). */
function _rootEl(html) {
  if (!html) return null;
  if (html instanceof HTMLElement) return html;
  if (html.jquery) return html[0] ?? null;
  return html[0] ?? html;
}
