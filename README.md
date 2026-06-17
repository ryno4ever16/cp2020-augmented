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
- The `cyberpunk2020` system (v2.0.0-beta+)

## Status

Early scaffold. See the project board for the feature roll-out order (combat automation → vehicles/ACPA → shopping → IP).
