/**
 * Seam shim — a TEMPORARY, self-disengaging compatibility patch.
 *
 * The Augmented module reacts to two base-system events: `cyberpunk2020.weaponFired` (drives the damage
 * automation) and `cyberpunkSkillRolled` (drives the IP tracker). Those hook emissions are proposed to
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
const SKILL_ROLLED = "cyberpunkSkillRolled";
const MULTI_HIT_TEMPLATE = "systems/cyberpunk2020/templates/chat/multi-hit.hbs";
// The base system's four ranged/melee fire resolvers; each builds the per-location areaDamages and
// renders multi-hit.hbs. Matches the seam PR (item.js: __fullAuto/__threeRoundBurst/__semiAuto/__meleeBonk).
const FIRE_METHODS = ["__fullAuto", "__threeRoundBurst", "__semiAuto", "__meleeBonk"];

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

function installWeaponFiredShim(ItemProto) {
  if (prototypeEmits(ItemProto, WEAPON_FIRED)) return false;   // base system emits it (method or helper) → disengage
  let patchedAny = false;
  for (const name of FIRE_METHODS) {
    const orig = ItemProto?.[name];
    if (!shouldPatch(orig)) continue;                          // missing or already ours → skip
    function fireWrapper(attackMods, ...rest) {
      _fireCtx = {
        attackerId: this.actor?.id ?? null,
        weaponName: this.name,
        fallbackTargetActorId: attackMods?.targetActor?.id ?? null,
      };
      return orig.call(this, attackMods, ...rest);
    }
    fireWrapper.__cpSeamShim = true;
    ItemProto[name] = fireWrapper;
    patchedAny = true;
  }
  // Only intercept the renderer if at least one fire method is actually shimmed; if all four emit
  // natively we never get here, so renderTemplate is left untouched (no chance of a double-emit).
  if (patchedAny) installMultiHitEmit();
  return patchedAny;
}

/** Wrap the global renderTemplate so each multi-hit.hbs render (one per resolved target) emits
 *  weaponFired, combining the fire context (attacker/weapon) with the render's own per-target data. */
function installMultiHitEmit() {
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
          areaDamages: data?.areaDamages ?? {},
          targetTokenId: target?.id ?? null,
          targetActorId: target?.actor?.id ?? _fireCtx.fallbackTargetActorId ?? null,
        });
      }
    } catch (e) {
      console.warn(`${SCOPE} | seam-shim weaponFired emit failed`, e);
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
    console.warn(`${SCOPE} | seam-shim could not wrap renderTemplate; weaponFired will not auto-emit`, e);
  }
}

/* ─── skillRolled: the whole payload is available to a simple wrapper ──────────────────────────── */

function installSkillRolledShim(ActorProto) {
  if (prototypeEmits(ActorProto, SKILL_ROLLED)) return false;  // base system emits it (rollSkill or a helper) → disengage
  const orig = ActorProto?.rollSkill;
  if (!shouldPatch(orig)) return false;                        // missing or already ours → skip
  function rollSkillWrapper(skillId, ...rest) {
    try {
      const skill = this.items?.get?.(skillId);
      if (skill) {
        Hooks.callAll(SKILL_ROLLED, {
          actorId: this.id, skillId: skill.id, actorName: this.name, skillName: skill.name,
        });
      }
    } catch (e) {
      console.warn(`${SCOPE} | seam-shim skillRolled emit failed`, e);
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
  const out = { weaponFired: false, skillRolled: false };
  const ItemProto = CONFIG?.Item?.documentClass?.prototype;
  const ActorProto = CONFIG?.Actor?.documentClass?.prototype;
  // Install each half in its OWN try/catch: a failure wrapping one hook must never abort the other.
  try {
    if (ItemProto) out.weaponFired = installWeaponFiredShim(ItemProto);
  } catch (e) {
    console.warn(`${SCOPE} | seam shim weaponFired install failed`, e);
  }
  try {
    if (ActorProto) out.skillRolled = installSkillRolledShim(ActorProto);
  } catch (e) {
    console.warn(`${SCOPE} | seam shim skillRolled install failed`, e);
  }
  if (out.weaponFired || out.skillRolled) {
    console.log(`${SCOPE} | seam shim engaged (base system lacks native hooks):`, out);
  }
  return out;
}
