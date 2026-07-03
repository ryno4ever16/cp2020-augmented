import {
  getQueue, pruneOrphanQueue, updateQueueRow, resolveQueueRow, dismissQueueRow, resolveAllQueue,
  applyPending, resetThrottle, awardPending, addToPool, pendingForSkill,
  bankForSkill, poolForActor, setActorPool, setSkillBank
} from "./ip.js";
import { ipRawTracking, ipAwardModel, ipThrottle } from "../settings.js";
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
    // Self-heal: drop any rows whose source actor was deleted (e.g. old test-actor debris) before
    // building the list — rerender:false since we're already inside a render.
    await pruneOrphanQueue({ rerender: false });
    const rows = getQueue().map(r => ({ ...r }));

    // GM correction / balances view: each party actor's fungible pool + every skill that carries IP
    // (banked or pending). Pool + bank are GM-editable in the template; pending is shown read-only.
    const balances = [];
    let pendingTotal = 0;
    for (const a of game.actors.filter(x => x.type === "character" || x.type === "npc")) {
      const skills = [];
      for (const s of a.items) {
        if (s.type !== "skill") continue;
        const bank = bankForSkill(s);
        const pend = pendingForSkill(s);
        pendingTotal += pend;
        if (bank > 0 || pend > 0) skills.push({ skillId: s.id, skillName: s.name, bank, pending: pend });
      }
      const pool = poolForActor(a);
      if (pool > 0 || skills.length) {
        skills.sort((x, y) => x.skillName.localeCompare(y.skillName));
        balances.push({ actorId: a.id, actorName: a.name, pool, skills });
      }
    }
    balances.sort((x, y) => x.actorName.localeCompare(y.actorName));

    return {
      auto,
      simple: !ipRawTracking(),
      throttle: ipThrottle(),
      rows,
      rowCount: rows.length,
      balances,
      hasBalances: balances.length > 0,
      pendingTotal,
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

    // GM correction: edit a skill's banked IP or an actor's pool to an absolute value (add or remove).
    // No re-render — the field already shows the typed value, and a re-render would steal focus.
    root.querySelectorAll(".cp-ip-bank").forEach(el => el.addEventListener("change", async (ev) => {
      const r = ev.currentTarget.closest("[data-skill-id]");
      const actor = game.actors.get(r?.dataset?.actorId);
      const skill = actor?.items.get(r?.dataset?.skillId);
      if (skill) await setSkillBank(skill, ev.currentTarget.value);
    }));
    root.querySelectorAll(".cp-ip-pool").forEach(el => el.addEventListener("change", async (ev) => {
      const actor = game.actors.get(ev.currentTarget.dataset?.actorId);
      if (actor) await setActorPool(actor, ev.currentTarget.value);
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

  /** Manual add: pick an actor, then a skill (RAW mode), then an IP amount (or add to the pool in
   *  simple mode). Singleton — re-invoking focuses the open dialog instead of stacking a new one. */
  async _manualAdd() {
    const actors = game.actors.filter(a => a.type === "character" || a.type === "npc");
    if (!actors.length) return;
    if (_manualDlg?.rendered) { (_manualDlg.bringToFront ?? _manualDlg.bringToTop)?.call(_manualDlg); return _manualDlg; }   // singleton

    const simple = !ipRawTracking();
    const renderTemplate = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
    const content = await renderTemplate("modules/cp2020-augmented/templates/ip/manual-add.hbs", {
      simple,
      actorOptions: actors.map(a => ({ value: a.id, label: a.name })),
    });
    _manualDlg = new foundry.applications.api.DialogV2({
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
    });
    await _manualDlg.render({ force: true });

    // Populate the skill <select> AFTER render and keep it in sync with the chosen actor. DialogV2 has
    // no render-callback option, so the old inline `render:` config was silently ignored and the
    // dropdown never filled; wiring it on the live DOM here is the fix.
    if (!simple) {
      const r = _manualDlg.element;
      const actorSel = r?.querySelector('[name="actor"]');
      const skillSel = r?.querySelector('[name="skill"]');
      const fillSkills = () => {
        if (!skillSel) return;
        const a = game.actors.get(actorSel?.value);
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
    }
    return _manualDlg;
  }
}

let _ipTracker = null;
let _manualDlg = null;

/** Open (or focus) the GM IP Tracker. GM-only. */
export function openIpTracker() {
  if (!game.user.isGM) { ui.notifications?.warn(localize("IpTrackerGmOnly")); return; }
  // ApplicationV2 exposes bringToFront (not the V1 bringToTop) — calling bringToTop() here THREW, so
  // re-opening the tracker crashed. Prefer bringToFront, fall back to bringToTop on a V1 host; optional-call.
  if (_ipTracker?.rendered) { (_ipTracker.bringToFront ?? _ipTracker.bringToTop)?.call(_ipTracker); return _ipTracker; }
  _ipTracker = new IpTracker();
  _ipTracker.render(true);
  return _ipTracker;
}
