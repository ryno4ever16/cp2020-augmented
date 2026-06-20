import { localize } from "../utils.js";
import { postSavePromptCard } from "../compat.js";
import {
  ipEnabled, ipRawTracking, ipAwardModel, ipAutoBaselineAmount, ipThrottle, ipSkillLockMode, ipShowPending
} from "../settings.js";

/**
 * IP (Improvement Points) tracker — core logic ([[ip-tracker-design]]).
 *
 * Augmented Edition port: the IP fields are stored as MODULE FLAGS (flags.cp2020-augmented.*) on
 * Tilt's existing character/npc + skill documents, NOT on system.*, so the feature works on the
 * vanilla cyberpunk2020 system (which has no IP fields).
 *
 * Model A dual-bucket store (both additive, migration-safe, always present):
 *   • a skill's flag `ip` = BANKED IP earmarked to that skill (RAW per-skill attribution);
 *   • the actor's flag `ipPool` = a fungible, unattributed IP pool;
 *   • a skill's flag `ipPending` = IP the GM has attributed but NOT released (hidden from the player
 *     until the GM clicks Apply, which moves ipPending → ip).
 * Spendable on skill X = X's bank + the pool; a level-up spends the bank first, then the pool, so
 * banked RAW IP is never stranded by toggling RAW off. Plus a GM-only world queue `ipQueue` of skill
 * rolls awaiting an IP decision (RAW auto-tracking), and `ipThrottleCounts` per Apply cycle. Skill
 * `level`/`diffMod` are Tilt's own fields and stay on system.*.
 *
 * RAW on → new IP is attributed per-skill (queue); RAW off → the GM tops up the pool.
 */

const SCOPE = "cp2020-augmented";

// --- Flag accessors (the relocation boundary) ---
const skillIp      = (skill) => Number(skill?.getFlag?.(SCOPE, "ip")) || 0;
const skillPending = (skill) => Number(skill?.getFlag?.(SCOPE, "ipPending")) || 0;
const actorPool    = (actor) => Number(actor?.getFlag?.(SCOPE, "ipPool")) || 0;

/** RAW IP cost to raise this skill one level: max(1, level) × 10 × diffMod. */
export function ipCost(skill) {
  const level = Number(skill?.system?.level) || 0;
  const mult = Math.max(1, Number(skill?.system?.diffMod) || 1);
  return Math.max(1, level) * 10 * mult;
}

/**
 * PURE dual-bucket spend breakdown (Model A): pay `cost` from the skill's own bank first, then from the
 * fungible pool. So banked RAW IP is spent before pool IP and is never stranded by toggling RAW off.
 * @returns {{fromBank:number, fromPool:number, newBank:number, newPool:number, affordable:boolean}}
 */
export function ipSpendBreakdown(bank, pool, cost) {
  const b = Math.max(0, Number(bank) || 0);
  const p = Math.max(0, Number(pool) || 0);
  const c = Math.max(0, Number(cost) || 0);
  const fromBank = Math.min(b, c);
  const fromPool = c - fromBank;
  return { fromBank, fromPool, newBank: b - fromBank, newPool: p - fromPool, affordable: (b + p) >= c };
}

/* --------------------------------------------------------------------- */
/*  Skill lock (two-tier: owner soft-lock + GM hard-lock)                 */
/* --------------------------------------------------------------------- */

/** Resolve the lock state for an actor under the active mode. */
export function ipLockState(actor) {
  const owner = actor?.getFlag?.(SCOPE, "ipOwnerLock") === true;
  const gm = actor?.getFlag?.(SCOPE, "ipGmLock") === true;
  const mode = ipSkillLockMode();
  let locked;
  if (mode === "gm") locked = gm;
  else if (mode === "mutual") locked = owner || gm;
  else locked = owner;          // "owner" (default)
  return { owner, gm, mode, locked };
}

/** Whether raw hand-editing of skill levels/IP is currently allowed for this actor. */
export function canEditSkillLevels(actor) {
  if (!ipEnabled()) return true;          // lock only applies when the IP system is on
  return !ipLockState(actor).locked;
}

/** Toggle the appropriate lock tier for the current user (owner vs GM), honoring the mode. */
export async function toggleSkillLock(actor) {
  if (!actor) return;
  const { mode } = ipLockState(actor);
  const isGM = game.user.isGM;
  let flag;
  if (mode === "gm") flag = "ipGmLock";
  else if (mode === "owner") flag = "ipOwnerLock";
  else flag = isGM ? "ipGmLock" : "ipOwnerLock";   // mutual
  if (mode === "gm" && !isGM) { ui.notifications?.warn(localize("IpLockGmOnly")); return; }
  const cur = actor.getFlag(SCOPE, flag) === true;
  await actor.setFlag(SCOPE, flag, !cur);
}

