/**
 * Seam shim — a TEMPORARY, self-disengaging compatibility patch.
 *
 * The Augmented module reacts to three base-system events: `cyberpunk2020.weaponFired` (drives the damage
 * automation), `cyberpunk2020.suppressiveFire` (draws the fire zone + posts evasion prompts), and
 * `cyberpunkSkillRolled` (drives the IP tracker). Those hook emissions are proposed to
 * the base system as PRs; until they land, the base system does not emit them, so the module's
 * automation is inert on a stock install. This shim monkey-patches the base roll methods to emit the
 * hooks ITSELF — but only for as long as the base system lacks them.
 *
 * ⛔ SELF-DISENGAGING (this is the whole contract): before patching anything, we read the target
 * method's OWN source. If it already emits the hook — because the PR was merged, OR because we are
 * running on the fork that carries the seam — we DO NOT patch it. So the instant the base system gains
 * native emission, this shim goes completely dormant: no version checks, no settings, no double-emit.
 * On a fork+module install it is dormant from the start (the fork emits natively).
 *
 * When the upstream PRs are accepted, this whole file can be deleted.
 */

const SCOPE = "cp2020-augmented";

const WEAPON_FIRED = "cyberpunk2020.weaponFired";
const SUPPRESSIVE_FIRE = "cyberpunk2020.suppressiveFire";
const SKILL_ROLLED = "cyberpunkSkillRolled";
const MULTI_HIT_TEMPLATE = "systems/cyberpunk2020/templates/chat/multi-hit.hbs";
const SUPPRESSIVE_TEMPLATE = "systems/cyberpunk2020/templates/chat/suppressive.hbs";
// The base system's five ranged/melee fire resolvers; each builds the per-location areaDamages and
// renders multi-hit.hbs. Matches the seam PR (item.js: __fullAuto/__threeRoundBurst/__semiAuto/__meleeBonk),
// plus __martialBonk — item.__weaponRoll routes a martial strike there and it renders multi-hit.hbs the same
// way, so it MUST set _fireCtx too; otherwise the render wrap would emit weaponFired with a stale prior
// context (mis-attributing the martial strike — and thus its attackerId — to the last ranged fire, which
// starved the action counter / aim clear / arm-use notice that key on it).
const FIRE_METHODS = ["__fullAuto", "__threeRoundBurst", "__semiAuto", "__meleeBonk", "__martialBonk"];

/* ─── Pure decision logic (no Foundry globals → unit-testable) ─────────────────────────────────── */

/** Does this function's OWN source emit `hookName`? */
export function nativelyEmits(fn, hookName) {
  try {
    return typeof fn === "function" && fn.toString().includes(hookName);
  } catch (_e) {
    return false;
  }
}

/**
 * Does ANY of the class's OWN methods emit `hookName`? This is the disengage condition — and it must
 * scan the whole prototype, not just the one method we wrap: the fork emits cyberpunkSkillRolled from a
 * helper (`_fireSkillRolled`) that `rollSkill` CALLS, so a single-method check would miss it and the
 * shim would double-emit. Our own wrappers carry `__cpSeamShim` and are excluded so a re-run doesn't
 * mistake them for native emission. (Caveat: an emit relocated to a free function — not a method on this
 * class — would not be seen; the seam PRs and the fork both emit from methods on the class.)
 */
export function prototypeEmits(proto, hookName) {
  if (!proto) return false;
  for (const key of Object.getOwnPropertyNames(proto)) {
    try {
      const fn = Object.getOwnPropertyDescriptor(proto, key)?.value;
      if (typeof fn === "function" && fn.__cpSeamShim !== true && fn.toString().includes(hookName)) return true;
    } catch (_e) { /* getter / exotic prop — ignore */ }
  }
  return false;
}

/** Should we wrap `method`? Only if it's a real function we haven't already wrapped. (Whether the base
 *  system is native is decided once per class via prototypeEmits, before any wrapping.) */
export function shouldPatch(method) {
  return typeof method === "function" && method.__cpSeamShim !== true;
}

/* ─── weaponFired: identity from the fire method, areaDamages from the render ──────────────────── */

// Set while a SHIM-wrapped fire method runs, so the renderTemplate wrap below knows the attacker/weapon
// for the multi-hit card it is about to render. Not cleared eagerly: two of the base fire methods call
// roll.execute() WITHOUT awaiting it, so the multi-hit render happens after the method returns — a
// stale clear would drop the payload. multi-hit.hbs is only ever rendered by a fire, and every fire
// refreshes this first, so leaving the last context set is correct and never mis-attributes.
let _fireCtx = null;

