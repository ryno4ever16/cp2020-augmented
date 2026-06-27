/**
 * Dice helpers for the Augmented Edition. Vendored from the base system's `module/dice.js` so the
 * module is self-sufficient: the formula-inspection helper the shop's cyberware install flow needs
 * (does a Humanity-Cost / surgical-damage string roll dice or is it a flat number?), plus the CP2020
 * base exploding d10 + the roll factory the Facedown fallback uses. `makeD10Roll` uses only the
 * global `Roll`, so this file stays import-free.
 */

/** True if the formula string contains a die term (e.g. "2d6+1"), false for a flat number ("3"). */
export const formulaHasDice = function (formula) {
  return formula.match(/[0-9)][dD]/) || formula.match(/[dD][0-9(]/);
};

/** The CP2020 base die: an exploding d10 (re-rolls and adds on a natural 10). */
export const BaseDie = "1d10x10";

/** Build a CP2020 d10 roll: the exploding base die + any extra additive terms (strings or `@paths`). */
export const makeD10Roll = function (terms, rollData) {
  const extra = Array.isArray(terms)
    ? terms
    : (terms != null ? [terms] : []);

  const cleaned = extra
    .map((x) => String(x ?? "").trim())
    .filter((s) => s && s !== "+" && s !== "-");

  const parts = [BaseDie, ...cleaned];
  const formula = parts.join(" + ");

  return new Roll(formula, rollData);
};