/* --------------------------------------------------------------------- */
/*  In-sheet display payload                                              */
/* --------------------------------------------------------------------- */

/**
 * Build the in-sheet IP display payload for an actor: the global flags (Simple-mode pool, lock state,
 * GM pending visibility) plus a per-skill `{ cost, banked, pending, canLevel }` map. Reads the
 * relocation-boundary flag accessors so the in-sheet injection ([[ip-tracker-design]]) has a single
 * flag-based data source — the module mirror of the system's `_prepareIp`, but flag-stored so it
 * works on the vanilla cyberpunk2020 system.
 */
export function ipDisplayForActor(actor) {
  if (!actor || !ipEnabled()) return { enabled: false, bySkill: {} };
  const simple = !ipRawTracking();
  const isGM = game.user?.isGM === true;
  const lock = ipLockState(actor);
  const pool = actorPool(actor);
  const bySkill = {};
  for (const s of actor.items) {
    if (s.type !== "skill") continue;
    const cost = ipCost(s);
    const banked = skillIp(s);
    // Dual-bucket (Model A): available = the skill's own bank + the fungible pool, in every mode.
    const have = banked + pool;
    bySkill[s.id] = { cost, banked, pending: skillPending(s), canLevel: have >= cost };
  }
  return { enabled: true, simple, locked: lock.locked, lockMode: lock.mode, pool, showPending: isGM && ipShowPending(), bySkill };
}

/* --------------------------------------------------------------------- */
/*  Queue (auto-queue of skill rolls awaiting a GM IP decision)           */
/* --------------------------------------------------------------------- */

export function getQueue() {
  try { return foundry.utils.deepClone(game.settings.get(SCOPE, "ipQueue") || []); } catch { return []; }
}
async function setQueue(q) {
  try { await game.settings.set(SCOPE, "ipQueue", q); } catch (e) { console.warn("cp2020-augmented | IP queue write failed", e); }
}

function _isActiveGM() { return game.user.isGM && game.users.activeGM?.id === game.user.id; }

/** Re-render an open IP tracker (if any) after queue/pending changes. V2 apps live in
 *  foundry.applications.instances (a Map), not the legacy ui.windows registry. */
function _rerenderTracker() {
  const insts = foundry.applications?.instances;
  if (insts?.values) {
    for (const app of insts.values()) {
      if (app?.id === "cp-ip-tracker" || app?.options?.classes?.includes?.("cp-ip-tracker")) app.render(false);
    }
    return;
  }
  for (const app of Object.values(ui.windows ?? {})) {
    if (app?.options?.classes?.includes?.("cp-ip-tracker")) app.render(false);
  }
}

/* --------------------------------------------------------------------- */
/*  Neglect detector — nudge the GM when RAW IP is accruing un-worked     */
/* --------------------------------------------------------------------- */

/** The pending-queue length at which the RAW-IP neglect nudge fires (tunable). */
export const NEGLECT_THRESHOLD = 20;

/**
 * PURE: should the RAW-IP neglect nudge fire right now? True only when RAW auto-tracking is on, the
 * queue is at/over the threshold, the GM hasn't muted it, and a nudge hasn't already fired for this
 * over-threshold episode.
 */
export function shouldNudgeNeglect({ rawOn, queueLength, muted, nudged } = {}) {
  return !!rawOn && (Number(queueLength) || 0) >= NEGLECT_THRESHOLD && !muted && !nudged;
}

function _neglectFlag(key) { try { return game.settings.get(SCOPE, key) === true; } catch { return false; } }

/** Fire the once-per-episode GM neglect nudge when the queue crosses the threshold (active GM only). */
async function _maybeNudgeNeglect(queueLength) {
  if (!_isActiveGM() || !ipRawTracking()) return;
  if (!shouldNudgeNeglect({ rawOn: true, queueLength, muted: _neglectFlag("ipNeglectMuted"), nudged: _neglectFlag("ipNeglectNudged") })) return;
  try { await game.settings.set(SCOPE, "ipNeglectNudged", true); } catch (e) { /* ignore */ }
  try {
    const { showIpNeglectNudge } = await import("../dialog/ip-neglect.js");
    await showIpNeglectNudge(queueLength);
  } catch (e) { console.warn("cp2020-augmented | IP neglect nudge failed", e); }
}

/** Re-arm the nudge once the queue drops back below the threshold (so a future buildup re-nudges). */
async function _rearmNeglectIfBelow() {
  if (!_isActiveGM()) return;
  if (getQueue().length < NEGLECT_THRESHOLD && _neglectFlag("ipNeglectNudged")) {
    try { await game.settings.set(SCOPE, "ipNeglectNudged", false); } catch (e) { /* ignore */ }
  }
}

