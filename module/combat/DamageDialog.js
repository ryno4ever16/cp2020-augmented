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
import { postStunSavePrompt, postDeathSavePrompt, updateTaserState, applyAcidDotState, applyDotFromPayload } from "./save-rolls.js";
import { routesToSdp } from "../mech/cyberlimb.js";
import { localizeParam } from "../utils.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class DamageDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  constructor(payload, target, options = {}) {
    super(options);
    this.payload    = payload;
    this.target     = target;
    this._overrides = {};   // { flatIndex: after-SP override }
    this._armorMode = null;
    this._damageType = null;   // "" / null = a normal hit; "fire" | "radiation" | "heat"
    this._ablate    = null;
    this._coverSP   = 0;
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

  async _prepareContext(_options) {
    const armorMode = this._armorMode ?? game.settings.get("cp2020-augmented", "damageArmorMode");
    const ablate    = this._ablate    ?? game.settings.get("cp2020-augmented", "damageAblation");
    const coverSP   = this._coverSP;

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
      damageType: this._damageType ?? "",
    });

    const btm = Number(this.target.system.stats?.bt?.modifier) || 0;

    const resolvedHits = rawHits.map((hit, i) => ({
      ...hit,
      afterSP:    this._overrides[i] !== undefined ? this._overrides[i] : hit.damageAfterSP,
      overridden: this._overrides[i] !== undefined,
    }));

    const totalNet = resolvedHits.reduce(
      (s, h) => s + computeNetDamage(h.afterSP, btm, h.penetrates, h.location), 0
    );

    return {
      weaponName:   this.payload.weaponName,
      targetName:   this.target.name,
      resolvedHits,
      totalNet,
      btm,
      armorMode,
      ablate,
      armorModes:   Object.values(ARMOR_MODES),
      damageType:   this._damageType ?? "",
      ap:           Boolean(this.payload.ap),
      coverSP,
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
      damageType: this._damageType ?? "",
    });
    let total = 0;
    base.forEach((hit, i) => {
      const afterSP = this._overrides[i] !== undefined ? this._overrides[i] : hit.damageAfterSP;
      total += computeNetDamage(afterSP, btm, hit.penetrates, hit.location);
    });
    const el = root.querySelector(".damage-total-value");
    if (el) el.textContent = String(total);
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
      damageType: this._damageType ?? "",
    });

    // Pre-compute all per-hit final values (shared between socket relay and direct paths).
    // computeNetDamage centralizes head doubling (p.103) + the optional Listen Up limb model,
    // so the player-side resolved values match the GM/auto-apply paths exactly.
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
        targetTokenId:    this.payload?.targetTokenId ?? null,
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
      this.close();
      return;
    }

    // GM direct path — route each hit through the shared seam (cyberlimb zones absorb into their SDP,
    // flesh advances the wound track + runs the limb/head severity check). `applied` counts only the
    // flesh HP written, so the notification isn't inflated by damage a cyberlimb soaked.
    // Resolve the actual target token (the shot's payload carries its id) so a destroyed borg core and
    // the post-hit prompts use the RIGHT token, not the first canvas token of a multi-token actor.
    const token = this.payload?.targetTokenId ? (canvas?.tokens?.get(this.payload.targetTokenId) ?? null)
                : (canvas?.tokens?.placeables?.find(t => t.actor?.id === this.target.id) ?? null);
    let applied = 0;
    for (const hit of resolvedHits) {
      const outcome = await applyLocationDamage({ target: this.target, location: hit.location, netDamage: hit.netDamage, structuralDamage: hit.afterSP, penetrates: hit.penetrates, token });
      applied += outcome.applied;

      // Ablation gates on the bullet penetrating, not on the doubled HP value.
      if (ablate && armorMode === ARMOR_MODES.FULL && hit.btmResult > 0) {
        await ablateLocationOnce(this.target, hit.location, this._damageType);
      }
    }

    await this.target.sheet?.render(false);
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
      await _postSavePrompts(this.target, token);
    }

    this.close();
  }

  static _onCancel(event, target) {
    this.close();
  }

  /** Satisfy the V2 form contract — real work is in the applyDamage action. */
  static async _formHandler(event, form, formData) {}
}

async function _postSavePrompts(actor, token = null) {
  const woundState = actor.woundState?.() ?? 0;
  if (woundState === 0) return;
  const tok = token ?? canvas?.tokens?.placeables?.find(t => t.actor?.id === actor.id) ?? null;
  if (woundState >= 4) {
    await postDeathSavePrompt(actor, tok);
  } else {
    await postStunSavePrompt(actor, tok);
  }
}
