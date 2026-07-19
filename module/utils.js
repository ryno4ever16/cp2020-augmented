import { defaultAreaLookup, defaultHitLocations, W4RST4R_AREA_LOOKUP } from "./lookups.js"
import { apiHelper } from "./system-api.js";

// Prefer the base system's i18n + dice helpers (game.cyberpunk.api) at call time; fall back to the
// local copies (the _-prefixed functions below). See module/system-api.js.
export const localize      = apiHelper("i18n", "localize", _localize);
export const tryLocalize   = apiHelper("i18n", "tryLocalize", _tryLocalize);
export const localizeParam = apiHelper("i18n", "localizeParam", _localizeParam);
export const rollLocation  = apiHelper("dice", "rollLocation", _rollLocation);

// Utility methods that don't really belong anywhere else

export function properCase(str) {
    return str.replace(
        /\w\S*/g,
        function(txt) {
            return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
        }
    );
};

export function replaceIn(replaceIn, replaceWith) {
    return replaceIn.replace("[VAR]", replaceWith);
}

/**
 * Proportional armor-layer combination (CP2020 p.99): two SP layers don't add — the combined SP is
 * max(a,b) plus a diminishing bonus by their difference (equal layers +5, far-apart layers +0). This
 * is the SINGLE definition shared by the damage resolver (cover + live-SP re-derivation, combat/
 * DamageApplicator.js) and the full-borg chassis-SP fold (mech/borg.js). It mirrors the base system's
 * own `combineSP` (actor.js maxLayeredSP) so a folded-in layer matches what the sheet would show.
 */
export function combineArmorSP(a, b) {
    a = Number(a) || 0;
    b = Number(b) || 0;
    if (!a) return b;
    if (!b) return a;
    const diff = Math.abs(a - b);
    let mod;
    if      (diff >= 27) mod = 0;
    else if (diff >= 21) mod = 1;
    else if (diff >= 15) mod = 2;
    else if (diff >= 9)  mod = 3;
    else if (diff >= 5)  mod = 4;
    else                 mod = 5;
    return Math.max(a, b) + mod;
}

/**
 * Optimal proportional combination of a set of armor SP layers (CP2020 p.99). Because the pairwise
 * `combineArmorSP` is order-dependent across three or more layers, a fixed-order left-fold can land
 * below the best achievable SP. This finds the MAXIMUM over every layering order — a subset DP, with
 * a greedy fallback past 16 layers — mirroring the base system's own `maxLayeredSP` (actor.js). It is
 * the SINGLE multi-layer fold: the live damage re-derivation (DamageApplicator `_deriveLiveSP`) reuses
 * it so a wearer's combined SP is identical to the base's prepared per-location value, whether or not
 * a typed layer forces the live path.
 * @param {number[]} layers   Per-layer SP values (0 / falsy ignored).
 * @returns {number}
 */
export function foldArmorSP(layers) {
    const sp = (layers ?? []).map(v => Number(v) || 0).filter(v => v > 0);
    const n = sp.length;
    if (!n) return 0;
    if (n === 1) return sp[0];

    const MAX_EXACT_LAYERS = 16;
    if (n <= MAX_EXACT_LAYERS) {
        const size = 1 << n;
        const dp = new Array(size);
        dp[0] = 0;
        for (let mask = 1; mask < size; mask++) {
            let best = 0;
            for (let i = 0; i < n; i++) {
                const bit = 1 << i;
                if (!(mask & bit)) continue;
                const val = combineArmorSP(dp[mask ^ bit], sp[i]);
                if (val > best) best = val;
            }
            dp[mask] = best;
        }
        return dp[size - 1];
    }

    // Too many layers for the exact DP: greedily add the layer that maximizes the running SP.
    let current = 0;
    const remaining = sp.slice();
    while (remaining.length) {
        let bestIdx = 0;
        let bestVal = combineArmorSP(current, remaining[0]);
        for (let i = 1; i < remaining.length; i++) {
            const val = combineArmorSP(current, remaining[i]);
            if (val > bestVal) { bestVal = val; bestIdx = i; }
        }
        current = bestVal;
        remaining.splice(bestIdx, 1);
    }
    return current;
}

/* ------------------------------------------------------------------ *
 *  Singleton popups — one instance of a given dialog at a time.       *
 *  Clicking a "Fire"/"Roll"/etc. button again brings the open dialog  *
 *  to the front instead of stacking a second copy.                    *
 * ------------------------------------------------------------------ */