/** Empty the queue without awarding (the nudge's "Clear the backlog" off-ramp). */
export async function clearQueue() {
  await setQueue([]);
  await _rearmNeglectIfBelow();
  _rerenderTracker();
}

/**
 * Record a skill roll into the auto-queue. RAW mode only (Simple mode has no per-skill attribution).
 * Called from the cyberpunkSkillRolled hook; relays to the active GM if the roller isn't the GM.
 */
export function recordSkillRoll(payload) {
  if (!ipRawTracking()) return;
  if (_isActiveGM()) return _enqueue(payload);
  else if (game.users.activeGM) game.socket.emit("module.cp2020-augmented", { type: "ipSkillRolled", payload });
}

async function _enqueue(row) {
  const q = getQueue();
  q.push({
    id: foundry.utils.randomID(),
    actorId: row.actorId, skillId: row.skillId,
    actorName: row.actorName ?? "", skillName: row.skillName ?? "",
    total: Number(row.total) || 0, ip: 0, success: false, ts: Date.now()
  });
  await setQueue(q);
  _rerenderTracker();
  await _maybeNudgeNeglect(q.length);
}

/** Remove a queue row without awarding (skip). */
export async function dismissQueueRow(rowId) {
  await setQueue(getQueue().filter(r => r.id !== rowId));
  await _rearmNeglectIfBelow();
  _rerenderTracker();
}

/** Patch a queue row in place (e.g. the GM-entered IP amount or success tick). */
export async function updateQueueRow(rowId, patch) {
  const q = getQueue();
  const row = q.find(r => r.id === rowId);
  if (!row) return;
  Object.assign(row, patch);
  await setQueue(q);
}

/** Resolve every queued row (award each row's current IP/success), emptying the queue. */
export async function resolveAllQueue() {
  for (const row of getQueue()) await resolveQueueRow(row.id);
}

/* --------------------------------------------------------------------- */
/*  Throttle (per-skill awards within an Apply cycle)                     */
/* --------------------------------------------------------------------- */

function getThrottleCounts() {
  try { return foundry.utils.deepClone(game.settings.get(SCOPE, "ipThrottleCounts") || {}); } catch { return {}; }
}
async function setThrottleCounts(c) {
  try { await game.settings.set(SCOPE, "ipThrottleCounts", c); } catch (e) { console.warn(e); }
}
export async function resetThrottle() {
  await setThrottleCounts({});
}

/** Apply the throttle to a proposed award for a skill, updating the per-cycle counter. */
async function _throttleAward(skillId, amount) {
  const mode = ipThrottle();
  if (mode === "off" || amount <= 0) return amount;
  const counts = getThrottleCounts();
  const n = Number(counts[skillId]) || 0;
  let award;
  if (mode === "hardcap") {
    award = n >= 1 ? 0 : amount;
  } else { // diminishing: halve per prior award this cycle, floor 1
    award = Math.max(1, Math.floor(amount / Math.pow(2, n)));
  }
  counts[skillId] = n + 1;
  await setThrottleCounts(counts);
  return award;
}

/* --------------------------------------------------------------------- */
/*  Awarding pending IP                                                   */
/* --------------------------------------------------------------------- */

/**
 * Add pending IP to a skill (GM action). Honors the throttle. Used by the tracker (per row) and the
 * manual add. `amount` is the raw figure the GM entered (or the auto-baseline amount).
 */
export async function awardPending(actor, skill, amount) {
  if (!actor || !skill) return false;
  const award = await _throttleAward(skill.id, Math.max(0, Math.floor(Number(amount) || 0)));
  if (award <= 0) return false;
  await skill.setFlag(SCOPE, "ipPending", skillPending(skill) + award);
  return true;
}

/**
 * Resolve one queue row: award its IP (RAW = the typed amount; auto-baseline = baseline on success
 * plus any typed bonus) to the rolled skill's pending, then drop the row.
 */
export async function resolveQueueRow(rowId) {
  const q = getQueue();
  const row = q.find(r => r.id === rowId);
  if (!row) return;
  const actor = game.actors.get(row.actorId);
  const skill = actor?.items.get(row.skillId);
  if (skill) {
    let amount = Number(row.ip) || 0;
    if (ipAwardModel() === "autoBaseline" && row.success) amount += ipAutoBaselineAmount();
    if (amount > 0) await awardPending(actor, skill, amount);
  }
  await setQueue(q.filter(r => r.id !== rowId));
  await _rearmNeglectIfBelow();
  _rerenderTracker();
}

