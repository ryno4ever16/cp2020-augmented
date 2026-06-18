import { shoppingEnabled } from "../settings.js";
import { installCyberware } from "./install.js";

/**
 * In-sheet cyberware "Install (Surgery)" button — the shop slice's item-sheet deferral.
 *
 * Injected into the cyberware ITEM sheet at render time via `renderCyberpunkItemSheet` (fires on his
 * vanilla V1 ItemSheet and our fork's V2 ItemSheet alike). The base system's cyberware template
 * already carries its own `.cyber-install` button and that template ISN'T module-guarded, so on the
 * FORK the system provides a working button — we detect it and skip, only injecting on the vanilla
 * system where it's absent. The button is `cp2020ae-`-prefixed for isolation.
 *
 * Anchor: just after the Surgery Code field, which exists on both his vanilla and our fork cyberware
 * item sheet (verified against supercoon/main:templates/item/parts/cyberware/settings.hbs).
 */

const BTN_TPL = "modules/cp2020-augmented/templates/cyberware/install-button.hbs";

export function registerCyberwareSheet() {
  Hooks.on("renderCyberpunkItemSheet", injectInstallButton);
}

async function injectInstallButton(app, html, _context) {
  try {
    if (!shoppingEnabled()) return;
    const item = app?.item ?? app?.document ?? app?.object;
    if (!item || item.type !== "cyberware" || !item.isEmbedded) return;
    const actor = item.actor;
    if (!actor) return;
    const root = _rootEl(html);
    if (!root) return;

    // The base system (fork) already renders an install button — don't double it; vanilla only.
    if (root.querySelector(".cyber-install, .cp2020ae-cyber-install")) return;

    const surg = root.querySelector('input[name="system.surgCode"]');
    const anchor = surg?.closest(".field") ?? root.querySelector(".field-list");
    if (!anchor) return;

    const render = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
    const frag = await render(BTN_TPL, {});
    if (anchor.classList?.contains("field-list")) anchor.insertAdjacentHTML("beforeend", frag);
    else anchor.insertAdjacentHTML("afterend", frag);

    root.querySelector(".cp2020ae-cyber-install")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await installCyberware(actor, item, { confirm: true });
    });
  } catch (e) {
    console.warn("cp2020-augmented | cyberware install-button injection failed", e);
  }
}

/** Normalize the render hook's 2nd arg to a root HTMLElement (V2 passes the element; V1 jQuery). */
function _rootEl(html) {
  if (!html) return null;
  if (html instanceof HTMLElement) return html;
  if (html.jquery) return html[0] ?? null;
  return html[0] ?? html;
}
