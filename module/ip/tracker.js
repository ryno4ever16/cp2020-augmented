import {
  getQueue, queueRolls, pruneOrphanQueue, pruneQueueRoll, updateQueueRow, resolveQueueRow,
  dismissQueueRow, clearQueue, applyPending, resetThrottle, awardPending, addToPool, pendingForSkill,
  bankForSkill, poolForActor, setActorPool, setSkillBank
} from "./ip.js";
import { ipRawTracking, ipAwardModel, ipThrottle } from "../settings.js";
import { localize } from "../utils.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** How long ago a roll happened, in core's own words ("3 minutes ago"), so the reading is localized
 *  and phrased the way the rest of Foundry phrases it. A clock time is the fallback if core's
 *  helper is unavailable — the roll's total is the load-bearing figure either way. */
function _rollAge(ts) {
  const when = Number(ts) || 0;
  if (!when) return "";
  try { return foundry.utils.timeSince(when); }
  catch (e) { return new Date(when).toLocaleTimeString(); }
}

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
      ipClear:  IpTracker._onClear,
      ipOpenRow: IpTracker._onOpenRow,
      ipPruneRoll: IpTracker._onPruneRoll,
      ipReset:  IpTracker._onReset,
      ipManual: IpTracker._onManual,
      ipAward:  IpTracker._onAward,
      ipSkip:   IpTracker._onSkip,
    },
  };

  static PARTS = {
    main: { template: "modules/cp2020-augmented/templates/ip/tracker.hbs" },
  };

  /** Which coalesced rows the GM has opened. Held on the window, not in the store: it is a view
   *  state, and it must survive the re-render every queue write triggers. */
  _openRows = new Set();

  async _prepareContext(_options) {
    const auto = ipAwardModel() === "autoBaseline";
    // Self-heal: drop any rows whose source actor was deleted (e.g. old test-actor debris) before
    // building the list — rerender:false since we're already inside a render.
    await pruneOrphanQueue({ rerender: false });
    const rows = getQueue().map(r => {
      const rolls = queueRolls(r);
      const newest = rolls.reduce((a, b) => (b.ts > a.ts ? b : a), rolls[0] ?? { ts: 0 });
      return {
        ...r,
        count: rolls.length,
        single: rolls.length === 1,
        newestTs: Number(newest?.ts) || 0,
        open: this._openRows.has(r.id),
        // Newest first: a spree is read from its latest roll backwards.
        rolls: rolls.slice().sort((a, b) => b.ts - a.ts).map(x => ({ id: x.id, total: x.total, age: _rollAge(x.ts) })),
      };
    }).sort((a, b) => b.newestTs - a.newestTs);   // fresh activity stays at the top of the list
    // Forget rows that have since been awarded or discarded, so the open-set can't grow forever.
    this._openRows = new Set(rows.filter(r => r.open).map(r => r.id));

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

  /** Apply = release pending IP to the players and start a new throttle cycle. It deliberately does
   *  NOT resolve or drop queued rows: rows the GM hasn't ruled on are still theirs to rule on after
   *  an Apply, and can be awarded into the next cycle. Discarding them is _onClear's job. */
  static async _onApply(event, target) {
    await applyPending();
    this.render(false);
  }

  /** Discard every queued roll without awarding anything — the one control that empties the queue,
   *  so it says how many rolls are about to go. */
  static async _onClear(event, target) {
    const count = getQueue().length;
    if (!count) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: localize("IpClearTitle") },
      content: `<p>${localize("IpClearBody", { count })}</p>`,
      yes: { callback: () => true },
      no: { default: true, callback: () => false },
    });
    if (!ok) return;
    await clearQueue();
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

  /** Open (or close) a coalesced row's list of individual rolls. The class is toggled in place
   *  rather than re-rendered: an amount the GM has already typed into a neighbouring row keeps its
   *  focus, and the window's own record of what is open carries the state through the next render. */
  static _onOpenRow(event, target) {
    const row = target.closest("[data-row-id]");
    const rowId = row?.dataset?.rowId;
    const list = row?.querySelector(".cp-ip-row-rolls");
    if (!rowId || !list) return;
    const open = list.classList.contains("cp-hidden");
    list.classList.toggle("cp-hidden", !open);
    if (open) this._openRows.add(rowId); else this._openRows.delete(rowId);
  }

  /** Remove one roll from an opened group (curation, not awarding). */
  static async _onPruneRoll(event, target) {
    const rowId = target.closest("[data-row-id]")?.dataset?.rowId;
    const rollId = target.closest("[data-roll-id]")?.dataset?.rollId;
    await pruneQueueRoll(rowId, rollId);
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
              // Explicit GM manual add BYPASSES the anti-grind throttle (R6) — but still records the
              // award in the cycle bookkeeping. Warn if it fails for any other reason (invalid input).
              if (skill && !(await awardPending(actor, skill, amount, { bypassThrottle: true }))) {
                ui.notifications?.warn(localize("IpAwardFailed"));
              }
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