const _singletonDialogs = new Map();

/**
 * Open a dialog as a singleton keyed by `key`. If one is already open it is brought to the front
 * and returned; otherwise `factory()` builds it, and it is tracked + auto-untracked on close.
 * The factory must return an Application/Dialog (NOT yet rendered) — this renders it.
 * @param {string} key
 * @param {() => (object|null)} factory
 * @returns {object|null} the dialog (existing or new)
 */
export function openSingletonDialog(key, factory) {
    const existing = _singletonDialogs.get(key);
    if (existing && (existing.rendered ?? false)) {
        try { existing.bringToTop?.(); } catch (e) { /* non-fatal */ }
        return existing;
    }
    _singletonDialogs.delete(key);

    const dialog = factory();
    if (!dialog) return null;

    _singletonDialogs.set(key, dialog);
    const origClose = dialog.close?.bind(dialog);
    if (origClose) {
        dialog.close = async (...args) => {
            if (_singletonDialogs.get(key) === dialog) _singletonDialogs.delete(key);
            return origClose(...args);
        };
    }
    dialog.render(true);
    return dialog;
}

function _localize(key, data = {}) {
  return game.i18n.format("CYBERPUNK." + key, data);
}
function _tryLocalize(str, defaultResult=str) {
    let key = "CYBERPUNK." + str;
    if(!game.i18n.has(key))
        return defaultResult;
    else
        return game.i18n.localize(key);
}
function _localizeParam(str, params) {
    return game.i18n.format("CYBERPUNK."+ str, params);
}

export function shortLocalize(str) {
    let makeShort = !!game.i18n.has("CYBERPUNK." + str + "Short");
    return tryLocalize(makeShort ? str + "Short" : str);
}

export function deleteFieldUpdate(path) {
  const ForcedDeletion = globalThis.foundry?.data?.operators?.ForcedDeletion;
  if (typeof ForcedDeletion === "function") {
    return { [path]: new ForcedDeletion() };
  }

  const DeleteField = globalThis.foundry?.data?.operations?.DeleteField;
  if (typeof DeleteField === "function") {
    return { [path]: new DeleteField() };
  }

  const parts = String(path).split(".");
  const key = parts.pop();
  return { [`${parts.join(".")}.-=${key}`]: null };
}
/**
 * 
 * @param {CyberpunkActor} The actor you're targeting a location on
 * @param {*} targetArea If you're aiming at a specific area, this is the NAME of that area - eg "Head"
 * @returns {*} {roll: The rolled diceroll when aiming, areaHit: where actually hit}
 */
// Which number→location table to roll/display on. The W4RST4R limb model uses its own table (incl.
// Groin). Otherwise, the "Core hit-location display" setting (default on) forces the canonical
// Core table; with it off, a per-actor custom hitLocLookup is honored instead. (Scope fixed: these
// read the cp2020-augmented settings, not the base system's — a copy-from-fork bug.)
function _hitLocationLookup(targetActor) {
    const w4 = (() => { try { return game.settings.get("cp2020-augmented", "limbModel") === "w4rst4r"; } catch { return false; } })();
    if (w4) return W4RST4R_AREA_LOOKUP;
    const coreDisplay = (() => { try { return game.settings.get("cp2020-augmented", "hitLocationCoreDisplay"); } catch { return true; } })();
    if (coreDisplay) return defaultAreaLookup;
    return (targetActor?.hitLocLookup) ? targetActor.hitLocLookup : defaultAreaLookup;
}

// The four limb zones that can be "gone" (arms/legs). Head/Torso — and W4RST4R's Groin — are never
// limbs, so they never trigger a re-roll and always remain a valid location (which is what keeps the
// re-roll bounded and non-empty).
const GONE_LIMB_ZONES = new Set(["rArm", "lArm", "rLeg", "lLeg"]);

/** True when a limb zone has no limb left to meaningfully take a hit: a destroyed CYBERLIMB wreck
 *  (limbStatus destroyed, SDP pool present) OR a severed/destroyed FLESH limb (no SDP pool). Reads the
 *  M18/M19 flags directly (not the mech/cyberlimb.js helpers) to avoid an import cycle — cyberlimb.js
 *  imports this module. A crippled/useless/disabled limb is still THERE and stays hittable. Pure-ish. */