// Set while a SHIM-wrapped __suppressiveFire runs, so the renderTemplate wrap below can emit the
// suppressiveFire hook for the suppressive card it renders. The base method AWAITS its render inside the
// call (unlike two of the fire methods), so this is set immediately before and never goes stale mid-render.
let _suppressiveCtx = null;

// The effect fields the combat engine reads off a weaponFired payload (beyond identity + areaDamages).
// On stock, the base fire methods build ONLY areaDamages, so without these the module's explosion / gas /
// spread / DOT / taser / armor-piercing / penetration branches never fire. They live on the loaded ammo
// item's system.* (seeded by ammoModifierSystemFields + the ammo sheet); `edged` is weapon-level for melee.
const AMMO_EFFECT_FIELDS = [
  "ap", "edged", "effectTypes", "blastRadius", "blastFullDamageWithin", "blastMultipliers", "blastShrapnel",
  "penDamageMult", "armorMultSoft", "armorMultHard",
  "spreadMode", "spreadDamageShort", "spreadDamageMedium", "spreadDamageLong",
  "spreadWidthShort", "spreadWidthMedium", "spreadWidthLong",
  "stunSaveOnHit", "stunSaveMod", "dotEnabled", "dotTurns", "dotType", "dotDamageFormula",
];

/** Effect fields for the fired weapon, read from its loaded ammo (system.*) first, then the weapon
 *  itself (melee `edged`). Only defined fields are copied → the engine applies its own defaults for the
 *  rest. Pure-ish read; safe when there's no ammo (returns whatever the weapon provides, else {}). */
export function ammoEffectFields(weapon) {
  const out = {};
  const ammoSys = weapon?.actor?.items?.get?.(weapon?.system?.ammoItemId)?.system;
  for (const sys of [ammoSys, weapon?.system]) {
    if (!sys) continue;
    for (const k of AMMO_EFFECT_FIELDS) if (out[k] === undefined && sys[k] !== undefined) out[k] = sys[k];
  }
  return out;
}

function installWeaponFiredShim(ItemProto) {
  if (prototypeEmits(ItemProto, WEAPON_FIRED)) return false;   // base system emits it (method or helper) → disengage
  let patchedAny = false, foundAny = false;
  for (const name of FIRE_METHODS) {
    const orig = ItemProto?.[name];
    if (typeof orig === "function") foundAny = true;           // the method exists (base's or already ours)
    if (!shouldPatch(orig)) continue;                          // missing or already ours → skip
    function fireWrapper(attackMods, ...rest) {
      _fireCtx = {
        attackerId: this.actor?.id ?? null,
        weaponName: this.name,
        weaponId: this.id ?? null,   // resolve the EXACT weapon downstream (two same-named weapons with different ammo)
        fallbackTargetActorId: attackMods?.targetActor?.id ?? null,
        effectFields: ammoEffectFields(this),   // ammo-derived explosion/gas/spread/DOT/taser/AP/pen fields
      };
      return orig.call(this, attackMods, ...rest);
    }
    fireWrapper.__cpSeamShim = true;
    ItemProto[name] = fireWrapper;
    patchedAny = true;
  }
  // We got past the disengage check (the base does NOT emit weaponFired natively), yet NONE of the base
  // fire methods exist to wrap → the damage automation would silently never run. Make that loud so a
  // host rename of these methods is diagnosable, not a mysterious "nothing happens on fire". (C5)
  if (!foundAny) {
    console.warn(`${SCOPE} | seam shim: base emits no ${WEAPON_FIRED} and none of its fire methods (${FIRE_METHODS.join(", ")}) were found to patch — combat damage automation is inactive (did the base system rename them?).`);
  }
  // Only intercept the renderer if at least one fire method is actually shimmed; if all four emit
  // natively we never get here, so renderTemplate is left untouched (no chance of a double-emit).
  if (patchedAny) installRenderEmit();
  return patchedAny;
}

/** Wrap the global renderTemplate ONCE so each fire-card render emits its hook, combining the captured
 *  method context with the render's own computed data: multi-hit.hbs → weaponFired (one per resolved
 *  target); suppressive.hbs → suppressiveFire. Idempotent — either shim half may install it. */
