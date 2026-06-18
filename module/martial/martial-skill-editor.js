/**
 * In-skill martial-art editor (item sheet) — module injection.
 *
 * The fork's skill sheet has an "Is Martial Art" checkbox + per-action bonus inputs bound to
 * system.isMartialArt / system.martialBonuses. His vanilla skill DataModel has neither, so the
 * module injects an equivalent editor that stores to flags.cp2020-augmented.* — exactly the fields
 * the engine's isMartialArtSkill / martialBonusesFor accessors read. Vanilla only: if the system
 * already renders [name="system.isMartialArt"] (the fork), the module skips (fork-double-up rule).
 */

import { MARTIAL_BONUS_ACTIONS } from "../lookups.js";
import { combatAutomationEnabled } from "../settings.js";

// Module flag / settings scope (per-file convention used across the module).
const SCOPE = "cp2020-augmented";
const EDITOR_TPL = "modules/cp2020-augmented/templates/item/martial-skill-editor.hbs";

export function registerMartialSkillEditor() {
  Hooks.on("renderCyberpunkItemSheet", injectMartialEditor);
}

/** Normalize the render hook's payload: V2 passes an HTMLElement, V1 jQuery. */
function _rootEl(html) {
  if (!html) return null;
  if (html instanceof HTMLElement) return html;
  if (html.jquery) return html[0] ?? null;
  return html[0] ?? html;
}

async function injectMartialEditor(app, html, _context) {
  if (!combatAutomationEnabled()) return;

  const item = app?.item ?? app?.document ?? app?.object;
  if (!item || item.type !== "skill") return;

  const root = _rootEl(html);
  if (!root?.querySelector) return;

  // Fork-double-up: the system already renders its own martial-art editor — leave it alone.
  if (root.querySelector('[name="system.isMartialArt"]')) return;
  // Idempotent.
  if (root.querySelector(".cp2020ae-martial-editor")) return;

  const bonuses = item.getFlag(SCOPE, "martialBonuses") ?? {};
  const data = {
    isMA: !!item.getFlag(SCOPE, "isMartialArt"),
    actions: MARTIAL_BONUS_ACTIONS.map((action) => ({ action, value: Number(bonuses[action]) || 0 })),
  };

  const render = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  const editorHtml = await render(EDITOR_TPL, data);

  // Inject after the field-list holding IsRoleSkill (last block of the skill settings), else append.
  const roleField = root.querySelector('[name="system.isRoleSkill"]')?.closest(".field-list");
  if (roleField) roleField.insertAdjacentHTML("afterend", editorHtml);
  else (root.querySelector(".sheet-body, .window-content, form") ?? root).insertAdjacentHTML("beforeend", editorHtml);

  const editor = root.querySelector(".cp2020ae-martial-editor");
  if (!editor) return;

  const checkbox = editor.querySelector(".cp2020ae-ma-isma");
  const grid = editor.querySelector(".cp2020ae-ma-bonus-grid");
  checkbox?.addEventListener("change", async () => {
    await item.setFlag(SCOPE, "isMartialArt", checkbox.checked);
    if (grid) grid.style.display = checkbox.checked ? "" : "none";
  });

  editor.querySelectorAll(".cp2020ae-ma-bonus").forEach((input) => {
    input.addEventListener("change", async () => {
      const action = input.dataset.action;
      if (!action) return;
      await item.update({ [`flags.${SCOPE}.martialBonuses.${action}`]: Number(input.value) || 0 });
    });
  });
}
