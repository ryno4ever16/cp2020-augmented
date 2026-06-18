import { ipEnabled } from "../settings.js";
import { ipDisplayForActor, levelUpSkill, toggleSkillLock } from "./ip.js";
import { localize } from "../utils.js";

/**
 * In-sheet IP UI — the player-facing surface of the IP tracker, woven into Tilt's actor sheet.
 *
 * The module can't modify the base system's sheet template, so the per-skill IP cluster + skills-tab
 * lock header are injected at render time. The render hook `renderCyberpunkActorSheet` fires for BOTH
 * his vanilla V1 ActorSheet and our fork's V2 ActorSheetV2 (same class name), and the skill-row markup
 * (`.skill-top-matter` / `.field-list` / `.field.skill[data-item-id]`) is shared-lineage and identical
 * across V1/V2 — so the injection anchors transfer with no version branching.
 *
 * When the module is active the base system stands its own IP UI down (its `ipEnabled()` returns false
 * there), so nothing double-renders. Every injected interactive element is `cp2020ae-`-prefixed so it
 * can never be caught by the system's own `.ip-level-up` / `.ip-lock-toggle` delegated handlers.
 */

const CLUSTER_TPL = "modules/cp2020-augmented/templates/ip/skill-cluster.hbs";
const HEADER_TPL = "modules/cp2020-augmented/templates/ip/skills-header.hbs";

export function registerIpSheet() {
  Hooks.on("renderCyberpunkActorSheet", injectIpSheet);
}

async function injectIpSheet(app, html, _context) {
  try {
    if (!ipEnabled()) return;
    const actor = app?.actor ?? app?.document ?? app?.object;
    if (!actor) return;
    const root = _rootEl(html);
    if (!root) return;

    const display = ipDisplayForActor(actor);
    if (!display.enabled) return;

    const render = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;

    // 1) Per-skill cluster (banked/cost + GM pending pip + the self-service level-up arrow).
    for (const row of root.querySelectorAll(".field.skill[data-item-id]")) {
      if (row.querySelector(".cp2020ae-ip-cluster")) continue;        // idempotent across re-renders
      const skillId = row.dataset.itemId;
      const ipd = display.bySkill[skillId];
      if (!ipd) continue;
      row.insertAdjacentHTML("beforeend", await render(CLUSTER_TPL, { ipd, skillId, showPending: display.showPending }));
      // Mirror the system's lock: make the skill-level field read-only while the actor's skills are locked.
      if (display.locked) {
        const lvl = row.querySelector(".skill-level");
        if (lvl && !lvl.readOnly) { lvl.readOnly = true; lvl.title = localize("IpSkillLockToggle"); }
      }
    }

    // 2) Skills-tab header (Simple-mode pool + lock toggle), inserted just above the skill list.
    const topMatter = root.querySelector(".skill-top-matter");
    if (topMatter && !topMatter.parentElement?.querySelector(".cp2020ae-ip-skills-header")) {
      topMatter.insertAdjacentHTML("afterend", await render(HEADER_TPL, display));
    }

    // 3) Wire interactions on the freshly-rendered DOM (re-attached every render; the level-up's own
    //    document update re-renders the sheet, which re-runs this injection with fresh numbers).
    for (const arrow of root.querySelectorAll(".cp2020ae-ip-level-up")) {
      arrow.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const skill = actor.items.get(arrow.dataset.skillId);
        if (skill) await levelUpSkill(actor, skill);
      });
    }
    const lock = root.querySelector(".cp2020ae-ip-lock-toggle");
    if (lock) lock.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await toggleSkillLock(actor);
      app.render(false);
    });
  } catch (e) {
    console.warn("cp2020-augmented | IP sheet injection failed", e);
  }
}

/** Normalize the render hook's 2nd arg to a root HTMLElement (V2 passes the element; V1 jQuery). */
function _rootEl(html) {
  if (!html) return null;
  if (html instanceof HTMLElement) return html;
  if (html.jquery) return html[0] ?? null;
  return html[0] ?? html;
}
