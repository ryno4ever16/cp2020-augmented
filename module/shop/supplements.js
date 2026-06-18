/**
 * Supplement classification + canonicity for the Shopping catalog ([[shopping-design]]).
 *
 * Catalog items carry an inconsistent free-text `system.source`. The catalog sorts them into three
 * canonicity tiers and gates visibility (user model, 2026-06-07):
 *   • "core"     — the Cyberpunk 2020 core rulebook (and untagged content = core gear with no source
 *                  label, e.g. the Programs pack). ALWAYS present + enabled for everyone.
 *   • "official" — any official R.Talsorian supplement (Maximum Metal, Chromebook, Solo of Fortune…).
 *                  Always visible to the GM (so they can judge power creep); enabled per-book FOR
 *                  PLAYERS via GM-only controls in the shop. Default off for players.
 *   • "noncanon" — community / online / cross-system (homebrew). ABSENT entirely (even for the GM)
 *                  until the GM flips the master "Allow homebrew" switch in System Settings; then it
 *                  behaves like official (GM curates per-source in the shop, default off for players).
 *
 * The GM is never blocked from seeing in-play content; the GM controls what PLAYERS see.
 */

/** Ordered match rules (first hit wins). Each: [test(lowercased source), supplement, canon]. */
const RULES = [
  // Non-canon: cross-system + community/online (community IS homebrew/non-canon).
  [s => s.includes("shadowrun"), "Shadowrun", "noncanon"],
  [s => s.includes("when gravity fails"), "When Gravity Fails", "noncanon"],
  [s => s.includes("cyberpunk.asia"), "cyberpunk.asia", "noncanon"],
  [s => s.includes("datafortress2020"), "Datafortress 2020", "noncanon"],
  [s => s.includes("ambient.ca"), "ambient.ca", "noncanon"],
  [s => s.includes("blackhammer"), "Blackhammer Project", "noncanon"],
  [s => /^https?:\/\//.test(s) || s.includes("www."), "Other online", "noncanon"],

  // Official R.Talsorian books. Order matters: more specific before less specific.
  [s => s.includes("solo of fortune 2"), "Solo of Fortune 2", "official"],
  [s => s.includes("solo of fortune"), "Solo of Fortune", "official"],
  [s => s.includes("maximum metal"), "Maximum Metal", "official"],
  // Chromebook is FOUR distinct books — one filter each. Match "Chromebook N" (audited tags) and
  // legacy "Chrome N" / "Chr N". A number 1–4 picks the volume; un-numbered "Chrome" falls to the
  // generic Chromebook fallback below. (Note "chromebook" contains "chrome"; alternation longest-first
  // + the digit keeps each rule on its own volume; "Chromebook 1 & 2" matches vol 1 first.)
  [s => /(chromebook|chrome|chr) ?1/.test(s), "Chromebook 1", "official"],
  [s => /(chromebook|chrome|chr) ?2/.test(s), "Chromebook 2", "official"],
  [s => /(chromebook|chrome|chr) ?3/.test(s), "Chromebook 3", "official"],
  [s => /(chromebook|chrome|chr) ?4/.test(s), "Chromebook 4", "official"],
  [s => s.includes("chrome"), "Chromebook", "official"],
  [s => s.includes("eurosource plus") || s.includes("eurosource +") || s.includes("eurosource+"), "Eurosource Plus", "official"],
  [s => s.includes("eurotour"), "Eurotour", "official"],
  [s => s.includes("eurosource") || s.includes("euro source"), "Eurosource", "official"],
  [s => s.includes("corpbook") || s.includes("corporate report") || s.includes("corp report"), "Corporate Report", "official"],
  [s => s.includes("protect") && s.includes("serve"), "Protect & Serve", "official"],
  [s => s.includes("neo tribes") || s.includes("neotribes"), "Neo Tribes", "official"],
  [s => s.includes("rockerboy"), "Rockerboy", "official"],
  [s => s.includes("home of the brave"), "Home of the Brave", "official"],
  [s => s.includes("rough guide to the u"), "Rough Guide to the UK", "official"],
  [s => s.includes("deep space"), "Deep Space", "official"],
  [s => s.includes("pacific rim"), "Pacific Rim", "official"],
  [s => s.includes("wildside"), "Wildside", "official"],
  [s => s.includes("listen up"), "Listen Up You Primitive Screwheads", "official"],
  [s => s.includes("blackhand"), "Blackhand's Street Weapons", "official"],
  [s => s.includes("firestorm"), "Firestorm", "official"],
  [s => s.includes("interface"), "Interface (zine)", "official"],

  // Core (and the Reference Book bound with it). Kept late so "Cyberpunk 2020" inside an official-book
  // string doesn't pre-empt the book match above.
  [s => s.includes("reference book"), "Cyberpunk 2020 (Core)", "core"],
  [s => /cyberpunk\s*2020/.test(s), "Cyberpunk 2020 (Core)", "core"],
];

/**
 * Classify a raw source string into { supplement, canon }.
 * Empty / "undefined" / unrecognized → "Untagged", treated as CORE (core gear lacking a source tag,
 * e.g. the Programs pack, armor with source "undefined").
 * @param {string} rawSource
 * @returns {{ supplement: string, canon: "core"|"official"|"noncanon" }}
 */
export function classifySupplement(rawSource) {
  const s = String(rawSource ?? "").trim().toLowerCase();
  if (!s || s === "undefined" || s === "null") return { supplement: "Untagged", canon: "core" };
  for (const [test, supplement, canon] of RULES) {
    try { if (test(s)) return { supplement, canon }; } catch { /* skip bad rule */ }
  }
  return { supplement: "Untagged", canon: "core" };
}

/** Known official supplement names (for the in-shop GM toggles), de-duplicated + sorted. */
export function knownOfficialSupplements() {
  return [...new Set(RULES.filter(r => r[2] === "official").map(r => r[1]))].sort();
}

/** Known non-canon/homebrew source names (for the gated toggles), de-duplicated + sorted. */
export function knownNoncanonSources() {
  return [...new Set(RULES.filter(r => r[2] === "noncanon").map(r => r[1]))].sort();
}

/** Short badge labels for the catalog row source-badge (the full name is kept as the hover title).
 *  Only the long / very common names are abbreviated; everything else shows in full. */
const SHORT = {
  "Cyberpunk 2020 (Core)": "Core",
  "Chromebook 1": "Chr 1",
  "Chromebook 2": "Chr 2",
  "Chromebook 3": "Chr 3",
  "Chromebook 4": "Chr 4",
  "Maximum Metal": "Max Metal",
  "Solo of Fortune": "SoF",
  "Solo of Fortune 2": "SoF 2",
  "Eurosource": "Eurosrc",
  "Eurosource Plus": "Eurosrc+",
  "Corporate Report": "Corp Rpt",
  "Rough Guide to the UK": "Rough Guide",
  "Listen Up You Primitive Screwheads": "Screwheads",
  "Blackhand's Street Weapons": "Blackhand",
  "Home of the Brave": "Home/Brave",
  "Protect & Serve": "Protect&Srv",
  "When Gravity Fails": "Grav Fails",
  "Datafortress 2020": "DF2020",
  "Blackhammer Project": "Blackhammer"
};

/** Abbreviated supplement label for the catalog badge (falls back to the full name). */
export function shortSupplement(name) {
  return SHORT[name] ?? name;
}

/**
 * Resolve a supplement's state under the current config.
 * @param {string} supplement
 * @param {"core"|"official"|"noncanon"} canon
 * @param {object} cfg  { allowHomebrew:boolean, enabledSources:{name:true} }
 * @returns {{ present:boolean, enabledForPlayers:boolean }}
 *   present           = exists in play at all (homebrew is absent until allowHomebrew).
 *   enabledForPlayers = players can see it (GM always sees `present` content).
 */
export function sourceState(supplement, canon, cfg = {}) {
  const enabled = cfg.enabledSources?.[supplement] === true;
  if (canon === "core") return { present: true, enabledForPlayers: true };
  if (canon === "official") return { present: true, enabledForPlayers: enabled };
  // noncanon / homebrew
  if (!cfg.allowHomebrew) return { present: false, enabledForPlayers: false };
  return { present: true, enabledForPlayers: enabled };
}

/** Whether the given viewer (GM or player) can see items from this supplement. */
export function isVisibleTo(supplement, canon, cfg, isGM) {
  const st = sourceState(supplement, canon, cfg);
  if (!st.present) return false;
  return isGM ? true : st.enabledForPlayers;
}
