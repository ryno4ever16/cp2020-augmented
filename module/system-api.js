/**
 * Bridge to the host system's public helper API (`game.cyberpunk.api`).
 *
 * The base `cyberpunk2020` system exposes a small set of its helpers on `game.cyberpunk.api`
 * (i18n / schema / lookups / chat / dice / constants). Each helper wrapped with `apiHelper` PREFERS
 * the system's version at call time and FALLS BACK to the module's own local copy when the system
 * doesn't expose it (an older base system without the API). That keeps the module working on every
 * version, and makes it use the system's helper automatically the moment one is present — so the
 * module never duplicates the system's behaviour where it can borrow it.
 *
 * The lookup is done per call (not at import time) because `game.cyberpunk.api` is assigned during
 * the system's init, after this module's ES imports resolve.
 *
 * NOTE: once every supported base system ships the API, the fallbacks here — and the local copies
 * they point at — can be deleted (the planned cleanup patch → the lean "release build" in
 * Data/_seamwork/release-build-optionA/).
 *
 * ⚠ PREFERRING THE HOST IS ONLY SAFE WHERE THE TWO COPIES MEAN THE SAME THING. A few local copies
 * are deliberate SUPERSETS of the base's helper of the same name — same group, same name, same call
 * shape — so a base that starts publishing the api would resolve over them and the extra rules would
 * simply stop applying, with nothing to notice: the location roll would lose the alternate table and
 * the gone-limb re-roll, the martial bonus lookup would drop its third argument (the per-skill map),
 * and the ruleset toggle would read its setting unguarded and throw where the local copy answers
 * false. `requiresFeature` is the guard: such a helper names the capability the base must DECLARE on
 * `game.cyberpunk.api.features` (the same declaration `hostProvides` reads for the feature layers)
 * before its version may be used. Until the base declares it, the module keeps its own copy — which
 * is the behaviour every version of the module has shipped, so the guard is also the no-change path.
 *
 * @param {string}   group     api group: "i18n" | "schema" | "lookups" | "chat" | "dice" | "constants"
 * @param {string}   name      helper name within that group
 * @param {Function} fallback  the module's local implementation, used when the api lacks it
 * @param {object}   [opts]
 * @param {string}   [opts.requiresFeature]  capability the base must declare before its copy is used
 * @returns {Function}         calls the api helper if present and permitted, else the fallback
 */
export function apiHelper(group, name, fallback, { requiresFeature = null } = {}) {
  return function (...args) {
    if (requiresFeature && !hostProvides(requiresFeature)) return fallback.apply(this, args);
    const fn = globalThis.game?.cyberpunk?.api?.[group]?.[name];
    return (typeof fn === "function" ? fn : fallback).apply(this, args);
  };
}

/**
 * Does the host system already provide `feature` itself? Each add-on feature layer checks this at
 * `ready` so it doesn't double-register a feature the base system has absorbed (double damage
 * application, duplicate sheet buttons, …). The base declares what it provides on
 * `game.cyberpunk.api.features`; an absent map (an older base, or one shipping none of these) reads as
 * `false`, so the module registers normally. See Data/_seamwork/FOLLOWUP-cherrypick-hardening.md.
 *
 * Also read by `apiHelper`'s `requiresFeature` guard, for the helpers whose local copy carries rules
 * the base's helper of the same name does not (see the note above): "martial" covers the martial
 * bonus lookup and the ruleset toggle, "hitLocationRules" the alternate location table and the
 * gone-limb re-roll.
 *
 * @param {string} feature  "combatAutomation" | "vehicles" | "shopping" | "ip" | "martial" |
 *                          "actorSheet" | "itemSheet" | "hitLocationRules"
 * @returns {boolean}
 */
export function hostProvides(feature) {
  return globalThis.game?.cyberpunk?.api?.features?.[feature] === true;
}
