/**
 * Vendored i18n helpers — a subset of the base system's module/utils.js.
 *
 * A module can't cleanly import the system's source, so the small helpers the
 * Augmented features rely on are vendored here, matching the system's behaviour
 * exactly: keys resolve under the shared "CYBERPUNK." namespace via game.i18n.format,
 * so localization keys stay portable if this work ever merges upstream.
 */
export function localize(key, data = {}) {
  return game.i18n.format("CYBERPUNK." + key, data);
}

export function localizeParam(str, params = {}) {
  return game.i18n.format("CYBERPUNK." + str, params);
}
