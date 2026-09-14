# Cyberpunk 2020: Augmented Edition

A companion module for the [Cyberpunk 2020](https://github.com/SuperCoon666/cyberpunk2020) FoundryVTT system. It automates combat, damage, gear, vehicles and NPCs against the printed rules, and ships a large supplement catalog to go with them.

It does **not** modify the base system. Everything is added through hooks, module-owned document sub-types, and `flags.cp2020-augmented.*` fields. Most features switch on when you use them and stay out of the way otherwise; the few that change how the table plays are settings the GM turns on.

## What it adds

**Combat and damage**
- Automated damage application with a single Apply Damage window that shows its math: armor layers, cover, armor piercing, and the wounds each hit leaves.
- Stun and death saves prompted from the card, once per burst rather than once per hit.
- Grenades, launcher rounds and area effects: fragmentation, incendiary, gas clouds, stun, dazzle and sonic, with token conditions that expire on the combat clock.
- Ammo effects: damage over time, shock, shotgun spread patterns, and blast falloff.
- Martial arts, combat drugs, chipware and full-conversion borg loadouts.
- Radiation zones that dose the tokens inside them.

**Cover that can be shot apart**
- Place cover from the Regions toolbar using presets from the Core rulebook's cover list, or give any wall or door an SP and an optional Structure value.
- SP alone soaks fire the Core way; SP plus Structure follows Maximum Metal's wear rules, and a door or wall ground to zero opens or breaches.
- Cover on the shot line is detected automatically and folded into the damage math. Vehicles count as cover.

**Vehicles and ACPA (Maximum Metal)**
- Module-owned vehicle documents with Standard, Maximum Metal and ACPA sheets, switchable per vehicle.
- Deployment to the map, boarding and riding, vehicle weapons, and vehicle-scale damage.

**Weapons fire you can see**
- Tracers, muzzle flash, impacts and casings for every weapon class, with damage held until the shot lands. Animations need the optional Sequencer and JB2A modules; without them the rules still run and the effects are skipped.

**NPC generator**
- Builds goons from a threat level: stats, skills, armor, weapons and cyberware rolled per goon, previewed before they're created.

**Shopping and economy**
- A buy interface over the system's and the module's compendia, GM shops, ammunition, and purchases for NPCs.

**Improvement Points**
- A GM tracker for awarding IP, player level-ups funded from an IP bank, and the editable IP field on every skill.

**Compendium**
- Sixteen packs and about 1,760 items imported from the supplements: pistols, SMGs, rifles, shotguns, heavy and exotic weapons, melee, armor and clothing, gear, drugs and services, skills, cyberware, chipware, vehicles, vehicle weapons, ACPA systems, and netrunning programs. Stat summaries only, per the content policy below.

**Look**
- Under Foundry's dark colour scheme the character and item sheets carry a terminal-style skin (see Credits). Under the light scheme they render in the base system's plain style.

## Requirements

- FoundryVTT v13 or v14.
- The `cyberpunk2020` system, v1.1.1 or later. The module uses the system's public helper API when it is present and falls back to its own bundled copies otherwise, so it runs on a stock install.
- Optional: [Sequencer](https://foundryvtt.com/packages/sequencer) and [JB2A](https://foundryvtt.com/packages/JB2A_DnD5e) for the weapon-fire animations.

## Install

Search for "Augmented" in Foundry's module browser, or paste this manifest URL into the install dialog:

```
https://raw.githubusercontent.com/ryno4ever16/cp2020-augmented/main/module.json
```

## Status

**Current release: 1.2.4.** The module is in active use and updated as bugs are reported and rules gaps are found. Every release has notes on the [releases page](https://github.com/ryno4ever16/cp2020-augmented/releases), and updates arrive through Foundry's normal update check.

Found a bug? Open an [issue](https://github.com/ryno4ever16/cp2020-augmented/issues) with the module version, the system version, and what you did. One quick check first: if it still happens with the module disabled, it belongs to the base system, not here.

## Credits & licenses

The **terminal sheet skin** — the dark cyberpunk-terminal look the character and item sheets carry
under Foundry's dark colour scheme — is an adaptation, **scoped to this system's `.cyberpunk`
sheets**, of two MIT-licensed projects. It is a snapshot of *visual styles only* — not the modules
themselves, not their palette UI / scripts / window chrome. (There is no separate module toggle:
the skin follows Foundry's own **Colour Scheme → Applications** setting. Switch that to Light and
the sheets render in the base system's plain style instead.)

- **Cyberpunk Restyler** — © [DARKNEET69](https://github.com/DARKNEET69), MIT — the sheet styling (dark surface, bracketed `[ ]`
  tabs, `>`-prompt headers + blink cursor, teal glow, statsrow / armor-display / wound-tracker /
  skill chip-toggle / selects + buttons).
- **Carolingian UI** (`crlngn-ui`) — © Carol / crlngn-dev, MIT — a snapshot of ~8 colour-token
  values from one teal preset, and the Work Sans / Roboto Slab typography it uses. When Carolingian
  UI is installed, the skin defers to its live palette. Install it for more palettes + a matching
  interface theme.

Bundled fonts **Work Sans** and **Roboto Slab** are licensed under the SIL Open Font License 1.1
(full text in [`fonts/OFL.txt`](fonts/OFL.txt)).

The **compendium item icons** in [`img/icons/`](img/icons) are from
[game-icons.net](https://game-icons.net), licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) (full text in
[`img/icons/LICENSE.txt`](img/icons/LICENSE.txt)). The 35 glyphs shipped are the work of
**Lorc**, **Delapouite**, **Skoll**, **sbed**, **John Colburn** and **Carl Olsen**.

## Legal / content policy

Cyberpunk 2020: Augmented Edition is unofficial content provided under the
[Homebrew Content Policy](https://rtalsoriangames.com/homebrew-content-policy/) of R. Talsorian
Games and is not approved or endorsed by RTG. This content references materials that are the
property of R. Talsorian Games and its licensees.
