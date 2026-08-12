# CP2020 Augmented — User Guide

> The GM & player manual for the module's features: what each one does at the table, the exact
> gestures, and the settings that shape it. The technical companion is
> [ARCHITECTURE.md](ARCHITECTURE.md); the visual-effects reference is [FX-RAIL.md](FX-RAIL.md).

Status: LIVING DOCUMENT — spine 2026-08-11; sections marked `(stub)` fill in as features settle
after the current rework wave. Feature behavior described here matches the post-rework shape.

---

## 1. First-time setup

- Install alongside the `cyberpunk2020` system (v1.1.1+), Foundry v13–v14.
- ⚠ **Updating across versions that add map-region types requires a full SERVER restart** — a
  page reload is not enough. Hosted users: use the host's Stop/Start control.
- Optional, recommended for visuals: the free **Sequencer** and **JB2A** modules. Detected
  automatically; nothing to configure. Without them you still get the muzzle-flash light and
  sounds — with them, tracers, muzzle sprites, and impact marks.
- A **Setup & What's New** dialog appears at first load and after updates; it re-surfaces when a
  new version changes things worth knowing.

## 2. Combat automation (stub — expand after wave)

Fire from a weapon's sheet or macro → the shot resolves, draws, and sounds → the **Apply Damage**
window opens after the on-screen action. Per-hit rows show location, SP, and damage; each row
expands to a full math breakdown naming every SP source (armor layers, cover, AP effects, BTM).

## 3. Cover (post-rework shape)

- **Place cover:** scene tools → Place Cover → pick a preset ("Brick Wall [25]"…) or type your
  own SP; structure defaults to 3×SP. Zones are drawn regions; **walls and doors** can carry
  cover too, straight from the stock wall config.
- **It just works:** there is no enable setting — placing cover IS turning it on. When a shot's
  line crosses cover, the Apply window pre-fills it (editable; typed SP always wins).
- **Cover wears down per bullet.** Every round chews the cover's structure; a long burst can
  destroy a door MID-burst, and the rounds after the break hit at full force. The chat summary
  shows what the cover absorbed and what's left. A destroyed door stands open.
- Repair = restore structure / untick Destroyed on the object.

## 4. Vehicles (post-rework shape)

- **Deploy:** press Deploy on a vehicle item → (players) the GM approves → **the vehicle appears
  on the map next to you**, and its actor files into the Vehicles folder. The item and the
  deployed vehicle stay linked both ways.
- **Board:** stand within a square of the vehicle, right-click YOUR token, click the van icon.
  You take a seat inside the vehicle's footprint — shrunk to ride, still fully clickable and
  targetable (drive-by firefights with real tokens are the point). Drag between squares of the
  footprint to change seats. The walking-figure icon steps you out beside the car.
- **Occupancy:** the vehicle shows an aboard count; its sheet lists riders with per-person
  step-out buttons; your own sheet shows an "Aboard" strip while riding. A control on the
  vehicle's HUD fades occupants (only on your screen) when you want to admire the car.
- Vehicle damage, SDP, and Maximum Metal combat: (stub).

## 5. Shopping (stub)

GM opens the shop, players buy from the compendium-backed catalog with live pricing and GM
curation (supplement visibility, price overrides). First open of a session stocks the shelves
(brief loading panel). Two legacy bulk-import packs are hidden from players by default
(reversible world setting).

## 6. Weapon & ammo effects (stub — see FX-RAIL for the full visual reference)

On by default; one master switch (*Display: Weapon-Fire Effects*). Sounds ride each player's own
interface-volume slider. Ammo loads that would visibly differ, do; blood is a separate opt-in
world setting, off by default.

## 7. Radiation & hazard zones (stub)

## 8. Improvement Points (stub)

## 9. Chipware & skill chips (stub)

## 10. Settings reference (stub — regenerate at release; every setting, its default, and who it's for)