/* --------------------------------------------------------------------- */
/*  Apply (release pending → banked) + reset                              */
/* --------------------------------------------------------------------- */

/**
 * Release all pending IP to banked across every party actor (or one actor if given): for each
 * skill, ip += ipPending, ipPending = 0. Clears the queue + throttle counters (new cycle).
 */
export async function applyPending(actor = null) {
  const actors = actor ? [actor] : game.actors.filter(a => a.type === "character" || a.type === "npc");
  let released = 0;
  for (const a of actors) {
    const updates = [];
    for (const skill of a.items) {
      if (skill.type !== "skill") continue;
      const pending = skillPending(skill);
      if (pending <= 0) continue;
      updates.push({
        _id: skill.id,
        [`flags.${SCOPE}.ip`]: skillIp(skill) + pending,
        [`flags.${SCOPE}.ipPending`]: 0,
      });
      released += pending;
    }
    if (updates.length) await a.updateEmbeddedDocuments("Item", updates);
  }
  // Clear the queue + throttle for the new cycle.
  await setQueue(actor ? getQueue().filter(r => r.actorId !== actor.id) : []);
  await resetThrottle();
  await _rearmNeglectIfBelow();
  _rerenderTracker();
  ui.notifications?.info(localize("IpApplied", { ip: released }));
  return released;
}

/* --------------------------------------------------------------------- */
/*  Level-up (player self-service, confirm dialog)                        */
/* --------------------------------------------------------------------- */

/**
 * Raise a skill one level, spending the skill's own bank first then the fungible pool (dual-bucket).
 * Shows a confirm dialog. The skill `level` is Tilt's own field and stays on system.*; the IP banks are
 * module flags. Honors the skill lock only for raw hand-editing — leveling via this button is allowed.
 */
export async function levelUpSkill(actor, skill, { confirm = true } = {}) {
  if (!actor || !skill || skill.type !== "skill") return false;
  if (!ipEnabled()) return false;
  const cost = ipCost(skill);
  const bank = skillIp(skill);
  const pool = actorPool(actor);
  const spend = ipSpendBreakdown(bank, pool, cost);   // dual-bucket: bank first, then pool
  if (!spend.affordable) { ui.notifications?.warn(localize("IpNotEnough", { cost, have: bank + pool })); return false; }

  if (confirm) {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: localize("IpLevelUpTitle", { skill: skill.name }) },
      content: `<p>${localize("IpLevelUpBody", { skill: skill.name, from: Number(skill.system?.level) || 0, to: (Number(skill.system?.level) || 0) + 1, cost })}</p>`,
      yes: { callback: () => true },
      no:  { default: true, callback: () => false },
    });
    if (!ok) return false;
  }

  const newLevel = (Number(skill.system?.level) || 0) + 1;
  const skillUpdate = { "system.level": newLevel };
  if (spend.fromBank > 0) skillUpdate[`flags.${SCOPE}.ip`] = spend.newBank;
  await skill.update(skillUpdate);
  if (spend.fromPool > 0) await actor.setFlag(SCOPE, "ipPool", spend.newPool);
  await postSavePromptCard({
    body: localize("IpLeveledUp", { actor: actor.name, skill: skill.name, level: newLevel, cost }),
    speaker: ChatMessage.getSpeaker({ actor }),
  });
  return true;
}

/** Add IP to the Simple-mode pool (GM). */
export async function addToPool(actor, amount) {
  if (!actor) return false;
  await actor.setFlag(SCOPE, "ipPool", Math.max(0, actorPool(actor) + Math.floor(Number(amount) || 0)));
  return true;
}

/** Per-skill pending IP (used by the tracker summary). */
export function pendingForSkill(skill) { return skillPending(skill); }

/* --------------------------------------------------------------------- */
/*  Hook + socket registration                                            */
/* --------------------------------------------------------------------- */

export function registerIpHooks() {
  // Local skill-roll hook → auto-queue (RAW mode). The system's rollSkill fires this on the roller's
  // client (a seam — vanilla systems that don't emit it simply get no auto-queue; manual award works).
  Hooks.on("cyberpunkSkillRolled", (payload) => {
    try { recordSkillRoll(payload); } catch (e) { console.warn("cp2020-augmented | IP queue failed", e); }
  });

  // GM-side: receive relayed rolls from players and enqueue them.
  game.socket.on("module.cp2020-augmented", async (data) => {
    if (data?.type !== "ipSkillRolled") return;
    if (!_isActiveGM()) return;
    try { await _enqueue(data.payload); } catch (e) { console.warn("cp2020-augmented | IP relay enqueue failed", e); }
  });
}
