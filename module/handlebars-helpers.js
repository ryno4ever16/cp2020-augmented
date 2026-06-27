/**
 * Cyberpunk 2020: Augmented Edition — vendored Handlebars localization helpers.
 *
 * The module's templates use {{CPLocal}} / {{CPLocalParam}} (the base system's localization
 * helpers, which prepend the shared "CYBERPUNK." namespace). On the fork the system registers
 * these, but the module must not DEPEND on that for a vanilla install — so vendor them here,
 * byte-identical to the system's handlebars-helpers.js. Re-registering on the fork is a harmless
 * identical overwrite (Handlebars.registerHelper replaces by name; same impl = no behaviour change).
 */
export function registerAugmentedHandlebarsHelpers() {
  // Short for cyberpunk localize: looks up "CYBERPUNK.<str>", falling back to the raw key if absent.
  Handlebars.registerHelper("CPLocal", function (str, options) {
    const localizeKey = "CYBERPUNK." + str;
    if (!game.i18n.has(localizeKey)) return str;
    if (!options || Object.keys(options.hash).length === 0) return game.i18n.localize(localizeKey);
    return game.i18n.format(localizeKey, options.hash);
  });
  Handlebars.registerHelper("CPLocalParam", function (str, options) {
    return game.i18n.format("CYBERPUNK." + str, options);
  });

  // Resolve a per-type item-sheet partial to the MODULE's templates dir. The base system's
  // varTemplate helper prepends "systems/cyberpunk2020/templates/" (→ HIS parts); our vendored item
  // sheet needs OUR parts, so this mirror prepends the module dir instead.
  // Usage: {{> (augVarTemplate "item/parts/[VAR]/summary.hbs" item.type)}}
  Handlebars.registerHelper("augVarTemplate", function (path, replaceWith) {
    return "modules/cp2020-augmented/templates/" + String(path).replace("[VAR]", replaceWith);
  });
}
