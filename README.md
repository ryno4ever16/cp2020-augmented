# Cyberpunk 2020: Augmented Edition

A companion module for the [Cyberpunk 2020](https://github.com/ryno4ever16/cyberpunk2020) FoundryVTT system. It adds, as **opt-in** overlays on top of the base system:

- **Vehicles & ACPA** (Maximum Metal) — module-owned document sub-types (`cp2020-augmented.vehicle`).
- **Combat automation** — automated damage application, saves, and area effects.
- **Shopping** — a buy interface over the system's compendia, plus optional GM shops.
- **Improvement Point tracking** — GM IP tracker + player level-ups.

It does **not** modify the base system; everything is added through hooks, module-owned sub-types, and `flags.cp2020-augmented.*` fields.

## Design principles

This module is written to the **same conventions as the base system** ("Tilt's Way"): templates own structure / JS owns data, everything localized via i18n keys (no hardcoded HTML/CSS in JS), settings under `SETTINGS.*`, features registered from `Hooks.once('init'/'ready')`. The long-term intent is that this work remains mergeable back into the base system.

## Requirements

- FoundryVTT v13–v14
- The `cyberpunk2020` system, v1.1.1 or later. The module uses the system's public helper API (`game.cyberpunk.api`) when it is present and falls back to its own bundled copies otherwise, so it runs on a stock install.

## Status

v1.0.0 — first public release: vehicles & ACPA (Maximum Metal), combat automation, shopping with an imported multi-supplement catalog, and Improvement Point tracking. Further supplement-data review ships as follow-up patches.

## Credits & licenses

The optional **Carolingian terminal sheet skin** (the per-user `carolingianSkin` setting — a dark
cyberpunk-terminal look for the character/item sheets) is an adaptation, **scoped to this system's
`.cyberpunk` sheets**, of two MIT-licensed projects. It is a snapshot of *visual styles only* — not
the modules themselves, not their palette UI / scripts / window chrome:

- **Cyberpunk Restyler** — © DARKNEET69, MIT — the sheet styling (dark surface, bracketed `[ ]`
  tabs, `>`-prompt headers + blink cursor, teal glow, statsrow / armor-display / wound-tracker /
  skill chip-toggle / selects + buttons).
- **Carolingian UI** (`crlngn-ui`) — © Carol / crlngn-dev, MIT — a snapshot of ~8 colour-token
  values from one teal preset, and the Work Sans / Roboto Slab typography it uses. When Carolingian
  UI is installed, the skin defers to its live palette. Install it for more palettes + a matching
  interface theme.

Bundled fonts **Work Sans** and **Roboto Slab** are licensed under the SIL Open Font License 1.1
(full text in [`fonts/OFL.txt`](fonts/OFL.txt)).