function installRenderEmit() {
  // The base fire methods render multi-hit.hbs via the BARE GLOBAL renderTemplate (Multiroll.execute →
  // renderTemplate(path, data)). On v13/v14 that global is a deprecation accessor whose SETTER overrides
  // what callers resolve, whereas foundry.applications.handlebars.renderTemplate is a NON-WRITABLE property
  // (assigning it throws in strict mode → aborts the shim). So capture + wrap the GLOBAL only.
  const orig = globalThis.renderTemplate;
  if (typeof orig !== "function" || orig.__cpSeamShim === true) return;

  async function renderWrapper(path, data, ...rest) {
    const out = await orig.call(this, path, data, ...rest);
    try {
      if (_fireCtx && path === MULTI_HIT_TEMPLATE) {
        const target = data?.target;   // a Token (full-auto sets it per shot); may be undefined otherwise
        Hooks.callAll(WEAPON_FIRED, {
          attackerId: _fireCtx.attackerId,
          weaponName: _fireCtx.weaponName,
          weaponId: _fireCtx.weaponId,
          areaDamages: data?.areaDamages ?? {},
          targetTokenId: target?.id ?? null,
          targetActorId: target?.actor?.id ?? _fireCtx.fallbackTargetActorId ?? null,
          ...(_fireCtx.effectFields ?? {}),   // explosion/gas/spread/DOT/taser/AP/pen fields from the ammo
        });
      } else if (_suppressiveCtx && path === SUPPRESSIVE_TEMPLATE) {
        // suppressive.hbs carries the base method's already-computed saveDC/dmgFormula/weaponName/width;
        // the wrapper supplies the actor/token/range context the render data lacks. Matches the fork's
        // native cyberpunk2020.suppressiveFire payload so damage-hooks.js draws the fire zone identically.
        Hooks.callAll(SUPPRESSIVE_FIRE, {
          saveDC: data?.saveDC,
          dmgFormula: data?.dmgFormula,
          weaponName: data?.weaponName,
          actorId: _suppressiveCtx.actorId,
          attackerTokenId: _suppressiveCtx.attackerTokenId,
          zoneWidth: data?.width,
          weaponRange: _suppressiveCtx.weaponRange,
        });
      }
    } catch (e) {
      console.warn(`${SCOPE} | seam-shim card render emit failed`, e);
    }
    return out;
  }
  renderWrapper.__cpSeamShim = true;
  // Assign the global (an accessor with a working setter on v13/v14); the base system's bare
  // `renderTemplate(...)` call then resolves to our wrapper. Guarded so a non-writable binding on some
  // future core can't abort the shim — weaponFired auto-emit just won't engage there.
  try {
    globalThis.renderTemplate = renderWrapper;
  } catch (e) {
    console.warn(`${SCOPE} | seam-shim could not wrap renderTemplate; weaponFired/suppressiveFire will not auto-emit`, e);
  }
}

/* ─── suppressiveFire: identity/range from the method, computed values from the render ─────────── */

/** Wrap __suppressiveFire so it emits suppressiveFire on stock (the base posts a card but fires no hook,
 *  so damage-hooks.js never draws the fire zone / prompts evasion). The wrapper only CAPTURES the context
 *  the suppressive.hbs render data lacks (attacker actor/token + weapon range); installRenderEmit() does
 *  the actual emit when that template renders, reading the base's already-computed saveDC/dmgFormula/width
 *  (recomputing saveDC here would drift — the base derives it from a shot count it then decrements). */
function installSuppressiveFireShim(ItemProto) {
  if (prototypeEmits(ItemProto, SUPPRESSIVE_FIRE)) return false;  // base system emits it → disengage
  const orig = ItemProto?.__suppressiveFire;
  if (!shouldPatch(orig)) return false;                          // missing or already ours → skip
  function suppressiveWrapper(mods, ...rest) {
    const attackerTok = canvas?.tokens?.placeables?.find(t => t.actor?.id === this.actor?.id) ?? null;
    _suppressiveCtx = {
      actorId: this.actor?.id ?? null,
      attackerTokenId: attackerTok?.id ?? null,
      weaponRange: Number(this._getWeaponSystem?.()?.range ?? 50),
    };
    return orig.call(this, mods, ...rest);
  }
  suppressiveWrapper.__cpSeamShim = true;
  ItemProto.__suppressiveFire = suppressiveWrapper;
  installRenderEmit();   // the shared render wrap emits suppressiveFire when suppressive.hbs renders
  return true;
}