function _isGoneLimbZone(targetActor, zone) {
    if (!GONE_LIMB_ZONES.has(zone)) return false;
    const SCOPE = "cp2020-augmented";
    const limbStatus = targetActor?.getFlag?.(SCOPE, "limbStatus")      ?? targetActor?.flags?.[SCOPE]?.limbStatus      ?? {};
    const flesh      = targetActor?.getFlag?.(SCOPE, "fleshLimbStatus") ?? targetActor?.flags?.[SCOPE]?.fleshLimbStatus ?? {};
    const sdpSum     = Number(targetActor?.system?.sdp?.sum?.[zone]) || 0;
    const cyberGone  = sdpSum > 0 && limbStatus[zone] === "destroyed";
    const fleshGone  = sdpSum === 0 && (flesh[zone] === "severed" || flesh[zone] === "destroyed");
    return cyberGone || fleshGone;
}

/** World toggle for the missing-limb re-roll (default ON). */
function _rerollGoneLimbEnabled() {
    try { return game.settings.get("cp2020-augmented", "rerollGoneLimbLocation") === true; }
    catch (e) { return false; }
}

/** Pick a still-valid location for `targetActor` by re-rolling over the faces of `lookup` whose location
 *  is NOT a gone limb. ONE weighted roll (rejection sampling collapsed): because Head/Torso (and Groin)
 *  are never gone, the valid set is always non-empty, so this is O(1) and preserves the table's relative
 *  odds among the surviving locations. */
async function _pickValidLocation(targetActor, lookup) {
    const faces = Object.keys(lookup);
    const validFaces = faces.filter(f => !_isGoneLimbZone(targetActor, lookup[f]));
    if (!validFaces.length) return lookup[faces[0]];   // unreachable (Head/Torso always valid) — stay safe
    const pick = await new Roll(`1d${validFaces.length}`).evaluate();
    return lookup[validFaces[pick.total - 1]];
}

/**
 * Re-roll every hit in an `areaDamages` map that landed on a limb that isn't there — the module-side
 * counterpart for shots whose location was rolled OUTSIDE this module (the base system's item.js rolls
 * single-shot/burst location; the base has no concept of a "gone limb", which is defined by this module's
 * M18/M19 flags, so the check has to happen here). Each hit on a gone limb re-rolls its OWN location
 * (per-bullet, RAW). No-ops when the toggle is off, the actor is unknown, or nothing hit a gone limb.
 * Accepts a Token or an Actor. Returns a NEW map (never mutates the input); shape: `{ loc: [{damage},…] }`.
 */
export async function rerollGoneLimbAreaDamages(targetActorOrToken, areaDamages) {
    const targetActor = targetActorOrToken?.actor ?? targetActorOrToken;
    if (!targetActor || !areaDamages || !_rerollGoneLimbEnabled()) return areaDamages;
    const keys = Object.keys(areaDamages);
    if (!keys.some(k => _isGoneLimbZone(targetActor, k))) return areaDamages;   // fast path: nothing gone
    const lookup = _hitLocationLookup(targetActor);
    const out = {};
    const add = (loc, hit) => { (out[loc] ??= []).push(hit); };
    for (const loc of keys) {
        const hits = areaDamages[loc] ?? [];
        if (!_isGoneLimbZone(targetActor, loc)) { for (const h of hits) add(loc, h); continue; }
        for (const h of hits) add(await _pickValidLocation(targetActor, lookup), h);
    }
    return out;
}

