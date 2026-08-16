/**
 * DamageDialog.js  —  module/combat/DamageDialog.js
 *
 * Preview shows: Roll − SP = after-SP damage (editable by GM)
 * On Apply:      after-SP − BTM = final HP damage (min 1 if penetrated)
 *
 * BTM is intentionally excluded from the preview rows. It represents the
 * character's personal toughness applied at receive-time — not a property
 * of the attack. Showing it per-row would conflate armor and body toughness.
 * BTM is displayed as a summary line below the hit list instead.
 *
 * Cover SP: GM enters the obstacle SP; combined with armor as the outermost
 * layer via the proportional table (CP2020 p.99).
 */

import { ARMOR_MODES, resolveAreaDamagesSync, applyBTM, computeNetDamage, ablateLocationOnce, applyLocationDamage } from "./DamageApplicator.js";
// One apply = one application: the rows share a severity ledger, which emits one progression card and
// one mortal prompt at the final tier (combat/severity-batch.js).
import { makeSeverityBatch, closeSeverityBatch, severityBatchHandledMortal } from "./severity-batch.js";
import { postStunSavePrompt, postDeathSavePrompt, updateTaserState, applyAcidDotState, applyDotFromPayload } from "./save-rolls.js";
import { routesToSdp, cyberlimbSdp } from "../mech/cyberlimb.js";
import { requestCoverChew, coverBetween, coverChewSummary } from "./cover.js";
import { localize, localizeParam } from "../utils.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Announced (locally, on the client holding the window) when an apply window closes WITHOUT the damage
 * having been applied — the X, the Cancel button, Escape, or any other close that is not the one Apply
 * performs. Carries the payload the window was opened with, and the resolved target.
 *
 * The window deliberately does not know what should happen next: it reports its own dismissal, and the
 * hooks layer decides (damage-hooks.js puts the apply button back on the shot's chat card). Same shape as
 * the other module-local announcements, e.g. SUPPRESSIVE_ZONE_ENTERED_HOOK.
 */
export const DAMAGE_DIALOG_DISMISSED_HOOK = "cp2020-augmented.damageDialogDismissed";

export class DamageDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  constructor(payload, target, options = {}) {
    super(options);
    this.payload    = payload;
    this.target     = target;
    // Applied-close vs dismissed-close. Apply is the ONE close that resolves the shot, and it sets this
    // immediately before asking the window to close; every other route out (X, Cancel, Escape, a close
    // the framework performs) leaves it false and is therefore a dismissal. Read once, in _preClose,
    // which is the single teardown all of those routes pass through.
    this._damageApplied      = false;
    this._dismissalAnnounced = false;
    this._overrides = {};   // { flatIndex: after-SP override }
    this._armorMode = null;
    this._damageType = null;   // "" / null = a normal hit; "fire" | "radiation" | "heat"
    this._ablate    = null;
    this._coverSP   = 0;
    // WHICH cover object the shot went through. There is no picker control any more: the window
    // shows a typed Cover SP field and nothing else, and the object is identified by the segment
    // auto-detect below. The uuid is internal state, kept because it is the ONLY attribution path
    // left — without it a chewed pool could not be charged to a document. "" = no object known
    // (a hand-typed Cover SP still folds into the math, it just has nothing to debit).
    this._coverZoneUuid = "";
    this._coverRow      = null;   // the detected row snapshot: label / displayLabel / sp / pool / poolMax
    // The segment auto-detect is a ONE-SHOT seed on the first context build — this latch is what
    // keeps a later re-render from re-picking over a value the GM typed.
    this._autoCoverTried = false;
  }

  static DEFAULT_OPTIONS = {
    classes:   ["cyberpunk", "dialog", "damage-dialog"],
    tag:       "form",
    window:    { title: "CYBERPUNK.ApplyDamageTitle" },
    position:  { width: 500, height: "auto" },
    resizable: true,
    actions: {
      applyDamage:  DamageDialog._onApply,
      cancelDialog: DamageDialog._onCancel,
    },
    form: {
      // No meaningful submit — the Apply button is handled via action.
      handler:        DamageDialog._formHandler,
      submitOnChange: false,
      closeOnSubmit:  false,
    },
  };

  static PARTS = {
    main: { template: "modules/cp2020-augmented/templates/dialog/damage-dialog.hbs" },
  };

  /** The target's token document (payload token first, else the actor's active token). */
  _targetTokenDoc() {
    const tid = this.payload?.targetTokenId;
    const fromId = tid ? canvas?.scene?.tokens?.get(tid) : null;
    return fromId ?? this.target?.getActiveTokens?.(true, true)?.[0] ?? null;
  }

  /** The attacker's token document (payload token first, else the shooter actor's placeable). */
  _attackerTokenDoc() {
    const tid = this.payload?.attackerTokenId;
    const fromId = tid ? canvas?.scene?.tokens?.get(tid) : null;
    if (fromId) return fromId;
    const aid = this.payload?.attackerId ?? this.payload?.actorId;
    if (!aid) return null;
    return canvas?.tokens?.placeables?.find(t => t.actor?.id === aid)?.document ?? null;
  }

  async _prepareContext(_options) {
    const armorMode = this._armorMode ?? game.settings.get("cp2020-augmented", "damageArmorMode");
    const ablate    = this._ablate    ?? game.settings.get("cp2020-augmented", "damageAblation");

    // Segment auto-detect: FIRST context build only, and it never overrides a value already set —
    // it is purely a starting value, the Cover SP input stays editable. Seeding _coverSP here
    // (before resolveAreaDamagesSync reads it below) means the preview folds the cover on the very
    // first render. There is no world setting in front of this: placing a cover object on the map
    // IS the opt-in, and the segment test returns nothing on a scene that carries none, so a table
    // that never places cover never sees it. It needs an attacker token, so it reaches only shots
    // that came from a fire card — a hand-opened Apply Damage window has no line to test.
    if (!this._autoCoverTried && !this._coverZoneUuid) {
      this._autoCoverTried = true;
      try {
        const picked = coverBetween(this._attackerTokenDoc(), this._targetTokenDoc())[0];
        if (picked) {
          this._coverZoneUuid = picked.uuid;
          // TWO NAMES, ON PURPOSE. `label` is the object's own clean name and is what the wear
          // receipt is written against; `displayLabel` is what this window calls the row, and it
          // carries the per-attack verdict when the row was decided by a roll (an open-topped
          // vehicle covers its riders only part of the time). Folding the verdict into the one name
          // would put it on the wear card too — "Riot 8 — covered this attack (75%) absorbed 12
          // damage" — which is a statement about one attack pasted onto a fact about the vehicle.
          this._coverRow = {
            uuid: picked.uuid, label: picked.label, displayLabel: picked.displayLabel || picked.label,
            sp: picked.sp, pool: picked.pool, poolMax: picked.poolMax, destroyed: picked.destroyed,
          };
          this._coverSP = Math.max(0, Number(picked.sp) || 0);
        }
      } catch (e) { /* auto-pick is best-effort; a typed Cover SP is the fallback */ }
    }
    // Read AFTER the auto-pick so a seeded value reaches both the preview math and the input.
    const coverSP = this._coverSP;

    const rawHits = resolveAreaDamagesSync({
      target:      this.target,
      areaDamages: this.payload.areaDamages,
      ap:            Boolean(this.payload.ap),
      edged:         Boolean(this.payload.edged),
      mono:          Boolean(this.payload.mono),
      armorMultSoft: Number(this.payload.armorMultSoft ?? 1.0),
      armorMultHard: Number(this.payload.armorMultHard ?? 1.0),
      penDamageMult: Number(this.payload.penDamageMult ?? 1.0),
      armorMode,
      ablate,
      coverSP,
      cover: this._coverRow,
      damageType: this._damageType ?? "",
    });

    const btm = Number(this.target.system.stats?.bt?.modifier) || 0;

    const resolvedHits = rawHits.map((hit, i) => {
      const afterSP = this._overrides[i] !== undefined ? this._overrides[i] : hit.damageAfterSP;
      // A machine-zone (SDP) row exposes its zone's remaining/max pool for the tag tooltip. This is a
      // pure synchronous lookup — cyberlimbSdp reads the same sdp.sum/current pool the seam reduces,
      // and it already covers a full borg's Head/Torso zones as well as ordinary cyberlimbs.
      const pool = hit.sdp ? cyberlimbSdp(this.target, hit.location) : null;
      return {
        ...hit,
        afterSP,
        overridden:   this._overrides[i] !== undefined,
        btm,   // per-row so the flesh after-SP tooltip needs no fragile parent-path lookup
        sdpRemaining: pool ? pool.current : null,
        sdpMax:       pool ? pool.max : null,
        breakdownRows: this._breakdownRows(hit, btm, afterSP, this._overrides[i] !== undefined),
      };
    });

    // Two honest summaries, each mirroring EXACTLY what Apply does to its row (applyLocationDamage):
    //  - flesh rows → computeNetDamage (BTM subtraction, min-1 floor, head/limb doubling)
    //  - SDP rows   → the structural value a machine zone absorbs: penetrating afterSP, rounded, NO BTM
    const totalNet = resolvedHits.reduce(
      (s, h) => s + (h.sdp ? 0 : computeNetDamage(h.afterSP, btm, h.penetrates, h.location)), 0
    );
    const totalSdp = resolvedHits.reduce(
      (s, h) => s + (h.sdp && h.penetrates ? Math.max(0, Math.round(h.afterSP)) : 0), 0
    );
    const hasSdpRows = resolvedHits.some(h => h.sdp);

    return {
      weaponName:   this.payload.weaponName,
      targetName:   this.target.name,
      resolvedHits,
      totalNet,
      totalSdp,
      hasSdpRows,
      btm,
      armorMode,
      ablate,
      armorModes:   Object.values(ARMOR_MODES),
      damageType:   this._damageType ?? "",
      ap:           Boolean(this.payload.ap),
      coverSP,
      // The picked row's own name, shown beside the Cover SP field. It is the row's statement of what
      // it is — and, when the row was decided by a roll, of which way that roll went. An EXPOSED row
      // carries no SP at all, so it produces no line in the breakdown; this is where it speaks.
      coverRowLabel: this._coverRow?.displayLabel ?? "",
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    if (!root) return;

    root.querySelector("select[name='armorMode']")?.addEventListener("change", ev => {
      this._armorMode = ev.currentTarget.value;
      this._overrides = {};
      this.render(false);
    });

    root.querySelector("select[name='damageType']")?.addEventListener("change", ev => {
      this._damageType = ev.currentTarget.value;
      this._overrides = {};
      this.render(false);
    });

    root.querySelector("input[name='coverSP']")?.addEventListener("change", ev => {
      const v = Number(ev.currentTarget.value);
      this._coverSP   = (Number.isFinite(v) && v >= 0) ? v : 0;
      this._overrides = {};
      this.render(false);
    });

    root.querySelector("input[name='ablate']")?.addEventListener("change", ev => {
      this._ablate = ev.currentTarget.checked;
    });

    // Override stores the after-SP value; BTM applied on Apply
    root.querySelectorAll("input.after-sp-override").forEach(el => {
      el.addEventListener("change", ev => {
        const idx = Number(ev.currentTarget.dataset.hitIndex);
        const val = Number(ev.currentTarget.value);
        if (Number.isFinite(val) && val >= 0) {
          this._overrides[idx] = val;
        } else {
          delete this._overrides[idx];
        }
        this._updateTotalDisplay();
      });
    });
  }

  /**
   * Turn one hit's structural breakdown (DamageApplicator) into the labelled label/value pairs the
   * expandable math line renders. This is the render edge, so ALL the chrome is localized here and
   * the resolver stays i18n-free. Every component is named: armor pieces by the item's own name,
   * the cover object by its label, the borg chassis by a localized stand-in — the whole point of
   * the line is that the SP column stops being one opaque number and says what made it.
   *
   * The order IS the arithmetic, top to bottom: roll → each armor layer → the layering bonus the
   * proportional table grants → any armor multiplier → combined armor → cover → effective SP → the
   * AP halving → the subtraction → the penetrating multiplier → a GM override if there was one →
   * BTM → final. Steps that did not happen emit no row, so an unarmoured hit with no cover shows
   * three lines rather than twelve.
   */
  _breakdownRows(hit, btm, afterSP, overridden) {
    const b = hit?.breakdown;
    if (!b) return [];
    const rows = [];
    const add = (label, value, kind = "") => rows.push({ label, value, drain: kind === "drain" });
    const spTag = (n) => `[${n}]`;

    add(localize("DamageDlgBdRoll"), String(b.raw));
    for (const layer of b.layers) add(layer.chassis ? localize("DamageDlgBdChassis") : layer.name, spTag(layer.sp));
    if (b.layers.length > 1) add(localize("DamageDlgBdLayerBonus"), `+${b.layerBonus}`);
    if (b.armorMult !== 1) add(localize("DamageDlgBdArmorMult"), `×${b.armorMult}`);
    if (b.layers.length) add(localize("DamageDlgBdArmorSp"), String(b.armorSP));
    if (b.coverSP > 0) add(b.coverName || localize("DamageDlgBdCover"), spTag(b.coverSP));
    if (b.coverSP > 0 && b.armorSP > 0) add(localize("DamageDlgBdEffectiveSp"), String(b.effectiveSP));
    if (b.apHalved) add(localize("DamageDlgBdApHalf"), String(b.spUsed));
    add(localize("DamageDlgBdAfterSp"), b.penetrates ? String(b.afterSPRaw) : localize("DamageDlgBdStopped"));
    if (b.penetrates && b.penMult !== 1) add(localizeParam("DamageDlgBdPenMult", { mult: b.penMult }), String(b.afterSP));
    if (overridden) add(localize("DamageDlgBdOverride"), String(afterSP));

    if (hit.sdp) {
      // A machine zone takes the structural value with no BTM and no doubling — mirror what Apply
      // writes rather than showing a toughness subtraction that never happens there.
      add(localize("DamageDlgBdStructural"), String(hit.penetrates ? Math.max(0, Math.round(afterSP)) : 0));
    } else {
      // Toughness only enters the arithmetic when something got through — a stopped hit goes
      // straight to a final of nothing, and printing a subtraction that never ran would read as
      // if BTM were what stopped it.
      if (hit.penetrates) add(localize("DamageDlgBdBtm"), `−${btm}`);
      add(localize("DamageDlgBdFinal"), String(computeNetDamage(afterSP, btm, hit.penetrates, hit.location)));
    }

    // What this round cost the object it was shot through — the receipt the applicator's ledger
    // wrote for this exact round, so the reader sees the pool fall bullet by bullet.
    const chew = hit.coverChew;
    if (chew) {
      add(chew.label, chew.destroyed
        ? localizeParam("DamageDlgBdDrainDestroyed", { damage: chew.absorbed })
        : localizeParam("DamageDlgBdDrain", { damage: chew.absorbed, pool: chew.poolAfter, poolMax: chew.poolMax }),
        "drain");
    }
    return rows;
  }

  _updateTotalDisplay() {
    const root = this.element;
    if (!root) return;
    const armorMode = this._armorMode ?? game.settings.get("cp2020-augmented", "damageArmorMode");
    const ablate    = this._ablate    ?? game.settings.get("cp2020-augmented", "damageAblation");
    const btm = Number(this.target.system.stats?.bt?.modifier) || 0;
    const base = resolveAreaDamagesSync({
      target:      this.target,
      areaDamages: this.payload.areaDamages,
      ap:            Boolean(this.payload.ap),
      edged:         Boolean(this.payload.edged),
      mono:          Boolean(this.payload.mono),
      armorMultSoft: Number(this.payload.armorMultSoft ?? 1.0),
      armorMultHard: Number(this.payload.armorMultHard ?? 1.0),
      penDamageMult: Number(this.payload.penDamageMult ?? 1.0),
      armorMode,
      ablate,
      coverSP:     this._coverSP,
      cover:       this._coverRow,
      damageType: this._damageType ?? "",
    });
    // Keep the two displayed totals in exact parity with _prepareContext: flesh HP (BTM math) on
    // non-SDP rows, structural SDP (penetrating afterSP, rounded, no BTM) on machine-zone rows.
    let fleshTotal = 0;
    let sdpTotal   = 0;
    base.forEach((hit, i) => {
      const afterSP = this._overrides[i] !== undefined ? this._overrides[i] : hit.damageAfterSP;
      if (hit.sdp) {
        sdpTotal += hit.penetrates ? Math.max(0, Math.round(afterSP)) : 0;
      } else {
        fleshTotal += computeNetDamage(afterSP, btm, hit.penetrates, hit.location);
      }
    });
    const el = root.querySelector(".damage-total-value");
    if (el) el.textContent = String(fleshTotal);
    // The SDP total line only renders when the volley has machine-zone rows (hasSdpRows) — guard it.
    const sdpEl = root.querySelector(".damage-sdp-total-value");
    if (sdpEl) sdpEl.textContent = String(sdpTotal);
  }

  /**
   * Record the burst's wear on the cover object it was shot through.
   *
   * The per-round bookkeeping already happened inside the resolver (cover.js makeCoverLedger), so
   * this reads the receipts off the resolved rows rather than re-deriving anything: ONE document
   * write for the whole burst, carrying the round-by-round detail the summary card reports. That
   * split is deliberate — the MATH degrades per round so a broken object stops protecting the
   * rounds behind it, while the WRITE happens once so a six-round burst is one debit and one card.
   * requestCoverChew self-routes: the active GM writes directly, everyone else relays. No-op when
   * the shot went through no object (a hand-typed Cover SP has nothing to charge).
   */
  _chewCoverForBurst(resolvedRows) {
    const summary = coverChewSummary(resolvedRows);
    if (!summary || summary.absorbed <= 0) return;
    requestCoverChew({
      behaviorUuid: summary.uuid,
      // The row's label can name the PART that was crossed (a vehicle's engine block), so it rides
      // along rather than being re-derived from the document on the GM's side.
      label: summary.label,
      damage: summary.absorbed,
      weaponName: String(this.payload?.weaponName || ""),
      rounds: summary.rounds,
      destroyedAtRound: summary.destroyedAtRound,
    });
  }

  static async _onApply(event, target) {
    event.preventDefault();

    const armorMode = this._armorMode ?? game.settings.get("cp2020-augmented", "damageArmorMode");
    const coverSP   = this._coverSP;
    const btm       = Number(this.target.system.stats?.bt?.modifier) || 0;

    const ablateEl = this.element?.querySelector("input[name='ablate']");
    const ablate   = ablateEl ? ablateEl.checked
                              : (this._ablate ?? game.settings.get("cp2020-augmented", "damageAblation"));

    const rawHits = resolveAreaDamagesSync({
      target:      this.target,
      areaDamages: this.payload.areaDamages,
      ap:            Boolean(this.payload.ap),
      edged:         Boolean(this.payload.edged),
      mono:          Boolean(this.payload.mono),
      armorMultSoft: Number(this.payload.armorMultSoft ?? 1.0),
      armorMultHard: Number(this.payload.armorMultHard ?? 1.0),
      penDamageMult: Number(this.payload.penDamageMult ?? 1.0),
      armorMode,
      ablate,
      coverSP,
      cover: this._coverRow,
      damageType: this._damageType ?? "",
    });

    // Pre-compute all per-hit final values (shared between socket relay and direct paths).
    // computeNetDamage centralizes head doubling (p.103) + the optional Listen Up limb model,
    // so the player-side resolved values match the GM-side and area paths exactly.
    const resolvedHits = rawHits.map((hit, i) => {
      const afterSP   = this._overrides[i] !== undefined ? this._overrides[i] : hit.damageAfterSP;
      const btmResult = applyBTM(afterSP, btm, hit.penetrates);
      const netDamage = computeNetDamage(afterSP, btm, hit.penetrates, hit.location);
      return { location: hit.location, afterSP, penetrates: hit.penetrates, btmResult, netDamage };
    });
    const totalApplied = resolvedHits.reduce((s, h) => s + h.netDamage, 0);

    if (!game.user.isGM) {
      // Route through GM socket relay — player cannot write to unowned actor documents
      game.socket.emit("module.cp2020-augmented", {
        type:             "applyDamage",
        mode:             "resolved",
        requesterId:      game.user.id,
        targetActorId:    this.target.id,
        // Unambiguous refs (the module's standard relay shape): a synthetic actor's id collides with its world
        // actor's — the uuid + scene-qualified token keep the GM-side write on the token that was hit.
        targetActorUuid:  this.target.uuid ?? null,
        targetTokenId:    this.payload?.targetTokenId ?? null,
        targetSceneId:    (this.payload?.targetTokenId ? canvas?.tokens?.get(this.payload.targetTokenId)?.document?.parent?.id : null) ?? canvas?.scene?.id ?? null,
        resolvedHits,
        totalApplied,
        ablate,
        armorMode,
        damageType:       this._damageType ?? "",
        stunSaveOnHit:    Boolean(this.payload.stunSaveOnHit),
        stunSaveMod:      Number(this.payload.stunSaveMod     ?? 0),
        dotEnabled:       Boolean(this.payload.dotEnabled),
        dotTurns:         Number(this.payload.dotTurns        ?? 0),
        dotDamageFormula: String(this.payload.dotDamageFormula || "1d6"),
        dotType:          String(this.payload.dotType         || "acid"),
        weaponName:       String(this.payload.weaponName      || ""),
        firstHitLocation: rawHits[0]?.location ?? null,
      });
      this._chewCoverForBurst(rawHits);
      this._damageApplied = true;   // an applied close — see the flag's note in the constructor
      this.close();
      return;
    }

    // GM direct path — route each hit through the shared seam (cyberlimb zones absorb into their SDP,
    // flesh advances the wound track + runs the limb/head severity check). `applied` counts only the
    // flesh HP written, so the notification isn't inflated by damage a cyberlimb soaked.
    // Resolve the actual target token (the shot's payload carries its id) so a destroyed borg core and
    // the post-hit prompts use the RIGHT token, not the first canvas token of a multi-token actor.
    const token = this.payload?.targetTokenId ? (canvas?.tokens?.get(this.payload.targetTokenId) ?? null)
                : (canvas?.tokens?.placeables?.find(t => t.actor === this.target) ?? null);
    let applied = 0;
    // ⭐ THE WINDOW'S ROWS ARE ONE APPLICATION. Every row this Apply writes is one moment of the fight,
    // so they share a severity ledger and produce ONE progression card and ONE mortal prompt between
    // them, at the tier the whole apply finished on (combat/severity-batch.js). It owns the wound-track
    // prompt because the tail at the end of this method is this window's own.
    const severity = makeSeverityBatch({ ownsWoundTrackPrompt: true });
    for (const hit of resolvedHits) {
      const outcome = await applyLocationDamage({ target: this.target, location: hit.location, netDamage: hit.netDamage, structuralDamage: hit.afterSP, penetrates: hit.penetrates, token, severityBatch: severity });
      applied += outcome.applied;

      // Ablation gates on the bullet penetrating, not on the doubled HP value.
      if (ablate && armorMode === ARMOR_MODES.FULL && hit.btmResult > 0) {
        await ablateLocationOnce(this.target, hit.location, this._damageType);
      }
    }
    await closeSeverityBatch(severity);

    await this.target.sheet?.render(false);
    this._chewCoverForBurst(rawHits);
    ui.notifications.info(localizeParam("DamageApplied", { amount: applied, name: this.target.name }));

    // Taser flag must be updated BEFORE the save prompt — threshold calculation reads it. Cyberlimb-
    // routed hits carry no shock/stun (RAW), so they don't accumulate the cumulative-save penalty
    // (mirrors the relay-compute branch's `!routesToSdp` gate).
    if (this.payload.stunSaveOnHit && resolvedHits.some(h => h.penetrates && !routesToSdp(this.target, h.location))) {
      const taserEnabled = (() => { try { return game.settings.get("cp2020-augmented", "taserCumPenaltyEnabled"); } catch { return true; } })();
      if (taserEnabled) await updateTaserState(this.target, this.payload);
    }

    // DOT routes by dotType (fire -> HP burn, acid -> armor degradation); see save-rolls.js.
    await applyDotFromPayload(this.target, rawHits[0]?.location ?? null, this.payload, resolvedHits.some(h => h.penetrates));

    // Gate the stun/death prompt on FLESH HP actually written — a hit fully soaked by a cyberlimb's
    // SDP raises no consciousness check (H7: was `totalApplied`, which counted cyberlimb-soaked damage).
    if (applied > 0) {
      await _postSavePrompts(this.target, token, severity);
    }

    this._damageApplied = true;   // an applied close — see the flag's note in the constructor
    this.close();
  }

  static _onCancel(event, target) {
    this.close();
  }

  /**
   * The single teardown every close route passes through — the Apply action's own close, the Cancel
   * button, the window's X, Escape, and any close the framework performs. So it is the one honest place
   * to tell an applied close apart from a dismissed one, and the announcement is made here rather than
   * from each button.
   *
   * WHY the announcement exists at all: this window took over the routing for a shot that had a target
   * (PATH A in damage-hooks.js), and that path deliberately does NOT flag the shot's chat card — one
   * path, not both. Dismissing the window used to throw the whole affordance away, so a shot that was
   * not followed through on could not be applied at all afterwards. Announcing the dismissal lets the
   * hooks layer hand the shot back to its own card, which is where the button lived before.
   *
   * Announce-once guard in the same spirit as the sheet-listener bind-once guards: the announcement is
   * an event with a side effect at the other end, so it must not be repeatable by a second teardown pass.
   */
  async _preClose(options) {
    await super._preClose?.(options);
    if (this._dismissalAnnounced) return;
    this._dismissalAnnounced = true;
    if (this._damageApplied) return;
    Hooks.callAll(DAMAGE_DIALOG_DISMISSED_HOOK, this.payload, this.target);
  }

  /** Satisfy the V2 form contract — real work is in the applyDamage action. */
  static async _formHandler(event, form, formData) {}
}

async function _postSavePrompts(actor, token = null, severityBatch = null) {
  const woundState = actor.woundState?.() ?? 0;
  if (woundState === 0) return;
  const tok = token ?? canvas?.tokens?.placeables?.find(t => t.actor?.id === actor.id) ?? null;
  if (woundState >= 4) {
    // The mortal half is the application's ledger's when there is one — offered once, at the tier the
    // apply finished on. Without a ledger this is exactly what it always was.
    if (!severityBatchHandledMortal(severityBatch, actor, tok)) await postDeathSavePrompt(actor, tok);
  } else {
    await postStunSavePrompt(actor, tok);
  }
}