/* ─── skillRolled: the whole payload is available to a simple wrapper ──────────────────────────── */

function installSkillRolledShim(ActorProto) {
  if (prototypeEmits(ActorProto, SKILL_ROLLED)) return false;  // base system emits it (rollSkill or a helper) → disengage
  const orig = ActorProto?.rollSkill;
  if (!shouldPatch(orig)) return false;                        // missing or already ours → skip
  function rollSkillWrapper(skillId, ...rest) {
    // Emit cyberpunkSkillRolled AFTER the roll, carrying its total. The base's common rollSkill path
    // posts its roll card WITHOUT awaiting it and returns nothing, so the total isn't on the return —
    // instead capture the roll card as it's created (Multiroll attaches rolls:[…]) and emit from there.
    // The old shim emitted BEFORE the roll with no total, so every IP-tracker queue row showed 0 (F8).
    try {
      const skill = this.items?.get?.(skillId);
      if (skill) {
        const actorId = this.id, actorName = this.name, rolledSkillId = skill.id, skillName = skill.name;
        let done = false;
        const hookId = Hooks.on("createChatMessage", (msg) => {
          if (done) return;
          const total = msg?.rolls?.[0]?.total;
          if (typeof total !== "number") return;   // wait for the actual rolled card
          // Consume ONLY this user's own roll card — another user's card in the window would mis-attribute
          // its total to this queue row. Author is the reliable owner signal at creation and is
          // authoritative; only when it's unavailable (msg.author can be absent on v14+) fall back to
          // matching the card's speaker actor to the rolled actor.
          const authorId = msg?.author?.id ?? msg?._source?.author ?? null;
          if (authorId) {
            if (authorId !== game.user?.id) return;            // another user's card
          } else {
            const speakerActorId = msg?.speaker?.actor ?? null; // author unknown → prefer a speaker match
            if (speakerActorId && speakerActorId !== actorId) return;
          }
          done = true;
          Hooks.off("createChatMessage", hookId);
          try { Hooks.callAll(SKILL_ROLLED, { actorId, skillId: rolledSkillId, actorName, skillName, total }); }
          catch (e) { console.warn(`${SCOPE} | seam-shim skillRolled emit failed`, e); }
        });
        // Never leak the hook if no rolled card appears (e.g., the skill vanished before the roll).
        setTimeout(() => { if (!done) { done = true; Hooks.off("createChatMessage", hookId); } }, 8000);
      }
    } catch (e) {
      console.warn(`${SCOPE} | seam-shim skillRolled setup failed`, e);
    }
    return orig.call(this, skillId, ...rest);
  }
  rollSkillWrapper.__cpSeamShim = true;
  ActorProto.rollSkill = rollSkillWrapper;
  return true;
}

/* ─── Entry point (call once at ready, after the base system's classes exist) ──────────────────── */

/** Install the seam shim, self-disengaging where the base system already emits the hooks.
 *  @returns {{weaponFired:boolean, skillRolled:boolean}} which halves actually engaged. */
export function registerSeamShim() {
  const out = { weaponFired: false, suppressiveFire: false, skillRolled: false };
  const ItemProto = CONFIG?.Item?.documentClass?.prototype;
  const ActorProto = CONFIG?.Actor?.documentClass?.prototype;
  // Install each half in its OWN try/catch: a failure wrapping one hook must never abort the other.
  try {
    if (ItemProto) out.weaponFired = installWeaponFiredShim(ItemProto);
  } catch (e) {
    console.warn(`${SCOPE} | seam shim weaponFired install failed`, e);
  }
  try {
    if (ItemProto) out.suppressiveFire = installSuppressiveFireShim(ItemProto);
  } catch (e) {
    console.warn(`${SCOPE} | seam shim suppressiveFire install failed`, e);
  }
  try {
    if (ActorProto) out.skillRolled = installSkillRolledShim(ActorProto);
  } catch (e) {
    console.warn(`${SCOPE} | seam shim skillRolled install failed`, e);
  }
  if (out.weaponFired || out.suppressiveFire || out.skillRolled) {
    console.log(`${SCOPE} | seam shim engaged (base system lacks native hooks):`, out);
  }
  return out;
}