async function _rollLocation(targetActor, targetArea) {
    if(targetArea) {
        // Area name to number lookup. Tolerate areas (e.g. W4RST4R "Groin") absent from the actor's
        // hitLocations by still reporting the targeted area. An AIMED shot is deliberate — never
        // re-rolled, even at a limb that is gone (the shooter chose the target).
        const hitLocs = (!!targetActor) ? targetActor.hitLocations : defaultHitLocations();
        const targetNum = hitLocs?.[targetArea]?.location?.[0];
        let roll = await new Roll(`${Number.isFinite(targetNum) ? targetNum : 1}`).evaluate();
        return {
            roll: roll,
            areaHit: targetArea
        };
    }
    // Number to area name lookup (Core table / W4RST4R table per settings).
    let hitAreaLookup = _hitLocationLookup(targetActor);

    let roll = await new Roll("1d10").evaluate();
    let areaHit = hitAreaLookup[roll.total];
    let rerolledFrom = null;

    // Re-roll a hit that lands on a limb that isn't there — CP2020 p.100: "…a roll of 7-8 (R.Leg) is
    // pretty silly. Ignore it and re-roll." Done as ONE weighted pick over the still-valid faces, NOT a
    // loop: because Head/Torso (and Groin) are never gone limbs, the valid set is always non-empty, so
    // this is O(1) and can never hang or empty out even if every limb is severed. Only on a random roll
    // (aimed shots return above), only when the target actor is known, and only when the world toggle is
    // on. rerolledFrom lets the caller show WHY the location moved.
    if (targetActor && _rerollGoneLimbEnabled() && _isGoneLimbZone(targetActor, areaHit)) {
        rerolledFrom = areaHit;
        areaHit = await _pickValidLocation(targetActor, hitAreaLookup);
    }

    return {
        roll: roll,
        areaHit: areaHit,
        rerolledFrom: rerolledFrom
    };
}

export function deepLookup(startObject, path) {
    let current = startObject;
    path.split(".").forEach(segment => {
        current = current[segment];
    });
    return current;
}

// Like deep-lookup, but... setting instead
export function deepSet(startObject, path, value, overwrite=true) {
    let current = startObject;
    let pathArray = path.split(".");
    let lastPath = pathArray.pop();
    pathArray.forEach(segment => {
        let alreadyThere = current[segment];
        if(alreadyThere === undefined) {
            current[segment] = {};
        }
        current = current[segment];
    });
    let alreadyThere = current[lastPath];
    if(alreadyThere === undefined || overwrite) {
        current[lastPath] = value;
    }

    return startObject;
}

// Clamp x to be between min and max inclusive
export function clamp(x, min, max) {
    return Math.min(Math.max(x, min), max);
}

export async function getDefaultSkills(lang = game.i18n.lang) {
  const packs = getSkillsPackNames(lang);
  const defaultPackName = packs.find((p) => p.startsWith("cyberpunk2020.default-skills-"));
  if (!defaultPackName) return [];

  const pack = game.packs.get(defaultPackName);
  if (!pack) return [];

  return await pack.getDocuments();
}

function _cpNormalizeLang(lang) {
  return String(lang || "en").trim().toLowerCase().replace("_", "-");
}

function _cpLangCandidates(lang) {
  const l = _cpNormalizeLang(lang);
  const out = [];
  if (l) out.push(l);

  const base = l.split("-")[0];
  if (base && base !== l) out.push(base);

  // always keep EN as a final stable fallback if present
  if (!out.includes("en")) out.push("en");

  return out;
}

/**
 * Return compendium pack names that contain skills for the given language.
 * This is dynamic: it discovers available language packs from game.packs.
 *
 * Naming convention:
 *   cyberpunk2020.default-skills-<lang>
 *   cyberpunk2020.role-skills-<lang>
 *
 * Language matching priority:
 *   exact (e.g. pt-br) -> base (pt) -> en -> first available
 *
 * @param {string} lang
 * @returns {string[]} pack collection IDs
 */
export function getSkillsPackNames(lang = game.i18n.lang) {
  const prefixes = {
    default: "cyberpunk2020.default-skills-",
    role: "cyberpunk2020.role-skills-"
  };

  // Discover available packs by suffix
  const available = {
    default: new Map(),
    role: new Map()
  };

  for (const pack of game.packs) {
    const col = pack.collection;
    if (!col) continue;

    for (const [kind, prefix] of Object.entries(prefixes)) {
      if (col.startsWith(prefix)) {
        const suffix = col.slice(prefix.length).toLowerCase();
        available[kind].set(suffix, col);
      }
    }
  }

  const want = _cpLangCandidates(lang);

  const pick = (kind) => {
    // 1) exact/base/en candidate match
    for (const cand of want) {
      const col = available[kind].get(cand);
      if (col) return col;
    }
    // 2) if en exists but not already matched (covers cases where lang candidates didn't include en for some reason)
    const en = available[kind].get("en");
    if (en) return en;

    // 3) otherwise: first available pack of this kind
    return available[kind].values().next().value ?? null;
  };

  const out = [];
  const d = pick("default");
  const r = pick("role");
  if (d) out.push(d);
  if (r) out.push(r);

  return out;
}

const _cpSkillIndexCache = new Map();

