/**
 * In-sheet martial-arts panel (combat tab) — module injection.
 *
 * The fork renders its own .martial-panel into the combat tab. His vanilla combat tab has no
 * martial UI at all, so the module injects an equivalent panel after the weapons list — but ONLY
 * on vanilla: if the system already drew `.martial-action` buttons (the fork), the module skips
 * (the fork-double-up rule, same as the cyberware install button). Clicking an action opens a
 * focused style/cyberlimb dialog, then rollMartialAttack resolves it (martial.js).
 *
 * Gated on combatAutomationEnabled() — the panel emits cyberpunk2020.weaponFired, which only does
 * anything when the Augmented combat engine is running.
 */

import { martialActionGroups } from "../lookups.js";
import { localize, localizeParam } from "../utils.js";
import { combatAutomationEnabled } from "../settings.js";
import { rollMartialAttack, trainedMartials } from "./martial.js";

const PANEL_TPL  = "modules/cp2020-augmented/templates/martial/martial-panel.hbs";
const DIALOG_TPL = "modules/cp2020-augmented/templates/dialog/martial-style.hbs";

// Font Awesome icon per action (module-owned, so the panel needs none of the fork's system images).
const ACTION_ICONS = {
  Dodge: "fa-person-walking-arrow-right", BlockParry: "fa-shield-halved",
  AllOutParry: "fa-shield", AllOutDodge: "fa-person-running",
  Strike: "fa-hand-fist", Punch: "fa-hand-fist", Kick: "fa-shoe-prints",
  Disarm: "fa-hand", SweepTrip: "fa-person-falling", Ram: "fa-arrows-to-dot",
  JumpKick: "fa-person-running", Cast: "fa-wand-sparkles",
  Grapple: "fa-hands-bound", Hold: "fa-handshake-angle", Choke: "fa-hand-fist",
  Throw: "fa-person-falling-burst", Escape: "fa-person-running",
};

export function registerMartialSheet() {
  Hooks.on("renderCyberpunkActorSheet", injectMartialPanel);
}

/** Normalize the render hook's payload: V2 passes an HTMLElement, V1 jQuery. */
function _rootEl(html) {
  if (!html) return null;
  if (html instanceof HTMLElement) return html;
  if (html.jquery) return html[0] ?? null;
  return html[0] ?? html;
}

async function injectMartialPanel(app, html, _context) {
  if (!combatAutomationEnabled()) return;

  const actor = app?.actor ?? app?.document ?? app?.object;
  if (!actor) return;

  const root = _rootEl(html);
  if (!root?.querySelector) return;

  const combatTab = root.querySelector('.combat-tab, .tab[data-tab="combat"]');
  if (!combatTab) return;

  // Fork-double-up: the system already renders its own martial panel — leave it alone.
  if (combatTab.querySelector(".martial-action")) return;
  // Idempotent: never inject twice on re-render.
  if (combatTab.querySelector(".cp2020ae-martial-panel")) return;

  const groups = martialActionGroups().map((g) => ({
    groupName: g.groupName,
    actions: g.choices.map((action) => ({
      action,
      icon: ACTION_ICONS[action] ?? "fa-hand-fist",
      hint: game.i18n.has(`CYBERPUNK.${action}Hint`) ? localize(`${action}Hint`) : "",
    })),
  }));

  const render = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  const panelHtml = await render(PANEL_TPL, { groups });

  const anchor = combatTab.querySelector(".weapons-list");
  if (anchor) anchor.insertAdjacentHTML("afterend", panelHtml);
  else combatTab.insertAdjacentHTML("beforeend", panelHtml);

  combatTab.querySelectorAll(".cp2020ae-martial-action").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const action = btn.dataset.action;
      if (action) openMartialDialog(actor, action);
    });
  });
}

/** Style + cyberlimb + extra-mod dialog; on roll, hand off to rollMartialAttack. */
async function openMartialDialog(actor, action) {
  const styles = [
    { value: "Brawling", label: localize("SkillBrawling") },
    ...trainedMartials(actor).map((m) => ({ value: m.value, label: m.label })),
  ];
  const cyberChoices = [
    { value: "NoCyberlimb", label: localize("NoCyberlimb") },
    { value: "CyberTerminusX2", label: localize("CyberTerminusX2") },
    { value: "CyberTerminusX3", label: localize("CyberTerminusX3") },
  ];

  const render = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  const content = await render(DIALOG_TPL, {
    actionLabel: localize(action),
    styles,
    cyberChoices,
  });

  new foundry.applications.api.DialogV2({
    window: { title: localizeParam("MartialTitle", { action: localize(action), martialArt: localize("MartialArt") }) },
    content,
    buttons: [
      {
        action: "roll",
        label: localize("MartialRollBtn"),
        default: true,
        callback: async (ev, btn, dlg) => {
          const r = dlg.element;
          const martialArt = r.querySelector("#cp2020ae-ma-style")?.value || "Brawling";
          const cyberTerminus = r.querySelector("#cp2020ae-ma-cyber")?.value || "NoCyberlimb";
          const extraMod = Number(r.querySelector("#cp2020ae-ma-mod")?.value) || 0;
          await rollMartialAttack(actor, { martialArt, action, cyberTerminus, extraMod });
        },
      },
      { action: "cancel", label: localize("Cancel") },
    ],
  }).render(true);
}
