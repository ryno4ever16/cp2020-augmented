/**
 * Dice helpers for the Augmented Edition. Currently only the formula-inspection helper the shop's
 * cyberware install flow needs (does a Humanity-Cost / surgical-damage string roll dice or is it a
 * flat number?). Vendored from the base system's `module/dice.js` so the module is self-sufficient.
 */

/** True if the formula string contains a die term (e.g. "2d6+1"), false for a flat number ("3"). */
export const formulaHasDice = function (formula) {
  return formula.match(/[0-9)][dD]/) || formula.match(/[dD][0-9(]/);
};