/**
 * Get a locale-appropriate list of skills from compendiums, without requiring an Actor.
 * Returns: [{ id, name }]
 * Cached per resolved pack-set (not just by language string).
 *
 * @param {string} lang
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function getSkillIndex(lang = game.i18n.lang) {
  const packs = getSkillsPackNames(lang);
  const cacheKey = packs.join("|") || "none";
  if (_cpSkillIndexCache.has(cacheKey)) return _cpSkillIndexCache.get(cacheKey);

  const out = [];

  for (const packName of packs) {
    const pack = game.packs.get(packName);
    if (!pack) continue;

    // v12/v13: getIndex supports { fields }
    const idx = await pack.getIndex({ fields: ["name", "type"] });

    for (const e of idx) {
      if (e.type && e.type !== "skill") continue;
      // Compendium index uses "_id"
      out.push({ id: e._id, name: e.name });
    }
  }

  // De-duplicate by id (default + role packs can overlap)
  const byId = new Map();
  for (const s of out) {
    if (s?.id && s?.name && !byId.has(s.id)) byId.set(s.id, s);
  }

  const list = Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  _cpSkillIndexCache.set(cacheKey, list);
  return list;
}

// Checking implant mechanics
// Accepts: the Item document itself, its system, or directly the CyberWorkType object
export function cwHasType(obj, type) {
  const cwt =
    obj?.system?.CyberWorkType ??
    obj?.CyberWorkType ??
    obj;
  const types = Array.isArray(cwt?.Types) ? cwt.Types : [];
  return types.includes(type) || cwt?.Type === type;
}

// Cyberware TYPE normalizer — collapses the many spellings/casings of a cyberware base type to one
// canonical key (CYBEROPTIC/Eye → CyberOptic, CYBERARM/CYBERHAND/Arm → CyberArm, …) so a module's
// Module.AllowedParentCyberwareType can be compared to a host implant's cyberwareType. This is the single
// source for that mapping — the item-sheet parent-picker AND the container install-check both use it
// (base-system infrastructure reused, not re-invented). Pure.
const CW_TYPE_ALIASES = {
  "CYBERARM": "CyberArm", "CYBERHAND": "CyberArm", "CYBERLEG": "CyberLeg", "CYBERFOOT": "CyberLeg",
  "CYBEREAR": "CyberAudio", "CYBEROPTIC": "CyberOptic", "IMPLANT": "CyberTorso",
  "Arm": "CyberArm", "Leg": "CyberLeg", "Ear": "CyberAudio", "Eye": "CyberOptic", "Torso": "CyberTorso",
};
export function pickCwType(t) {
  if (!t) return null;
  if (typeof t === "string") { const k = t.trim(); return CW_TYPE_ALIASES[k] || k; }
  if (typeof t === "object") {
    const k = (t.key ?? t.value ?? t.name);
    if (typeof k === "string") { const s = k.trim(); return CW_TYPE_ALIASES[s] || s; }
  }
  return null;
}

// Is the implant active, taking into account the mode (Permanent/Activated) and the “Active” flag
export function cwIsEnabled(obj) {
  const sys = obj?.system ?? obj;
  const mode = sys?.EffectMode ?? "Permanent";
  if (mode === "Activatable") return !!sys?.EffectActive;
  return true;
}

// Skinweave subtype tag. Skinweave is a subdermal weave: it adds SP without an EV layering penalty.
export const CYBERWARE_SUBTYPE_SKINWEAVE = "SKINWEAVE";

// Is this cyberware a Skinweave? Detect by the stable subtype field, NEVER the item name — names get
// renamed by players and rewritten by localization, while the subtype is data that survives both.
export function cwIsSkinweave(obj) {
  const sys = obj?.system ?? obj;
  return sys?.cyberwareSubtype === CYBERWARE_SUBTYPE_SKINWEAVE;
}

function _getSkillBaseId(skill) {
  // Actor-owned / world skill id
  const direct = skill?.id ?? skill?._id;
  if (direct) return String(direct);

  // If somehow only sourceId exists
  const src = skill?.flags?.core?.sourceId;
  if (src && typeof src === "string") return String(src).split(".").pop();

  return null;
}

// Combat Sense (Solo special ability): its level is added to Initiative and Awareness/Notice rolls.
// Keyed by stable _id, never name — names are renamed by users and rewritten by localization. The RU
// role-skills pack uses a different _id than EN, so both Combat Sense ids are listed.
const _COMBAT_SENSE_SKILL_IDS = new Set([
  "BjBZ8zc7wh52MSwK", // Combat Sense   (role-skills-en)
  "L2hC8GzV0mRqE7xS"  // Чувство Боя    (role-skills-ru)
]);

// Shared identity check for "is this a particular skill": match the skill's stable _id (or its
// compendium sourceId, still an _id) against a set of known ids. Keyed on _id, never name, so renames
// and localization — which rewrite item names — can't break detection.
function _skillIdInSet(skill, ids) {
  const baseId = _getSkillBaseId(skill);
  if (baseId && ids.has(baseId)) return true;
  const src = skill?.flags?.core?.sourceId;
  if (src && typeof src === "string" && ids.has(src.split(".").pop())) return true;
  return false;
}

/** True if `skill` is the Combat Sense special ability (by stable _id, EN or RU pack). Its level
 *  drives system.CombatSenseMod, which is added to Initiative and Awareness/Notice rolls. */
