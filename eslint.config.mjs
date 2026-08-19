// ESLint flat config for the cp2020-augmented module — CORRECTNESS rules only, no style rules.
// The point is the break-things classes a typo or a refactor leaves behind: undefined names,
// duplicate object keys (the corrections-layer hazard — JS last-key-wins eats the first group
// silently), unreachable branches, fallthrough, self-assignment. Style stays the codebase's own.
// Run: npm run lint (whole module) — also wired to run per-file on every edit via the
// project-local Claude hook (.claude/settings.local.json).
import globals from "globals";

/** Foundry VTT + module globals the code reads without importing. */
const foundryGlobals = {
  // Foundry core
  game: "readonly", canvas: "readonly", ui: "readonly", CONFIG: "readonly",
  Hooks: "readonly", foundry: "readonly", CONST: "readonly",
  Actor: "readonly", Item: "readonly", ChatMessage: "readonly", Roll: "readonly",
  Scene: "readonly", User: "readonly", Macro: "readonly", Folder: "readonly",
  TokenDocument: "readonly", ActiveEffect: "readonly", Combat: "readonly",
  Dialog: "readonly", FormApplication: "readonly", Application: "readonly",
  Handlebars: "readonly", TextEditor: "readonly", FilePicker: "readonly",
  loadTemplates: "readonly", renderTemplate: "readonly", fromUuid: "readonly",
  fromUuidSync: "readonly", duplicate: "readonly", mergeObject: "readonly",
  getProperty: "readonly", setProperty: "readonly", expandObject: "readonly",
  flattenObject: "readonly", isEmpty: "readonly", randomID: "readonly",
  AudioHelper: "readonly", PIXI: "readonly", libWrapper: "readonly",
  // jQuery ships as a page global on both supported cores ($ and jQuery); the V2 direction is
  // away from it, but the compat guards legitimately reference the global.
  $: "readonly", jQuery: "readonly",
  // Registration-era collection + app globals.
  Actors: "readonly", Items: "readonly", SettingsConfig: "readonly",
  Token: "readonly", Combatant: "readonly", MeasuredTemplateDocument: "readonly",
  RegionDocument: "readonly", JournalEntry: "readonly", Playlist: "readonly",
  // Modules this module cooperates with
  Sequence: "readonly", Sequencer: "readonly",
};

export default [
  {
    files: ["module/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...foundryGlobals },
    },
    rules: {
      // The reasons this linter exists:
      "no-undef": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-dupe-class-members": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-fallthrough": "error",
      "no-self-assign": "error",
      "no-self-compare": "error",
      "no-compare-neg-zero": "error",
      "no-cond-assign": ["error", "except-parens"],
      "no-constant-binary-expression": "error",
      "no-unsafe-negation": "error",
      "no-unused-private-class-members": "error",
      "no-async-promise-executor": "error",
      "no-import-assign": "error",
      "valid-typeof": "error",
      "use-isnan": "error",
      "no-loss-of-precision": "error",
      // Signal without ceremony: unused things are dead code or a typo'd reference.
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
      // Everything stylistic: deliberately absent.
    },
  },
  {
    // Keeper specs run under node and drive a page; they import their own deps.
    files: ["tests/**/*.mjs", "tools/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser, ...foundryGlobals },
    },
    rules: {
      "no-undef": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-fallthrough": "error",
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
    },
  },
];
