import {
  getQueue, updateQueueRow, resolveQueueRow, dismissQueueRow, resolveAllQueue,
  applyPending, resetThrottle, awardPending, addToPool, pendingForSkill
} from "./ip.js";
import { ipSystem, ipAwardModel, ipThrottle } from "../settings.js";
import { localize } from "../utils.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * GM IP Tracker (RAW mode) — [[ip-tracker-design]].
 *
 * Shows the auto-queue of skill rolls awaiting an IP decision (each row = actor · skill · result),
 * a column to enter IP (manual model) or tick success (auto-baseline model), plus a manual-add and
 * a per-skill pending summary. "Apply" resolves all rows and releases pending → banked (visible to
 * players), clearing the queue + throttle for a new cycle. GM-only. Pending IP lives in module flags.
 */
export class IpTracker extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "cp-ip-tracker",
    classes: ["cyberpunk", "cp-ip-tracker"],
    window: { title: "CYBERPUNK.IpTrackerTitle" },
    position: { width: 560, height: 600 },
    resizable: true,
    actions: {
      ipApply:  IpTracker._onApply,
      ipReset:  IpTracker._onReset,
      ipManual: IpTracker._onManual,
      ipAward:  IpTracker._onAward,
      ipSkip:   IpTracker._onSkip,
    },
  };

  static PARTS = {
    main: { template: "modules/cp2020-augmented/templates/ip/tracker.hbs" },
  };

  async _prepareContext(_options) {
    const auto = ipAwardModel() === "autoBaseline";
    const rows = getQueue().map(r => ({ ...r }));

    // Per-skill pending summary across the party (read from the module flag).
    const pending = [];
    for (const a of game.actors.filter(x => x.type === "character" || x.type === "npc")) {
      for (const s of a.items) {
        if (s.type !== "skill") continue;
        const p = pendingForSkill(s);
        if (p > 0) pending.push({ actorName: a.name, skillName: s.name, pending: p });
      }
    }
    pending.sort((x, y) => x.actorName.localeCompare(y.actorName) || x.skillName.localeCompare(y.skillName));

    return {
      auto,
      simple: ipSystem() === "simple",
      throttle: ipThrottle(),
      rows,
      rowCount: rows.length,
      pending,
      pendingTotal: pending.reduce((t, p) => t + p.pending, 0)
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    if (!root) return;
    const rowId = (el) => el.closest("[data-row-id]")?.dataset?.rowId;

    root.querySelectorAll(".cp-ip-amount").forEach(el => el.addEventListener("change", (ev) => {
      updateQueueRow(rowId(ev.currentTarget), { ip: Math.max(0, parseInt(ev.currentTarget.value, 10) || 0) });
    }));
    root.querySelectorAll(".cp-ip-success").forEach(el => el.addEventListener("change", (ev) => {
      updateQueueRow(rowId(ev.currentTarget), { success: ev.currentTarget.checked });
    }));
  }

  // ---------- actions (static, bound by V2 via data-action) ----------

  static async _onApply(event, target) {
    await resolveAllQueue();
    await applyPending();
    this.render(false);
  }

  static async _onReset(event, target) {
    await resetThrottle();
    ui.notifications?.info(localize("IpThrottleReset"));
  }

  static _onManual(event, target) {
    this._manualAdd();
  }

  static async _onAward(event, target) {
    const r = target.closest("[data-row-id]");
    const rowId = r?.dataset?.rowId;
    const amt = r?.querySelector(".cp-ip-amount");
    const suc = r?.querySelector(".cp-ip-success");
    const patch = {};
    if (amt) patch.ip = Math.max(0, parseInt(amt.value, 10) || 0);
    if (suc) patch.success = suc.checked;
    await updateQueueRow(rowId, patch);
    await resolveQueueRow(rowId);
  }

  static async _onSkip(event, target) {
    const rowId = target.closest("[data-row-id]")?.dataset?.rowId;
    await dismissQueueRow(rowId);
  }

  /** Manual add: pick an actor, then a skill, then an IP amount (or add to the Simple pool). */
  async _manualAdd() {
    const actors = game.actors.filter(a => a.type === "character" || a.type === "npc");
    if (!actors.length) return;
    const simple = ipSystem() === "simple";
    const renderTemplate = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
    const content = await renderTemplate("modules/cp2020-augmented/templates/ip/manual-add.hbs", {
      simple,
      actorOptions: actors.map(a => ({ value: a.id, label: a.name })),
    });
    const dlg = new foundry.applications.api.DialogV2({
      window: { title: localize("IpManualTitle") },
      content,
      buttons: [
        {
          action: "add",
          label: localize("IpManualAdd"),
          default: true,
          callback: async (ev, btn, dialog) => {
            const r = dialog.element;
            const actor = game.actors.get(r.querySelector('[name="actor"]')?.value);
            const amount = Math.max(1, parseInt(r.querySelector('[name="amount"]')?.value, 10) || 1);
            if (!actor) return;
            if (simple) { await addToPool(actor, amount); }
            else {
              const skill = actor.items.get(r.querySelector('[name="skill"]')?.value);
              if (skill) await awardPending(actor, skill, amount);
            }
            this.render(false);
          },
        },
        { action: "cancel", label: localize("Cancel") },
      ],
      render: (event, dialog) => {
        const r = dialog.element;
        const actorSel = r.querySelector('[name="actor"]');
        const skillSel = r.querySelector('[name="skill"]');
        const fillSkills = () => {
          if (!skillSel) return;
          const a = game.actors.get(actorSel.value);
          const skills = (a?.items.filter(i => i.type === "skill") ?? []).sort((x, y) => x.name.localeCompare(y.name));
          skillSel.replaceChildren(...skills.map(s => {
            const opt = document.createElement("option");
            opt.value = s.id;
            opt.textContent = s.name;
            return opt;
          }));
        };
        actorSel?.addEventListener("change", fillSkills);
        fillSkills();
      },
    });
    dlg.render({ force: true });
  }
}

let _ipTracker = null;

/** Open (or focus) the GM IP Tracker. GM-only. */
export function openIpTracker() {
  if (!game.user.isGM) { ui.notifications?.warn(localize("IpTrackerGmOnly")); return; }
  if (_ipTracker?.rendered) { _ipTracker.bringToTop(); return _ipTracker; }
  _ipTracker = new IpTracker();
  _ipTracker.render(true);
  return _ipTracker;
}