export function isCombatSenseSkill(skill) {
  return skill?.type === "skill" && _skillIdInSet(skill, _COMBAT_SENSE_SKILL_IDS);
}

// PA Combat Sense (the Powered Armor Trooper's special ability, Maximum Metal p.52): its level is
// added to a powered-armor suit's Initiative (and caps the in-suit Martial Arts skill). Distinct from
// a Solo's ordinary Combat Sense, which does NOT apply while in powered armor. Keyed by the stable
// compendium _id (module supplement-skills pack), never name — renames/localization can't break it.
const _PA_COMBAT_SENSE_SKILL_IDS = new Set(["PACombatSense001"]);

/** True if `skill` is the PA Combat Sense special ability (by stable _id, or its compendium
 *  sourceId). Read by the ACPA initiative code — a suit's Initiative gains this skill's level. */
export function isPACombatSenseSkill(skill) {
  return skill?.type === "skill" && _skillIdInSet(skill, _PA_COMBAT_SENSE_SKILL_IDS);
}

// PA Pilot (Maximum Metal p.53): the non-Trooper's ACPA skill — it grants the MANEUVER bonuses of PA
// Combat Sense (the in-suit Martial-Arts cap) but NOT the initiative bonus. Keyed by the stable
// compendium _id (module supplement-skills pack), never name.
const _PA_PILOT_SKILL_IDS = new Set(["PAPilotSkill0001"]);

/** True if `skill` is the PA Pilot skill (by stable _id, or its compendium sourceId). Read by the ACPA
 *  maneuver-cap code — it raises the in-suit Martial-Arts cap like PA Combat Sense, but grants no init. */
export function isPAPilotSkill(skill) {
  return skill?.type === "skill" && _skillIdInSet(skill, _PA_PILOT_SKILL_IDS);
}

/**
 * Resolve an actor reference token-first. An UNLINKED token's synthetic actor shares its `id` with
 * the world ("prototype") actor, so `game.actors.get(id)` on a mook silently retargets the shared
 * base actor — every same-base token then bleeds one pool of HP/flags. The scene-qualified token
 * (works even when this client views another scene) and the actor UUID are the only unambiguous
 * handles; the bare actorId stays as the last resort so old chat cards that carry nothing else keep
 * working (they behave as before — base actor — rather than dying).
 * @param {object} ref
 * @param {string} [ref.tokenId]
 * @param {string} [ref.sceneId]   Pairs with tokenId; falls back to the viewed scene when absent.
 * @param {string} [ref.actorUuid] `Scene.X.Token.Y.Actor.Z` for a synthetic actor, `Actor.Z` linked.
 * @param {string} [ref.actorId]
 * @returns {Actor|null}
 */
export function resolveActorRef({ tokenId = null, sceneId = null, actorUuid = null, actorId = null } = {}) {
  if (tokenId) {
    const scene = (sceneId ? game.scenes?.get(sceneId) : null) ?? canvas?.scene ?? null;
    const tokActor = scene?.tokens?.get(tokenId)?.actor ?? null;
    if (tokActor) return tokActor;
  }
  if (actorUuid) {
    try {
      const doc = fromUuidSync(actorUuid);
      if (doc?.documentName === "Actor") return doc;
    } catch (e) { /* fall through to the id lookup */ }
  }
  return (actorId ? game.actors?.get(actorId) : null) ?? null;
}
