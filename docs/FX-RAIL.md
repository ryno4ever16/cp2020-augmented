# The FX rail

*First edition — 2026-08-09. Covers `module/fx/effects.js` and the seam that feeds it, plus the one
thing a shot puts on the canvas that is not a sprite: the shotgun's shot pattern
(`module/combat/spread-zone-look.js`, and the flow that places it in `module/combat/damage-hooks.js`).*

This is the maintainer's document for everything the module draws when a gun goes off. It is written
for someone who has never read a development report: every number here is either measured on a real
install or ruled by the module's user, and where the two disagree the document says which is which.

**The one rule to read first.** `module/fx/effects.js` is the *only* file that knows about outside
effect engines. Every asset key, every colour, every duration and every geometry constant lives there.
If an animation looks wrong, that file is where it is wrong; nothing else needs opening.

---

## 1. Architecture

### 1.1 The seam

```
   base system fires a weapon
        │
        │  (the base emits no hook of its own — module/seam-shim.js wraps its fire
        │   methods and its card render, and raises one instead)
        ▼
   Hooks: "cyberpunk2020.weaponFired"  ── payload ──┐
        │                                           │
        ├─→ module/combat/damage-hooks.js           │  (damage: what happened)
        └─→ module/fx/effects.js  fxWeaponFired()   │  (presentation: what it looked like)
                                                    │
                            both read the SAME payload object
```

The payload is one resolved burst against one target. Its presentation-relevant fields:

| Field | Meaning | Set by |
|---|---|---|
| `attackerId` | who fired | seam shim |
| `weaponId` / `weaponName` | which weapon (id is exact — two same-named weapons can carry different ammo) | seam shim |
| `shotsFired` / `shotsHit` | rounds spent and rounds that landed **for this card** | the base's own card data |
| `areaDamages` | one entry per landing round, by hit location | the base's own card data |
| `targetTokenId` | the card's own resolved target — **damage-flow routing** | the card |
| `fxTargetTokenId` | the aimed-at token — **presentation only**, set on every fire mode | seam shim |
| `firedByUserId` | the one client that resolved the shot | seam shim |
| `fumbleRuled` | the base actually *resolved* a fumble (not merely "a 1 was rolled") | seam shim |
| `modifier` | the loaded ammo's modifier id — **the ammo overlay's input** | seam shim, from the loaded ammo item. Sits **beside** `caliber` in `AMMO_EFFECT_FIELDS`, never instead of it: the two answer different questions (which load, which cartridge) and a build that swapped one for the other cost `dualPurpose` its identity for a day — see §6, 2026-08-09 |
| `caliber` | the cartridge in the chamber — **the pattern flow's input** | seam shim, from the loaded ammo's `caliber`, falling back to the weapon's own `ammoType` |
| `armorMultSoft`, `penDamageMult`, `spreadMode`, `dotType`, … | the loaded ammo's mechanics | seam shim, from the loaded ammo item |

Two target fields exist on purpose. `targetTokenId` decides whether the damage window opens
mid-action; `fxTargetTokenId` only says which way the shot was pointed. Folding them together would
silently move every single-shot and burst card onto the mid-action damage path, which the user
explicitly did not want.

### 1.1a Two resolution flows, and the one question that chooses between them

One payload is resolved by **exactly one** of two flows, and they never overlap:

```
   cyberpunk2020.weaponFired  ── payload ──▶  spreadFlowModeOf(payload)   (module/lookups.js)
                                                        │
                    ┌───────────────────────────────────┴────────────────────────────┐
                    │ "single"                                                       │ "buck" / "flechette"
                    ▼                                                                ▼
   SINGLE-TARGET FLOW                                          PATTERN FLOW
   damage-hooks.js _hookWeaponFired                            damage-hooks.js _hookSpread
   · one target, resolved by hit location                      · a ray from the shooter, width + damage by range band
   · DamageDialog, or the card's Apply button                  · EVERYONE in the path, no evasion (CP2020 p.108)
   · waits on presentationSettled()                            · GM aims a GM-only zone, then ONE Confirm card
                                                               · confirm applies, posts one result card, scatters
                                                                 the burning load's fires down the
                                                                 path, deletes the zone
```

Since 2026-08-09 there is a **third** caller of that same question and it is on the presentation side:
`patternFlowOwns(payload)` in `fx/effects.js`, which decides whether the fan-out draws the burning
ground or leaves it to the pattern's own confirm.

All three ask **one shared site**, `spreadFlowModeOf(payload)` in `module/lookups.js`, so they cannot
answer differently. That site is `spreadModeForAmmo` — what the *round* is — plus the pattern's world
switch, which is what the module will *do* with it:

```
spreadModeForAmmo(fields)   what the ROUND is        (the caliber rule above — nothing else)
        └── spreadFlowModeOf(payload)   what the MODULE DOES with it   ← the one site all three ask
                 · pattern switched ON  → the derived mode stands
                 · pattern switched OFF → "single": no flow places a pattern, so the ordinary
                                          single-target flow owns every shell, exactly as it
                                          already owns the slug
```

⏪ **The switch used to be read only by the pattern hook, and that was a defect, not a design.** With
the pattern off, the single-target gate stood down because the cartridge derived to `buck` and the
pattern hook stood down because the setting said no — so a shell payload was claimed by **neither**
flow: no apply window, no pattern, no damage. Folding the switch into the shared answer makes "off"
mean what a reader expects, and the presentation follows for free — with the pattern off, an incendiary
shell's burning ground is drawn by the fan-out again, because the confirm that would otherwise have
scattered those fires down the path never happens.

The two damage gates are literally the same call (`_spreadModeOf(payload)`, twice), which is the whole
guarantee: if they ever disagreed, a shell would be damaged **twice** — once by the dialog and once by
the pattern — or not at all. A keeper leg counts the call sites; another asserts the damage rail reads
the world setting **nowhere** of its own.

**The question is asked of the CARTRIDGE, not of a flag.** The shotgun is an area weapon in the Core
rules; buckshot patterns because of what it is. Every shotgun ammo item ever seeded carries
`spreadMode: "single"` (the ammo-modifier seeder's default), so a rule that read the stored field
would have made the book behaviour reachable only by hand-editing every ammo item in every world.
Deriving it at fire time means an untouched world's buckshot fires the pattern on its next shot, with
no migration and no re-seed. The four cases, in decision order:

| Input | Result |
|---|---|
| the `slug` load (by `spreadMode: "slug"` **or** by modifier id) | `single` — the one shotgun load that is a single projectile |
| any other explicitly declared non-single mode (`flechette`) | that mode, unchanged |
| a caliber that is not shotgun-family — **including blank or unknown** | `single` (safe default: no cartridge recorded, no pattern) |
| anything left: a shotgun-family caliber | `buck` |

**The cartridge is recorded under two different names**, and the seam resolves both: an *ammo* item
stores the round it **is** in `system.caliber`; a *weapon* stores the round it **takes** in
`system.ammoType` — the base system's own field, and the only one its weapon schema has (a `caliber`
written to a weapon is dropped). Every shell weapon in the shipped catalogue records a gauge there and
nothing anywhere else, so without the second reading a shell fired on free fire, or from a weapon never
reloaded, would report no cartridge at all and throw no pattern.

### 1.2 What runs where

`cyberpunk2020.weaponFired` is a **local** `Hooks.callAll` — it fires only on the client that resolved
the shot. Each element reaches the other clients differently:

| Element | Transport | Notes |
|---|---|---|
| Shot audio | `AudioHelper.play(..., true)` broadcast | interface channel, so each player's own slider governs it |
| Muzzle **light** | the module's own socket channel, drawn locally by every receiver | no document is written |
| Sprites (lance, column, tracer, impact, smoke, ground fire) | Sequencer's own socket | |
| Face-target turn | an ordinary token document update | **the only document write on this rail** |

### 1.3 Dependency policy

Sequencer and JB2A are **optional**. Sprite verbs no-op silently when they are absent; the muzzle
light and the audio are native and always work. An asset key that the *installed* JB2A tier does not
carry is skipped, never played — `fxDbEntryExists()` is the gate, and every key on the rail passes
through it. All shipped keys are chosen from the **free** tier and are pinned by a keeper leg.

---

## 2. Element reference

Everything one trigger pull can put on screen, in the order it appears.

| # | Element | Asset / mechanism | Gate | Above lighting? |
|---|---|---|---|---|
| 1 | **Face-target turn** | token document `rotation` update, 220 ms sweep | table setting **and** token not `lockRotation` **and** turn ≥ 5° | n/a |
| 2 | **Muzzle light** | native `PointLightSource`, built and driven per render frame | always (native) | it *is* a light — clips to walls |
| 3 | **Muzzle lance** | `jb2a.muzzle_flash.single.01.yellow`, trimmed to 110 ms | row names `muzzle` (every class **except** the shell) | yes |
| 4 | **Spark star** | `jb2a.impact.006.yellow` | row names `spark` — **no shipped row does** | yes |
| 5 | **Discharge column** | `jb2a.bullet.02.orange`, stretched 1.25 sq, trimmed **55 ms**, dwelt **220 ms** | row names `column` (shell only) | yes |
| 6 | **Tracer / pellet fan** | `jb2a.bullet.01/02.orange`, or an ammo's own round (`rubber`/`stundart` → `jb2a.throwable.launch.cannon_ball.01.black`) | row names `tracer` | yes |
| 7 | **Mote spray** | `jb2a.impact.006.yellow` at speck size | row names `motes` **and** payload is multi-round | yes |
| 8 | **Smoke puff** | `jb2a.smoke.puff.side.grey` | row names `smokeSingle` **and** payload is *single*-round | **no** (smoke does not glow) |
| 9 | **Hit confirmation** | `jb2a.impact.005.orange`, or one of three promoted keys (fire · ground crack · **dust puff**) | the round **hit**, and the row has `impactSquares` | yes |
| 10 | **Burning ground** | `jb2a.flames.orange.03.1x1` (Flames03, a 05x05ft ground plate), 0.9 sq, **45 s**, one flame per landing point | overlay names `groundFire` **and** ≥ 1 round landed **and** the single-target flow owns the payload — **one placement event per payload** | yes |
| 11 | **Scorch** | `jb2a.scorched_earth.black` | with #10 — **one** mark at the flames' centroid, however many flames | **no** (a black mark is not a light) |
| 12 | **Blood splash** | `jb2a.liquid.splash_side02.red`, trimmed to 900 ms, **rotated to the exit vector** | the world setting **and** the round landed **and** there is a target token **and** that token's actor is not structure — **one per landing round**, capped at 4 | **yes** — a deliberate departure, below |

**The above-lighting rule.** Anything that *emits* light is routed above the lighting layer; anything
*lit by the world* stays below it. This is not cosmetic: measured on the rig at darkness 1.0, a sprite
left in the primary group crushes to a peak of 15/255 whatever the class or filter, and the same asset
reaches 232 the moment it is routed up. **The cost:** that route is above the *vision* mask too, so a
lifted sprite is drawn across ground the viewer cannot see. The engine offers no route that clears the
darkness and keeps the mask. The muzzle light is unaffected — it is a real light source and still
clips to walls, so the flash stays honest about the room even when the bolt is drawn over it.

**Where the burning ground goes (#10), which is the whole of the 2026-08-09 redesign.** A fire is put
where the *rounds* went, never on the target, and neither answer is invented:

| The class draws | Landing points are | Bound |
|---|---|---|
| a **pellet fan** (the shell; any class under a `flechette` load) | a subset of the very endpoints the tracer fans to, picked evenly across the cone | `maxPerPayload` = 4 |
| **one bolt** (every other class) | one point per landed round, scattered inside a 0.8-square disc around the aim — the payload says how many rounds landed and never where, so the disc is an admission rather than a claim | `maxPerPayload` = 4 |
| a **shot pattern** (buckshot, RAW) | scattered inside the pattern polygon, beyond its first 30 %, placed when the GM **confirms** | `maxPerPattern` = 5 |

The scatter is **seeded off the payload** (`fxSeedOf` → `seededRng`), so two clients computing it agree
and a test can compute it twice. Across bursts a scene holds at most **`maxLive` = 24** flames; a
placement that would exceed it ends the **oldest** first, through the engine's own manager, which
relays the end to every client exactly as the placement was relayed.

**How the blood splash is aimed and how often it is drawn (#12), rebuilt 2026-08-09.** Both halves
of this were reversed on report and both reversals are recorded in §6.

*Direction.* The first build used `liquid.splash02.red` precisely **because** it is radial — its ink
centroid holds at 0.50/0.51 of its own frame from 170 ms to 510 ms, so it needed no rotation and could
never disagree with the shot axis. That safety is what made it wrong: a radial burst says the wound has
no direction. The shipped asset is now `liquid.splash_side02.red`, whose ink **traverses** its own frame
0.29 → 0.65 left-to-right, and it is rotated (`rotateTowards`, the tracers' own call and the tracers'
own basis) at a point **one grid unit beyond the target on the shooter→target ray**. The spray therefore
continues the round's line and leaves on the far side, as an exit. A shot with no shooter — nothing on
the rail draws one today, but the verb is callable — falls back to a random rotation rather than to a
baked heading, because a wrong direction is a worse lie than none. Capture 64a.

*How many.* One spray per **landing round**, not one per payload, capped at `maxPerPayload` = **4**.
The cap is measured rather than picked: the clip lives 900 ms and hits are the leading rounds of the
burst, so at the default 80 ms cadence ten hits would put ten sprays inside one clip's life — a fountain
rather than a body being hit repeatedly. Four are still four distinguishable arrivals, each still on
screen when the next lands. A round the pacing rule **refuses** (§4.1a) draws no spray either; the spray
is issued from inside the round's own draw block, so the two can never disagree. Capture 64b.

**The one departure from that rule is the blood splash (#12).** Blood is not a light source, so the
rule as written puts it below — and on the rig's own dark range that is not a dimmer effect, it is no
effect (capture 58d is the same splash routed below, and there is a smudge where there should be a
mark). The trade is therefore between an element invisible exactly where a table plays and an element
drawn over ground the viewer cannot see, and the second is the lesser cost *here only*, because this
element lives for under a second where the scorch that took the other side of the trade lives for
minutes. It is a knob (`BLOOD_SPLATTER.aboveLighting`), not a constant in the draw path.

---

## 3. The tables

### 3.1 Weapon classes — `FX_CLASSES`

Resolution is by weapon **type**, never by item name. Shotgun-ness is read from the *attack* type
(`Shotgun` / `Autoshotgun`) **before** the type map, because base data types shell weapons as `Rifle`
so they take the Rifle skill.

| Class | Tracer | Muzzle | Impact (sq) | Cadence | Distinctive |
|---|---|---|---|---|---|
| `pistol` | bullet.01 | 1.1 sq lance | 0.70 | 80 ms | 8 motes |
| `smg` | bullet.01 | 1.2 sq lance | 0.75 | 80 ms | 12 motes |
| `rifle` | bullet.02 | 1.6 sq lance | 0.95 | 80 ms | 13 motes |
| `shotgun` | bullet.01, `tracerColor: null` | **no lance** | 1.15 | **180 ms** | 6 pellets @ 0.07 rad, 1 sq dashes crossing in 150 ms, discharge column, single-shot smoke |
| `heavy` | bullet.02 | 2.1 sq lance | 1.30 | 80 ms | 16 motes |

Sizes are in **grid units**, not scale factors — the same fraction of a square on any scene.

Optional row fields: `pellets`, `spreadRad`, `dashSquares`, `dashMs`, `cadenceMs`, `soundBurst`,
`spark`, `tracerColor`, `column`, `columnColor`, `motes`, `smokeSquares`, `smokeSingle`, `muzzleMs`,
`impactKey`, `impactClipMs`. A row that omits one simply does not get that treatment; **no branch
anywhere in the file names a specific class.**

**Omitted is not the same as `null`.** For the two recolour fields the difference is load-bearing:
omitting the field means "this class has no such element, and no overlay may give it one"; `null` means
"the element exists and is repaintable, and the class paints it with nothing". The shell row uses
`tracerColor: null` so that ordinary buckshot carries no colour shift while an ammo overlay reaches the
pellets. See §3.2.

### 3.2 Ammo overlays — `AMMO_FX`

Keyed by the loaded ammo's `system.modifier` (lookups.js `AMMO_MODIFIERS`). The overlay is merged over
the class row; ammo that names no row draws exactly what the class drew before this table existed.

The **Tracer/column** column below means every element the class *declares* as repaintable. On the four
single-bolt classes that is the bolt. On the shell it is the discharge column **and the pellet fan** —
both, always, and with the same shift.

| Modifier | Tracer/column | Impact | Impact width | Fan | Light | Ground |
|---|---|---|---|---|---|---|
| `standard`, `brassCased` | — | — | — | — | — | — |
| `api` | red-shifted (hue **−14**, sat +0.30, bright 1.20) | **class default** ⏪ | class | — | **tinted `#ff6a1a`** (dark only) | fire + scorch |
| `ap` | near-white (hue 8, sat −0.85, bright 1.45) | ground crack | class | — | — | — |
| `dualPurpose` | *identical to `ap`* | ground crack | class | — | — | — |
| `hollowPoint` | — | — | **× 1.60** | — | — | — |
| `safety` | — | — | **× 0.55** | — | — | — |
| `flechette` | — | — | × 0.70 | **8 darts @ 0.10 rad, 1.1 sq, 170 ms** | — | — |
| `rubber` | **the round is a different asset** — `cannon_ball` slug, travelled 2.4 sq / 240 ms; repainted colourless-but-brighter (hue 0, sat −0.85, **bright 1.30**) | **dust puff** | class | count/spread unchanged, size and speed replaced | — | — |
| `stundart` | *identical to `rubber`* | **dust puff** | class | *as `rubber`* | — | — |

Arrow loads (`broadhead`, `spinner`, `target`) have no rows: there is no bow FX class yet.

**Two rules govern the merge** (`ammoFxEntry`):

1. **Repaint, never add** — and since 2026-08-09, **re-picture, never add** with it. Two masked lists,
   one rule: `AMMO_FX_RECOLOR_FIELDS` (`tracerColor`, `columnColor`) is *what colour an element is*, and
   `AMMO_FX_REPLACE_FIELDS` (`tracer`, `column`) is *which picture it is*. Both are applied *only where
   the class row already **carries the key***. The test is key presence (`=== undefined`), not
   truthiness, so a row may carry `null` and mean "repaintable, painted with nothing". Four outcomes,
   one rule, no class named anywhere:

   | Case | Row says | Result |
   |---|---|---|
   | ordinary shell | `tracerColor: null` | no shift on the fan — the settled buckshot look |
   | incendiary shell | overlay supplies the shift | discharge column **and** pellet fan both red |
   | incendiary rifle | row carries `tracerColor` | the single bolt it actually draws is red |
   | incendiary pistol | no `column`/`columnColor` key at all | gains no column |

   ⏪ The earlier form of this rule left `tracerColor` *off* the shell row, which kept the fan untinted
   under every load. The user superseded that for ammo overlays (§6); the base look is unchanged.

   ⏪ The mask was widened from colour to asset on 2026-08-09, when the baton treatment became the first
   overlay to say the round with a different *file*. Nothing shipping changed behaviour — every class
   declares `tracer`, and no overlay names `column` — but `column` can no longer become a way to hand a
   pistol a shotgun's discharge blast, which was one bare overwrite away.
2. **`impactScale` is a multiplier, never a width.** An absolute value would flatten the classes into
   one size; the table steps the impact from 0.70 (pistol) to 1.30 (heavy) precisely because a heavy
   round lands harder. A hollow-point should be wider *than its own class*. The multiplier is spent
   during resolution and removed from the result, so the draw path only ever sees an ordinary row.

Resolved widths, for reference:

| | pistol | smg | rifle | shotgun | heavy |
|---|---|---|---|---|---|
| base | 0.70 | 0.75 | 0.95 | 1.15 | 1.30 |
| `hollowPoint` | 1.12 | 1.20 | 1.52 | 1.84 | 2.08 |
| `flechette` | 0.49 | 0.525 | 0.665 | 0.805 | 0.91 |
| `safety` | 0.385 | 0.4125 | 0.5225 | 0.6325 | 0.715 |

`rubber` / `stundart` no longer appear in that table: they carry no `impactScale` at all and land at the
class's own width. ⏪ They used to sit at × 0.60. A blunt round does not make a *smaller* mark than a
bullet, it makes a *different* one, and shrinking it was the same "say it with less" reflex the 2026-08-09
ruling rejected — see §6.

### 3.2a The shot pattern's own look — `SPREAD_ZONE_LOOK`

`module/combat/spread-zone-look.js`. The pattern zone is a canvas object rather than a sprite, so its
appearance is not the effect engine's business — but it is the same kind of fact and it lives in the
same kind of block: one frozen object, no branch anywhere else.

| Value | Ships as | What it is |
|---|---|---|
| `fillColor` | `#ffaa00` | the wash, and the region document's own `color` |
| `outlineColor` | `#cc6600` | the drawn edge |
| `fillAlpha` | **0.10** | against core's own **0.5** — the user's "near-transparent … you can read tokens and shots through it" |
| `hatch` | **false** | core's diagonal bars are opaque, so they are the half that actually occludes |
| `outlineWidth` / `outlineAlpha` | 2 px × ui scale / 0.85 | thin and nearly solid: the inverse of the fill, and what carries the shape |

⚠ **Core gives the document no way to say any of this.** A v14 Region carries `color` and `visibility`
and no opacity of any kind: its highlight is a `RegionMesh` whose alpha is assigned the literal `0.5`
inside the placeable's own `_draw`, and whose hatch is switched back **on** by `_refreshState` on every
refresh. So the treatment is applied to the drawn object, on both `drawRegion` and `refreshRegion`,
for regions carrying our `isSpreadZone` flag and no others. The outline is ours for the same reason:
core's own region border is bound to interaction (`controlled || hover || layer.highlightObjects`), so
an unhovered region on a non-active layer has no edge at all, and a 0.10 fill with no edge is not
"ghost", it is "gone". A keeper leg asserts **core's** 0.5-and-hatched values on an untouched region
first, so a core release that changes them fails by name rather than leaving us tuning against
something that already moved. Captures **60a** (ours) and **60a-control** (core's, same region).

### 3.3 How the load is identified

`ammoFxKeyOf(payload)`:

1. **The id, if the payload has one** (`payload.modifier`). This is the design. It also settles a case
   nothing else can: `ap` and `dualPurpose` carry *byte-identical* mechanics, so no amount of looking
   at the consequences distinguishes them.
2. **A fingerprint of the mechanics, only when there is no id** — a compatibility path for payloads
   emitted before the field existed.

| Load | Fingerprint |
|---|---|
| `api` | `dotEnabled && dotType === "fire"` — the only fire damage-over-time in the registry |
| `flechette` | `spreadMode === "flechette"` |
| `safety` | `armorMultSoft === 2 && penDamageMult === 3` |
| `hollowPoint` | `armorMultSoft === 2 && penDamageMult === 1.5` |
| `stundart` | `stunSaveOnHit && stunSaveMod === -2` |
| `rubber` | `stunSaveOnHit && stunSaveMod === 0 && penDamageMult === 0.5` |
| `ap` | `armorMultSoft === 0.5 && penDamageMult === 0.5` |

Order matters where loads overlap: `api` is tested before `ap` (api's armour multipliers *are* ap's);
`stundart` before `rubber`. The `penDamageMult` term on `rubber` is not decoration — a warhead's own
fields include `stunSaveOnHit: true, stunSaveMod: 0`, so the pair alone would paint every grenade with
the baton-round treatment. **Known limit:** without an id, `dualPurpose` collapses onto `ap`.

---

## 4. The sequencing contract

### 4.1 One payload

```
faceTarget()                       ← awaited; the rounds start from a token already pointed
fxBurstAmbience()                  ← once, multi-round payloads only (mote spray)
fxGroundFire(points)               ← ONE placement, N flames, incendiary + at least one hit +
                                     the single-target flow owns the payload; NOT awaited
fxBloodSplatter()                  ← once, gore on + a hit + a flesh target token; NOT awaited
for each round i of shots:
    sleep until t0 + i×cadence      ← the ONE wait, and it is ANCHORED (§4.1a)
    if this round is too late:     ← DROP it entirely and go to the next
        continue
    sfx()                          ← audio
    fxSmokePuff()                  ← single-discharge classes only; NOT awaited
    fxShot()                       ← light + sprites + tracer + impact; NOT awaited
    fxBloodSplatter()              ← landing rounds only, up to the cap; NOT awaited
_watchSettleTag(settleTag, presentationTailMs(class, ammo))
```

Everything a round draws starts in the **same tick** as that round's audio. Nothing in this path waits
on a server. Rounds are capped at `MAX_FX_SHOTS` (30).

Hits are assigned to the **leading** rounds of the burst: the payload knows how many rounds landed,
not which, and inventing an order would be inventing a fact.

**A ruled fumble draws nothing at all** — no light, no sprite, no tracer, no impact, no audio. The gate
is `payload.fumbleRuled` (the base actually resolved a fumble), *not* a natural 1: with the fumble
table switched off a natural 1 is an ordinary bad roll and the weapon really did fire.

### 4.1a Pacing: an anchored schedule, and a late round dropped rather than queued

**The report.** Animations ran in slow motion, queued behind the audio, and went on arriving after the
shooting had stopped — worst on the heavy multi-sprite payloads (flechette's 8 darts a round, the
shell's column plus fan).

**The mechanism, measured on the rig 2026-08-09 rather than reasoned about.** The loop paces by the
wall clock while everything it queues is drawn by the render loop. The old loop waited a **fixed**
`cadenceMs` each iteration, so every millisecond a round's timer fired late was *added* to the next
round's start instead of being absorbed — the error compounded, without bound:

| Rounds (shell, 180 ms cadence, flechette) | Intended | Measured before | Ratio |
|---|---|---|---|
| 5 | 720 ms | 1 534 ms | 2.13× |
| 10 | 1 620 ms | 3 630 ms | 2.24× |
| 20 | 3 420 ms | 7 617 ms | 2.23× |
| 30 | 5 220 ms | **11 681 ms** | **2.24×** |

The obvious suspect is wrong, and it changes the fix: **building a round's Sequence is cheap** —
`fxShot`'s synchronous cost measured at a median of **1 ms**. The lateness is the loop's own
`setTimeout` being starved while the engine draws what earlier rounds already queued (the same run
measured the canvas at 5 FPS with 421 effects live). No amount of making the round body cheaper touches
it; the loop has to stop trusting that its sleep slept for the time it asked for.

**Half one — the schedule is anchored.** Round *i* is due at `t0 + i × cadence` (`roundDueAtMs`), and the
loop sleeps only the **remainder** to that instant. A round that ran late no longer pushes its
successors: lateness is measured fresh each round against a fixed origin instead of accumulating.

**Half two — a round that still cannot start on time is DROPPED, not queued.** User ruling 2026-08-09,
verbatim reason: *"the audio already told the ear the story."* The round goes **entirely** — its audio
with its picture. The first build of the rule kept the audio and refused only the sprites; the rig
refused that reading by measurement, because a starved loop reaches several slots at once and keeping
the audio put two and three reports in a single tick (measured gaps of **231, 0, 235, 0 ms** across one
five-round burst). Dropping the round outright leaves the rounds that *do* play sitting on their own
slots — the burst keeps its rhythm at the cost of a round, rather than losing the rhythm to keep one.

**The threshold is half a slot** (`FX_DROP_LAG_FRACTION` = 0.5 → 40 ms at the default 80 ms cadence,
90 ms at the shell's 180 ms), and it is a **fraction rather than a flat figure** for a reason the
arithmetic settles. The gap between two rounds that both get drawn is `cadence − (how late the earlier
one was)`. A flat 150 ms shipped first — and the rig refused it on the second run, at the default
cadence, with gaps of **256, 1, 256 ms**: a round drawn 150 ms behind its slot is already past the next
round's slot, so the two are drawn together. At half a cadence no round is ever drawn more than half a
slot late, and therefore **no two drawn rounds are ever closer together than half a cadence**. That is a
property of the arithmetic, not of the host, and a keeper leg pins it at every cadence the table ships.

**⛔ The last round is never dropped**, however late. It carries the settle tag, so the completion signal
is always named on an element that is certain to be drawn — which is what makes retagging machinery
unnecessary and what stops the apply window ever waiting on a refusal.

**What it costs a healthy client: nothing.** Timer lateness on a client that is keeping up is a frame or
two, well inside 40 ms, and a keeper leg drives a ten-round burst with the threshold held out of reach
and asserts `dropped === 0`. The rule is also self-correcting, which is what actually retires the
report: dropping late rounds removes exactly the queued work that was starving the timer.

**Measured after, same host, same payloads:**

| Rounds | Intended | After | Drift |
|---|---|---|---|
| 5 | 720 ms | 785 ms | +65 ms |
| 10 | 1 620 ms | 1 797 ms | +177 ms |
| 20 | 3 420 ms | 3 639 ms | +219 ms |
| 30 | 5 220 ms | **5 309 ms** | **+89 ms** (was +6 461 ms) |

The fan-out reports `dropped`, `maxLagMs` and `loopMs` on its result, so the pacing is readable rather
than inferred. `_setDropLagMs(ms)` is a test seam for an absolute threshold; nothing ships with it armed.

**One knock-on, and it was a real bounding defect.** The faster hand-over exposed a race in the burning
ground's scene cap: the cap read `liveGroundFires()`, but the engine does not create an effect until its
own play resolves, so two placements issued inside that beat both read the same number and both
under-evicted — eight bursts left **28 flames alive against a cap of 24**. Flames now queued but not yet
created are counted too (`pendingGroundFires`), which makes the cap hold rather than approximately hold.

### 4.2 The tail, and when the damage window may open

The damage window waits for the rail. Three routes, and each reports which one it took:

| Route | When | Value |
|---|---|---|
| `signal` | normal — the engine reported the last round's terminal elements gone | measured |
| `arithmetic` | no fan-out registered (rail off, unmapped weapon, nothing drawn) | `payloadPresentationMs()` |
| `cap` | the signal never arrived | `PRESENTATION_CAP_MS` (8 s) |

The **terminal elements** are the last round's tracer and impact; only they are named for the engine to
report on. The scheduled tail is the *floor* (never open early) and the fallback.

**A watch now always ends.** Both of the watch's original exits require a count to be right — the
scheduled fallback fires only when *nothing* was created, and the engine exit only when `ended` catches
`created` — so a watch whose elements were created but never all reported gone satisfied neither and sat
in the maps for the rest of the session. Measured: five overlapping 30-round fan-outs left **2 of 5**
watches unresolved and still holding their payloads fifteen seconds after everything had left the
screen. The apply window was never at risk (`presentationSettled` always races the cap), but the
bookkeeping grew without bound. A hard stop on the **same** `PRESENTATION_CAP_MS` the window already
honours now drops the entry; because any waiter has already taken the capped answer by then, it cannot
change what a caller observes. Note that a 30-round shell burst legitimately runs past that cap on a
slow client — 5.2 s of firing plus its tail — and opens the window at the ceiling; it did so far harder
before this unit, when the same burst ran 11.7 s.

`presentationTailMs(class, ammoKey)` — the longest of: light envelope · lance dwell · spark clip ·
tracer end (travelled: `dashMs + 260`; painted: 933) · impact end (`dashMs + impactClipMs`) · **column
dwell** (220 ms — the time the column is on screen, *not* the 55 ms of clip its trim admits; reading
the trim here would under-count that element four-fold). Shipped values:

| Class | tail (standard) | tail (`flechette`) | tail (`api` / `ap`) | tail (`rubber` / `stundart`) |
|---|---|---|---|---|
| pistol / smg / rifle / heavy | 933 ms | 1003 ms | 933 ms | **1073 ms** |
| shotgun | 983 ms | 1003 ms | 983 ms | **1073 ms** |

The baton pair is the one overlay that genuinely *moves* the window, and it must: it hands every class a
240 ms crossing time (`240 + 833`), against the flechette's 170 and buckshot's own 150. A keeper leg pins
1073 by the arithmetic on all five classes. Its **impact** promotion is free in the usual way — the dust
puff's own 1067 ms clip is trimmed to the ordinary 833 ms, so the whole move is the crossing.

**Deliberately *not* in the tail:** burst smoke, mote spray, burning ground, scorch, **blood splash**.
They are scene dressing that lingers on purpose; waiting for them would hold the damage window shut for
seconds after a viewer has already called the action over. The exclusion is structural rather than a
flag — none of them is given a settle name, and `presentationTailMs` takes no term for any of them, so
no setting and no ammo can pull one into the wait. A keeper leg pins the tail across every class with
the gore switch both ways.

**An impact promotion changes the mark, not the clock.** The two promoted assets are 2267 ms (fire) and
5033 ms (crack) against the ordinary impact's 833 ms. Every impact is played through
`timeRange(0, impactClipMs)`, defaulting to the ordinary impact's own length — so a promotion is free
in the dimension the user is sensitive to. What is given up is each asset's trailing fade; on
incendiary that loss is covered by the burning ground, which goes on burning where the rounds fell
for three quarters of a minute.

**Any overlay that moves a tail input must be threaded into the tail.** `flechette` gives a class a
crossing time it did not have; `impactClipMs` changes how long the mark is drawn. Both are read
through the same resolver the draw path uses, so they cannot drift. The failure mode if they ever do
is silent and one-directional: the window opens while the last round is still on screen.

### 4.3 The darkness gate

The muzzle light's **colour** is chosen from the viewed scene's darkness, read fresh per flash:

| Scene darkness | Colour |
|---|---|
| ≥ 0.25 | the loaded round's `flashColor` if it has one, else `#943400` |
| < 0.25 | **null** — core removes the coloration layer from the render entirely |

This is not an opacity. `hasColor` is set from `data.color !== null`, so a null colour takes the layer
out of the render (`layers.coloration.active === false`). The gate is inviolable and the ammo tint is
passed *through* it, never around it: below the threshold `flashColorFor()` has already returned null
before the ammo is consulted. The reason is measured — a coloured source moves **44.8%** of a lit
frame's pixels on this core, where the uncoloured one moves 0.2%.

---

## 5. Tune-knob index

Everything worth changing, and what it does. All in `module/fx/effects.js`.

| Knob | Ships as | Changes |
|---|---|---|
| `SHOT_CADENCE_MS` | 80 | default spacing between rounds |
| `MAX_FX_SHOTS` | 30 | per-payload fan-out cap |
| `FX_DROP_LAG_FRACTION` | **0.5** | how late a round may be before it is dropped, as a share of its own slot (§4.1a). 0 drops nothing — anchoring alone, which measurably bunches. ⏪ the earlier flat figure was **150 ms**, which does not hold the separation guarantee at any cadence we ship |
| `MUZZLE_MODE` | `"cone"` | flash shape: `cone` / `omni` / `hybrid` |
| `MUZZLE_LIGHT.coneDegrees` | 270 | wedge width (a 90° notch behind the shooter) |
| `MUZZLE_LIGHT.luminosity` | 0.65 | flash strength — **raised from the reference's 0.5 on request** |
| `MUZZLE_LIGHT.referenceColor` | `#943400` | dark-regime colour (`#ffae42` is the earlier warm option) |
| `MUZZLE_LIGHT.darknessColorThreshold` | 0.25 | where the colour regime switches |
| `MUZZLE_LIGHT.brightSquares` / `dimSquares` | 12.5 / 12.5 | equal on purpose — attenuation does *all* the falloff |
| `MUZZLE_SPRITE.endMs` | 110 | lance trim — beyond this the clip's smoke-and-fire plume returns |
| `MUZZLE_SPRITE.edgeFraction` | 0.5 | how far along the aim the sprite is planted, as a fraction of token width |
| `FACING_AIM_SQUARES` | 3 | how far the synthesized aim point sits for an untargeted shot |
| `COLUMN_SQUARES` | 1.25 | discharge column reach, in grid units from the shooter's edge |
| `COLUMN_TRIM_MS` | 55 | **which frames of the column clip exist** — under every excluded phase (§6) |
| `COLUMN_DWELL_MS` | 220 | **how long those frames take to play** — delivered as `columnRateFor()` = 0.25 |
| `DASH_ARRIVAL_HOLD_MS` | 260 | how long a travelled pellet lives after arriving |
| `TRACER_CLIP_MS` | 933 | painted tracer's on-screen life (upper bound of the mapped families) |
| `TRACER_COLOR` | hue 18, sat −0.35, bright 1.15 | the class colour shift |
| `TRACER_COLOR_INCENDIARY` / `_HARDENED` / `_BATON` | see §3.2 | the ammo colour shifts. ⏱ incendiary eased 2026-08-09, hue −20 → **−14**; ⏪ the revert value **−20** is recorded at the site, saturation and brightness unchanged |
| `TRACER_COLOR_INERT` | hue 0, sat −0.55, bright 0.60 | ⏪ **retired from use** — the rejected darkening; declared, on no shipped row |
| `BATON_ROUND` | `throwable.launch.cannon_ball.01.black`, 2.4 sq frame, 240 ms crossing | the whole less-lethal representation, in one block |
| `IMPACT_FIRE` / `IMPACT_CRACK` / `IMPACT_DUST` | keys + measured clip lengths | the promoted impacts |
| `AMMO_FX_RECOLOR_FIELDS` / `AMMO_FX_REPLACE_FIELDS` | colour pair / asset pair | which overlay fields may only repaint an element the class already declares |
| `GROUND_FIRE.key` | `flames.orange.03.1x1` | **which picture the fire is** — the whole of the rejected/shipped decision |
| `GROUND_FIRE.squares` | 0.9 | one flame's drawn width in grid units (0.5 reads as a spark, 1.6 as a bonfire) |
| `GROUND_FIRE.lifetimeMs` | **45000** | how long a flame burns — the "stayed burning" call |
| `GROUND_FIRE.fadeOutMs` | 2500 | the burn-**down** at the very end (5.6 % of the life; the rejected build spent 28 % fading) |
| `GROUND_FIRE.scatterSquares` | 0.8 | radius of the landing scatter when the class gives no per-round geometry |
| `GROUND_FIRE.maxPerPayload` | 4 | the most flames one payload may place |
| `GROUND_FIRE.maxPerPattern` | 5 | the most flames one confirmed shot pattern may scatter |
| `GROUND_FIRE.maxLive` | 24 | the most flames alive on a scene at once — oldest evicted first |
| `GROUND_SCORCH.lifetimeMs` | 180000 | the scorch's cap — **minutes, not forever** |
| `BLOOD_SPLATTER.key` | `jb2a.liquid.splash_side02.red` | the splash asset — **natively blood-coloured, no filter is applied**; the SIDE (directional) cut, rotated to the exit vector. ⏪ the radial `splash02.red` is still on the tier |
| `BLOOD_SPLATTER.maxPerPayload` | 4 | the most sprays one payload may draw — repeated spray, never a fountain |
| `BLOOD_SPLATTER.squares` | 1.5 | the drawn **frame** width in grid units; the ink is ~0.75 sq at 170 ms, ~1.3 sq at peak |
| `BLOOD_SPLATTER.clipMs` | 900 | the trim — content is spent by ~700 ms of an 1133 ms file |
| `BLOOD_SPLATTER.aboveLighting` | `true` | the documented departure from the routing rule (§2) |
| `goreEnabled` (world setting, `module/settings.js`) | default `false` | the blood master switch — config-visible, fail-closed reader; every splash gate reads it |
| `shotgunSpreadEnabled` (world setting) | default `true` | the pattern master switch — read ONLY inside `spreadFlowModeOf` (§1.1a); off ⇒ shells take the single-target flow |
| `MUZZLE_SMOKE.*` | see the block | one puff's size, phase, drift and cap |
| `MUZZLE_MOTES.*` | see the block | speck geometry, all off the reference frame |
| `PRESENTATION_CAP_MS` | 8000 | hard ceiling on how long the damage window may be held |
| `APPLY_LEAD_MS` | 150 | how far ahead of the engine's report the window may open |
| `SETTLE_CONFIRM_MS` | 60 | how long "all ended" must hold before it is believed |
| `FACE_TARGET.durationMs` / `minDegrees` | 220 / 5 | the turn sweep and its dead zone |

Test/capture seams (**nothing ships with one armed**): `_setFlashLevels`, `_setDashMs`,
`_setSpriteRate`, `_setDbProbe`, `_setSoundManifest`, `_setDropLagMs`.

**The shot pattern's knobs**, which are not in `effects.js` because the pattern is not a sprite:

| Knob | Ships as | Changes | Where |
|---|---|---|---|
| `SPREAD_ZONE_LOOK.*` | see §3.2a | the whole ghost treatment | `module/combat/spread-zone-look.js` |
| `SPREAD_ZONE_TTL_MS` | 60000 | how long an **unconfirmed** pattern lives outside an encounter | `module/combat/damage-hooks.js` |
| `SPREAD_ZONE_SWEEP_MS` | 15000 | how often the out-of-combat sweep looks | `module/combat/damage-hooks.js` |
| the band table | 1/2/3 m, 4d6/3d6/2d6 | width and damage by Close / Medium / Long — Core defaults, overridden per ammo item | `_placeSpreadZone` |

---

## 6. Rulings log

Dated decisions, mined from the supersession chains in the code. Values and *why*, never change
history. ⏪ marks a decision that reversed an earlier one.

**2026-08-09 — the pacing unit.**

| Ruling | Value | Why |
|---|---|---|
| A round that cannot start on its slot is **dropped, not queued** | `FX_DROP_LAG_FRACTION` 0.5 | User, verbatim: *"the audio already told the ear the story."* The fan-out paced by wall clock against a render loop, with a fixed per-round sleep, so timer lateness compounded — a 30-round shell burst measured **11 681 ms against an intended 5 220 ms (2.24×)**. Anchoring the schedule plus dropping the late rounds brings the same burst to **5 309 ms (+89 ms)**. §4.1a |
| The drop takes the round's **audio** too | — | ⏪ The first build kept the audio and refused only the picture. A starved loop reaches several slots at once, so keeping the audio put two and three reports in one tick — measured gaps of **231, 0, 235, 0 ms**. The rhythm is worth more than the round. |
| The threshold is a **fraction of the cadence**, not a flat figure | 0.5 → 40 ms / 90 ms | ⏪ A flat **150 ms** shipped first and the rig refused it at the default 80 ms cadence: gaps of **256, 1, 256 ms**. A round drawn more than half a slot late is already past the next slot, so the two draw together. Half a cadence makes "no two drawn rounds closer than half a cadence" arithmetic rather than hope. |
| The **last round is never dropped** | — | It carries the settle tag. Keeping it means the completion signal is always named on a drawn element, so the apply window can never wait on a refusal — and no retagging machinery is needed. |
| A settle watch always ends | hard stop at `PRESENTATION_CAP_MS` | Neither original exit fires for a watch whose elements were created but never all reported gone; five overlapping fan-outs left **2 of 5** in the maps indefinitely. Resolving on the cap the window already honours cannot change what a caller sees. §4.2 |
| Flames **queued but not yet created** count against the scene cap | `pendingGroundFires` | Exposed by the faster hand-over: two placements inside one beat both read the same `liveGroundFires()` and both under-evicted — **28 alive against a cap of 24**. |

**2026-08-09 — the blood rebuild and the api report.**

| Ruling | Value | Why |
|---|---|---|
| The spray is **directional**, along the shot | `jb2a.liquid.splash_side02.red`, `rotateTowards` a point one grid unit beyond the target | User, verbatim: *"It's angled. The blood pushes out in a direction. It should move in the same direction as the bullet that strikes the target."* ⏪ supersedes the radial `splash02.red`, which had been chosen **because** it was radial (centroid fixed at 0.50/0.51 of its frame) and so could never disagree with the axis — the very property that made it say the wound had no direction. The side cut's ink traverses 0.29 → 0.65 of its own frame. Capture 64a. |
| One spray per **landing round**, not per payload | cap 4 | ⏪ User, on the MPK-9 burst: a ten-round burst marked its target exactly as hard as a single shot. The cap is measured — the clip lives 900 ms and hits are the leading rounds, so ten hits at an 80 ms cadence would overlap ten sprays inside one clip's life. Four read as four arrivals. Capture 64b. |
| Each spray runs on its round's **visual-impact clock** | `delayMs` = the load's `dashMs` | The spray starts when *its* round arrives, not when the payload resolved. A round the pacing rule refuses draws no spray either — the two share one draw block. |
| The incendiary **blast ring on the target** is withdrawn | `AMMO_FX.api.impactKey` removed | User, verbatim: *"get rid of the blast circle that lands on the target. I think multiple are being placed."* Removing the field is the whole fix — the row falls through to the class's own standard hit mark, like every unpromoted load. The tail is unchanged (the promotion was already trimmed to 833 ms). The tinted rounds, tinted flash and burning ground all stay; `IMPACT_FIRE` stays declared, one field from returning. Capture 64c. |
| The incendiary red is **eased one notch** | hue −20 → **−14** | User. Saturation and brightness were never in question. ⏪ The revert value −20 is recorded at the site. |
| The out-of-combat pattern TTL **works as built** | — | Verified live end to end on a real fired pattern: placed with no owning encounter, still present at 20 s, removed by the module's own interval at **70.0 s** (TTL 60 s + one 15 s sweep tick). The lingering patterns that prompted the check belonged to the **round** rule, not the clock rule — see §8. |

| Date / ref | Ruling | Why |
|---|---|---|
| FR#1–5 | The flash is a **client-local light source**, not a token document update | The document transport delivered an 85 ms envelope in ~1.3 s of wall clock; a viewer watched the light bloom outward and fade. Nothing about the values was wrong; the transport was. |
| FR#5 | Lit sprites are routed **above the lighting**, not merely elevated | Elevation does not choose the layer — route flags do. Measured: elevation-only crushes every class to a peak of 15/255; the same asset reaches 232 above the lighting. Accepted cost: above the vision mask too. |
| — | Flash colour **dropped** in favour of illumination only | A coloured source moved 44.8% of a *lit* frame's pixels on this core; the reference's engine does not do that. The user's hard requirement was "no visible flash in a lit area". |
| ⏪ FR#23 | Flash colour **restored, darkness-gated** | Uncoloured read "too white". The stain measurement still binds — but only in a lit scene. Gating keeps both requirements instead of trading one for the other. |
| FR#23 | Luminosity raised 0.5 → **0.65** | "I'd like them to feel pretty violent." A deliberate departure upward from the reference-exact value; it cannot reintroduce the stain, which is the coloration layer's doing. |
| FR#14 | Lance **trimmed to 110 ms** and sized in grid units | Reported "too large / a plume of smoke and fire". Frame-by-frame: the clip opens as a lance and then develops two billowing clouds. Scaling cannot remove a plume; only a trim can. |
| FR#14 | The trim is a **time range**, never `endTimePerc` | Measured: the percentage form cut nothing (1752 ms vs 1634 ms untrimmed); a time range gave 861 ms. Do not swap back without re-measuring. |
| FR#16 | Tracer colour is a **ColorMatrix**, never a tint | `tint` *multiplies*, so tinting orange with pale yellow returns *more* saturated orange — the opposite of the asked-for shift. Photographed side by side. |
| FR#17 | Smoke is **many short puffs overlapping out of phase** | "A lessening amount of smoke continues to advance, rapidly disappearing." One sprite dimming cannot produce that. Structure borrowed from the reference; assets are ours. |
| FR#18 | Every puff is its **own** `.effect()` section | Sequencer's randomisers roll **once per section**, not per repetition. A section with `.repeats(n)` yields n identical copies — the reference itself falls into this. |
| FR#18 | The puff's heading is set with `spriteRotation`, not `rotateTowards` | `rotateTowards` **sets the movement destination**. Puffs built with both flew to the target instead of drifting; measured 6–9 squares out on a 9-square shot line. |
| FR#19 | Pellets are driven by a **speed**, with an arrival hold | With no speed the travel is driven by the lifetime, so a pellet was destroyed at the instant it arrived — and on a client dropping frames, before. Measured: every pellet died at 0.778 of the line. |
| FR#20 | Smoke drift is **capped against the shooter**, with a lateral component | Reported "launching out of the gun like a projectile". The distance was never the fault — every puff slid along the same axis, so the group streamed as one jet. |
| FR#20 | The shell smokes on a **single** discharge (`smokeSingle`) | Reported "I don't see it at all for shotguns". Diagnosis: the shell path drew its puffs correctly; the table simply fires **one** round, and the multi-round gate then asked for none. |
| FR#21 | `muzzleMs` dwell added (lance stretched by playback **rate**, not range) | A single discharge's 110 ms lance is over before the eye settles, where an automatic's restarts read as sustained. Extending the *range* would let the plume back in. |
| FR#22 | The shell gets a **discharge column** (`bullet.02`, stretched) | Decoding the assets showed `bullet.02` carries a spiky bloom, smoke curls and an impact star baked into its own clip. The "spiky piece" lives in the asset, not in our lance. |
| ⏪ FR#22 | The shell draws **no lance**, and the dwell goes with it | "The newly added spiky cone looks great, but the flame lance from before still sits below it and it doesn't look good. Remove the flame lance." Mechanism left wired — it is one row field from use. |
| ⏪ FR#22 | The burst smoke **stream is retired** | The premise was wrong: `bullet.02` already carries its own smoke, so our puffs were a second smoke over a smoke. That is the reported "spammy no matter how we do it". Cost: pistol/SMG (`bullet.01`) autos are now smokeless — one row field from changing. |
| 2026-08-08 | **No spark star** on any class | Matched A/B on the rig (captures 45/46, 45b/46b): the radial star reads "magical" and "busy" for a firearm, fires rays backward across the shooter, and is a fixed size so it dominates a pistol. "The angled one is good enough." Mechanism left wired. |
| 2026-08-08 | The action is over when the **last round's impact/tracer** ends | Burst smoke and mote motes linger on purpose. Waiting for them would hold the window seconds past the point a viewer calls it done. |
| FR#22 | The settle signal asks the **engine**, not the clock | The engine keeps an effect alive past its nominal time. Measured: RIFLE 1022 ms vs a 933 ms schedule, SHELL 1045 ms vs 983 ms. That overhang is exactly the reported remainder. |
| FR#23 | `APPLY_LEAD_MS` = 150 | Reported "slightly sluggish". The final frames of an impact are nearly transparent, so the eye finishes before the engine does. The scheduled floor still overrides the lead. |
| FR#23 | The column is shortened to 1.25 sq and trimmed to 300 ms | Stretched to the aim point it drew "a rifle-like single bullet per shotgun shot". What it exists for is the bloom at its origin. |
| FR#23 | ⚠ ~~**Open:** at that short stretch the asset's arrival star is not separable~~ | ⏪ **Superseded 2026-08-09** — see the four entries at the end of this table. The star *is* separable, by trim; the "long stretch" alternative recorded here was measured and is wrong. |
| — | A **ruled fumble** draws and sounds nothing | "If the shotgun didn't fire, it shouldn't blast visibly." The round count cannot catch it — the base computes `roundsFired` before consulting the ruling — so the seam forwards the ruling itself. |
| — | An **untargeted** shot is drawn along the shooter's own facing | The previous build answered "which way" separately per element and answered "unknown", so a shot at nothing drew a plain radius and no sprites. Honest limit: it is only as good as a token's rotation. |
| **FR#24, 2026-08-09** | The ammo's **id** rides the payload | Everything else forwarded is a mechanical *consequence*; this is the modifier itself. Two of thirteen (`ap`/`dualPurpose`) carry identical mechanics and were indistinguishable at any distance. Presentation-only: no damage path reads it. |
| **FR#24, 2026-08-09** | Overlays **repaint, never add** | Standing ruling: shell pellets are never tinted, `columnColor` is the escape hatch. Expressed as a merge rule so no branch names the shell. |
| **FR#24, 2026-08-09** | `impactScale` is a multiplier | An absolute width would flatten the per-class impact ladder, which exists because a heavy round lands harder. |
| **FR#24, 2026-08-09** | An impact promotion is **trimmed to the ordinary mark's length** | Otherwise every AP hit would hold the damage window shut for five seconds — a cost nobody asked for, arriving as a side effect of choosing a different picture. |
| **FR#24, 2026-08-09** | The ammo tint goes **through** the darkness gate | The gate is inviolable; the lit-floor stain stays impossible by construction rather than by opacity. |
| **FR#24, 2026-08-09** | Burning ground and scorch are **once per payload** and excluded from the settle signal | The fan-out caps at 30 rounds; a per-round lingering element would put 30 overlapping fires on one square for one trigger pull. |
| **FR#24, 2026-08-09** | The scorch is **session-bound**, with a lifetime cap in minutes | Real persistence means a document write on the scene from whichever client resolved the shot. That is a shared question with blood decals and needs its own ruling. An uncapped Sequencer effect is a leak by another name. |
| **FR#24, 2026-08-09** | No **audio** layer for the ammo treatments | Sourcing is owed. Recorded so the omission is a decision, not a gap. |
| **FR#25, 2026-08-09** | ⏪ The column's **tail is out**: trim 300 → **55 ms** | "The shotgun's spiky cone is currently emitting a tail. Let's eliminate that tail (looks like a round or round tail)." The clip was decoded frame by frame off the installed 05 ft file: cone alone at 33–66 ms, a streak behind the muzzle from ~66, heads separating and running forward from ~96, the starburst from ~160. 55 is the largest trim under all three, with the overshoot margin below subtracted. ⏪ Supersedes the FR#23 300 ms value. |
| **FR#25, 2026-08-09** | ⏪ The "long band" alternative is **wrong**, not merely untaken | The 55c note assumed a longer distance band spreads the phases further apart in time. Decoded: all five bands are **933 ms**; they differ in width (600→4000 px), and the bloom is the same ~230 px of art in every one. Head position as a multiple of the bloom's extent at 133 ms of clip: 05 ft = 1.05×, 90 ft = 1.9×. The long band puts the round *further* from the bloom, not nearer. The short band is strictly best; the trim is the only lever. |
| **FR#25, 2026-08-09** | The **starburst and the tail were one element** | Reported separately — "shotgun also has this standard starburst in addition to the spiky cone" — and decomposed on the rig: the starburst appears in a sequence carrying *only* the column, with no pellets and no hit mark drawn. It is `bullet.02`'s own baked arrival phase, ~1.5 squares off the barrel. The trim removes it; the hit confirmation at the target is a different asset and is untouched. Capture 57c. |
| **FR#25, 2026-08-09** | The trim gets a **dwell** (220 ms, rate 0.25) rather than being left at 55 ms of wall clock | Two reasons, and the second is why it cannot be tidied away. (1) FR#21 already ruled that a *single* discharge needs ~220 ms of presence, and this is the one class that draws no lance at all. (2) Measured: the media overshoots its range end by a slice of **wall** time, so a slow rate converts less of it into clip. Rate 1 is the **worst** case, not the safest — 139 ms of clip reached against a 70 ms range. At 55/220 the worst clip reached over 16 real discharges was **59 ms**. |
| **FR#25, 2026-08-09** | ⏪ The flechette dart's length is raised **0.8 → 1.1 sq** | User approval. 0.8 was an unmeasured guess ("smaller than buckshot's 1.0") and read faint on a painted-bolt class — capture 56e on the rifle, 57f is the same framing at 1.1. The field is the sprite's drawn *frame* width and the lit slug is roughly a fifth of it, which is the same trap the shell's pellet-size note records (0.5 read as dirt on the screen). 1.1 sits just above buckshot; what keeps a dart swarm reading as needles rather than shot is the **count and the spread**, not a shorter mark. `dashMs` is unchanged at 170, and the length is not a tail term, so no apply window moved. |
| **BLOOD, 2026-08-09** | Blood on flesh hits is **approved, phase 1: transient only** | "Blood splatter is approved." Floor decals are explicitly out of this phase — real persistence is the same open question the scorch has, and it is answered once for both. |
| **BLOOD, 2026-08-09** | It is **off by default**, on a world switch | This is the one thing the rail draws that a table may object to rather than merely find noisy. World-scoped and not per-player: a table that has agreed to it should not have one player watching a different scene. |
| **BLOOD, 2026-08-09** | **No blood on a target that takes damage into structure** | Vehicles, powered armour and full-conversion bodies do not bleed. Asked at the ACTOR level (`bearsStructuralSdp`), which is the honest limit — see the next entry. |
| **BLOOD, 2026-08-09** | The target-type question is asked **of the actor, not of the zone** | `routesToSdp` is the function that really decides, and it takes a hit LOCATION the payload does not carry: the card says how many rounds landed, never where. So a cyberlimbed character reads as flesh and still bleeds when the round in fact struck the arm. The alternative — suppressing blood for anyone wearing chrome — would be wrong far more often. A keeper leg pins both halves: the arm routes to structure, the actor does not. |
| **BLOOD, 2026-08-09** | ⏪ The free tier **does** carry a blood-coloured asset; no colour filter is used | The unit's own design note said "no blood family, red-tint a liquid splash". Half right: nothing is *named* blood, but `jb2a.liquid.*` ships red variants. Decoded off the installed file, this one means R91 G1 B1 at 113 ms, R95 G1 B2 at 283 ms, R157 G3 B4 at 453 ms — a deep near-black red with the other two channels at zero. A ColorMatrix over that would repaint red with red. |
| **BLOOD, 2026-08-09** ⏪ **REVERSED the same day** | Chose the **radial** liquid; the **side** one now ships | Measured centroids: `splash02.red` holds at 0.50/0.51 of its own frame from 170 ms to 510 ms, so it is radial about its centre and needs no rotation to agree with the shot; `splash_side02.red` traverses 0.29 → 0.65 and is a directional wave. The measurement stands and the conclusion drawn from it did not: "cannot disagree with the axis" was treated as a virtue, and the user ruled that a wound with no direction is the defect. The traversal that disqualified the side cut is exactly what now qualifies it. See §6. |
| **BLOOD, 2026-08-09** | Size is the drawn **frame**, 1.5 sq; trim is where the **content** ends, 900 ms | Ink coverage falls from 17.1% of the frame at 283 ms to 0.07% at 680 ms and peak alpha is 5/255 by 963 ms, so 900 keeps every frame that has anything in it. The frame-vs-ink distinction is the same trap the flechette dart length records. |
| **BLOOD, 2026-08-09** | Drawn **above the lighting**, against this file's own routing rule | Below it, on a dark scene, the mark does not exist (capture 58d). The accepted cost is the vision mask, for under a second. Stated as a departure with a knob rather than folded in silently. |
| **BLOOD, 2026-08-09** | **Once per payload**, and never part of the settle wait | The same rule and the same reason as the burning ground: the fan-out caps at 30 rounds, and the damage window may not be held for scene dressing. |
| **BATON, 2026-08-09** | ⏪⏪ The rubber / stun-dart **darkening is rejected outright**, not re-tuned | "What you did for rubber bullets doesn't look good. Instead of darkening/muting the color, let's look for a better asset to represent rubber bullets." The old treatment was a bolt at brightness **0.60** and a mark at **× 0.60**. Its premise was not wrong about the round — a baton round does carry less energy — it was wrong about the **screen**: a dimmed sprite on a dark scene is not a quieter round, it is a round the eye has to hunt for. Capture 59-control. Both halves are gone, including the shrink: a blunt round makes a *different* mark, not a *smaller* one. |
| **BATON, 2026-08-09** | The load is now said with a **different asset**: the round is a solid travelled slug | `jb2a.throwable.launch.cannon_ball.01.black`, sized 2.4 sq of frame (≈ 0.25–0.55 sq of actual ball, measured) and crossing in **240 ms** — the slowest thing the rail fires. Chosen from a closed enumeration of the tier's ranged family, not by name: `bullet.03.blue` develops a full spiky starburst at 0.30 s (the 2026-08-08 no-starburst ruling is about the shape, not the colour); `snowball_toss` ends in snowflakes; `boulder.toss.02` is legible but its art travels *backward* across its own frame (centroid 0.46 → 0.27 → 0.65) and reads as a thrown stone. Captures 59a / 59b / 59c. |
| **BATON, 2026-08-09** | The round is **travelled**, not painted — and that is a correctness choice, not a style one | A painted tracer's on-screen life is the *asset's* clip, bounded once for the whole rail by `TRACER_CLIP_MS` = 933. This asset's five distance bands are 467 / 767 / 1167 / 2067 / 2433 ms, so painting it would put two of them past that bound and the tail would come back short with no signal — exactly the silent, one-directional failure `presentationTailMs` exists to prevent. A travelled sprite's life is `dashMs + 260` and owes the asset nothing. |
| **BATON, 2026-08-09** | The hit mark becomes a **dust puff** (`jb2a.smoke.puff.ring.01.white`) | Enumerated the same way. Every blue impact on the tier (`001`–`004`, `011`, `012`) is a spike starburst; `impact.water.02.blue` reads liquid; `side_impact.part.smoke.*` is crystalline shards at 3067 ms; `smoke.puff.centered.grey` peaks at luminance 87/255 and is too faint to read as an arrival. The one genuinely *blunt* alternative — `side_impact.part.shockwave.blue`, a concentric ring wave — is rejected on **mechanism**, not looks: its arcs face one baked direction and the impact is drawn with no rotation, so it would point the same way whichever way the shot went. The chosen puff is radial, peaks at 217/255, and takes no `impactClipMs`, so the promotion rule trims it to the ordinary mark's 833 ms unchanged. |
| **BATON, 2026-08-09** | **One matrix** repaints the slug *and* the shell's discharge column | `TRACER_COLOR_BATON` = hue 0, sat −0.85, **brightness 1.30**. The number to read is 1.30 — above 1, where the rejected value was 0.60. It says a different true thing about each element it touches: the slug's art is already greyscale (mean luminance 99/255 measured), so the *brightness* is what lifts it off a black floor; the column is `bullet.02`'s orange bloom, so the *desaturation* is what turns a fire blast into the pale gas flash of a reduced-pressure load. One matrix rather than two is what makes the shell's two elements agree — the standing uniformity ruling. |
| **BATON, 2026-08-09** | The masked-merge rule is widened from **colour** to **asset** | The baton treatment is the first overlay that swaps a *file*, and a bare overwrite would have made `column` a way to hand a pistol a shotgun's discharge blast — one field away from what `columnColor` is already forbidden to do. `AMMO_FX_REPLACE_FIELDS` puts `tracer` and `column` behind the same key-presence mask. No shipped behaviour changes; the guarantee becomes structural instead of conventional. |
| **SPREAD, 2026-08-09** | The shotgun is played **RAW**: buckshot throws the p.108 pattern, and which shot does is read from the **cartridge** at fire time | "Then do it RAW." The Core rules list the shotgun on their own Area Effect table — 1 m / 2 m / 3 m wide by Close / Medium / Long, 4d6 / 3d6 / 2d6, everyone in the path, no evasion. Deriving it from the caliber rather than from the stored `spreadMode` is not a style choice: every shotgun ammo item ever seeded carries `spreadMode: "single"`, so reading the flag would have made the book behaviour reachable only by hand-editing every ammo item in every existing world. Derived, an untouched world's buckshot patterns on its next shot with no migration. |
| **SPREAD, 2026-08-09** | ⛔ **The slug is a LOAD, because the registry has no slug cartridge to be** | The build spec asked for "the slug caliber". There is none: `CALIBERS` models **one** shotgun entry, `"00"`, labelled *"00 Buck / Slug"*, and all six gauge spellings alias onto it — so the cartridge physically cannot say which of the two is chambered. A slug is therefore expressed as a shotgun-family ammo **modifier** (`slug`, `spreadMode: "slug"`), which is also what it is: the same hull, a different projectile. Additive only — one row in a lookup table, one selector option, no schema, no migration, nothing re-seeded. **This is the build lane's call and not a ruling.** |
| **SPREAD, 2026-08-09** | An autoshotgun's N shells are **N rolls on ONE card** | No special autoshotgun rule exists in the recorded read, so RAW is that each shell throws its own pattern — and N patterns aimed identically *are* one pattern resolved N times. The mechanics stay per shell (N banded rolls per token, each through the armour pipeline, which is a different number from N × one roll the moment SP is in the way); only the aiming and the clicking collapse. Card text states the count; one result card lists the rolls. Captures 60b / 60c. |
| **SPREAD, 2026-08-09** | The pattern is **ghost orange**, at 0.10 against core's 0.5, with the hatch off | "Ghost orange … the old opacity was horrible to look at and it blocks things including the shots." Values and the reason core forces this to be done on the drawn object are in §3.2a. The hatch is the half that actually occludes, so alpha alone would not have answered the report. Captures 60a and 60a-control are the same region under both treatments. |
| **SPREAD, 2026-08-09** | The pattern is **GM-only** | It is an aiming aid the GM has not committed to yet. The table should not watch an unconfirmed blast hover over their tokens, and a player who can see it can read the GM's intent before the GM has one. Uses the shim's existing GAMEMASTER default. |
| **SPREAD, 2026-08-09** | **Confirm, then vanish** — and an ignored pattern expires on its own | The defect this replaces was pinned live: every spread shot created a region and *nothing* deleted it — no confirm path, no consumer for the round it recorded — so the count grew one per shot forever. Confirm now deletes on every exit that reached a real pattern, including the one where nobody was inside it. |
| **SPREAD, 2026-08-09** | Expiry is **two clocks**, and which one owns a pattern is decided when it is thrown | A pattern thrown during an encounter belongs to that encounter's rounds; one thrown outside any encounter has no round to wait for and belongs to a 60-second wall clock. Asking later — "is a combat running *now*?" — is wrong in both directions: a pattern thrown out of combat became immortal the moment somebody rolled initiative, and one thrown in combat was swept off the table if its own round ran long. The encounter id is stored, so it also survives that encounter being deleted. A pattern carrying **no** timestamp is litter from the build that had no expiry at all, and is read as expired rather than as immortal — which is what lets an already-littered world tidy itself on load instead of needing a migration. |
| **SPREAD, 2026-08-09** | The pattern reaches the **far edge of the target's own square**, not its centre | Found by the keeper, not by eye: ending the ray exactly at the aimed-at centre put that centre *on* the polygon's end edge, so whether the token the shooter aimed at was inside its own pattern came down to a floating-point comparison. Reproduced on the rig — a three-shell burst resolved against a bystander and missed the target entirely. Half the target's own width is the smallest overshoot that settles it, and it costs no other square. |
| **SPREAD, 2026-08-09** | An **untargeted** shell is thrown along the shooter's facing | The same answer, for the same reason, that the presentation rail already gives an untargeted shot (§6, "An untargeted shot is drawn along the shooter's own facing"). It was due east before. Honest limit, unchanged: it is only as good as a token's rotation, and the band stays Medium because an untargeted shot names no distance. Capture 60e. |
| **BURNING GROUND, 2026-08-09** | ⏪⏪ The **ground-crack asset is rejected outright**, not re-tuned | *"The 'on fire' effect that goes on the ground when incendiary hits is not what we're looking for. First off, it looks like a ground shock effect of some kind, not fire. It darkens and cools, making it not look like an active flame."* Half of "darkens and cools" was ours and half was the asset's, and the fixes differ: decoded off the installed GroundCrackLoop file its own luminance is **flat** — mean 55–57/255 and 46 % of the frame lit at every one of twelve sample points — so the cooling was our own envelope, a 900 ms fade on a 3200 ms life, i.e. 28 % of the element was a dim-down. What no envelope could fix is the picture: it draws glowing **fissures in the floor**, which is cooling magma. The family stays in the file as the armour-piercing load's *impact* mark, which is a different element and was never the thing reported. |
| **BURNING GROUND, 2026-08-09** | The fire is `jb2a.flames.orange.03.1x1` | Chosen from a closed enumeration of the installed tier — 2061 keys, every family whose name carries fire/flame/burn/ember/torch/brazier/lava/scorch/crack, then decoded frame by frame. Two facts decided it. **Top-down:** its own filename says 05x05ft, so it is a square ground plate; the tier's other genuine loops that hold their light are 400×600 (`Flames04`) and 400×1000 (`Campfire03`) portraits — a flame seen from the *side*, which laid on a floor reads as a wall sprite. **No decay:** 5000 ms, and its tail third measures **brighter** than its own middle (ratio 1.19), so it cannot cool inside its loop. Rejected with reasons: `campfire.01` / `bonfire.01` are ringed with **stones**; `braziers.*` has a bowl; `fire_trap.01` is a comet streak, not a fire; `fireball.loop_no_debris` is a whole burning field at 49 % coverage; `impact.fire` (then the incendiary hit mark, since withdrawn — §6) decays to **zero** by 1417 ms of its 2267 and is not a loop at all. |
| **BURNING GROUND, 2026-08-09** | ⏪ **N flames at the landing points**, not one at the target | *"I was picturing something more like little animated flame decals that stayed burning on the ground in the places the shots landed, not just on the target."* Neither branch invents a position: a fanning class already computes real per-pellet endpoints for its tracer, so a subset of those **is** where its shot landed; a single-bolt class puts every round on one aim point, so its rounds are scattered inside a 0.8-square disc — an admission that the exact square is not known, which is the same limit that makes the fan-out assign hits to the leading rounds. |
| **BURNING GROUND, 2026-08-09** | A pattern shot's fires belong to the **path**, and are placed on **confirm** | For buckshot the Core rules put the shot across the whole 1–3 m path and the module already asserts that by damaging everyone in it, so "where the shot landed" is not the target. The geometry is owned by the flow that drew it, and the fires go down when the **GM confirms**: an unconfirmed pattern is a GM-only aiming aid and a fire is not, so lighting the ground mid-decision would leak the aim and leave fires burning for a shot nobody resolved. The rail correspondingly draws none for a pattern payload, gated on the **same call** the two damage gates make (`spreadFlowModeOf`) so the three cannot disagree. |
| **BURNING GROUND, 2026-08-09** | The gate is now **one placement event per payload**, and two bounds replace the old one | The old rule said "one fire" and existed because the fan-out caps at 30 rounds — a per-round lingering element would be thirty fires on one square for one trigger pull. That bound is unchanged: the call still sits outside the round loop, so the loop cannot multiply it, and `maxPerPayload` (4) holds the placement itself down. A **second** bound is new because these live for 45 s rather than 3.2: `maxLive` (24) caps what may burn on a scene at once, enforced by ending the **oldest** — the shot a viewer is watching is the one that must be drawn. |
| **BURNING GROUND, 2026-08-09** | The scatter is **seeded from the payload**, not from `Math.random` | Sequencer broadcasts the resolved sequence rather than the code that built it, so today one client rolls and everyone draws the same fires — but a scatter that is only correct because of *where* it was computed is one refactor from two clients disagreeing about where a fire burns for the next 45 seconds. Seeding makes the agreement a property of the inputs. It is also the only way to pin a scatter in a test without pinning pictures: the keeper recomputes the plan from the seed the fan-out reported and compares by value. |
| **BURNING GROUND, 2026-08-09** | Lifetime **45 s**, and the scorch stays **one** per placement | 45 s is a look call, not a measurement, taken on the precedent the scorch already set for a session-bound element with a cap in place of a persistence ruling; the fade is 5.6 % of it, against the 28 % that produced the report. The scorch deliberately does **not** follow the flame count: it lives for three minutes, so four per burst is exactly the accumulation the payload gate exists to prevent, where four 45-second flames are not. It sits at the flames' centroid and says one true thing — a fire burned here. |
| **SEAM, 2026-08-09** | The ammo's **id and its cartridge both ride the payload — beside each other, never one instead of the other** | The spread unit added `caliber` to `AMMO_EFFECT_FIELDS` and took `modifier` out with it, and **nothing failed**: `ammoFxKeyOf` falls back to a fingerprint of the mechanics when there is no id, so every load still resolved and every picture was still drawn. The one pair the fingerprint cannot split is `ap` / `dualPurpose` — byte-identical mechanics — so the entire visible cost was `dualPurpose` silently answering `ap`, which is the exact case the id was added to settle. The two fields answer different questions (which **load** is in the gun; which **cartridge** it is) and both are load-bearing. The real lesson is the keeper's, not the code's: every existing leg handed the resolver a payload it had built itself, so 610 checks could not see a field the seam never sent. The fix is one string; the guard is a leg that reads a **real** fired payload off the hook and asserts, on the same object, that the id answers `dualPurpose` while the id-stripped copy answers `ap`. |
| **SPREAD, 2026-08-09** | ⏪ The pattern's **world switch is part of the flow question**, asked at one shared site | Pre-existing gap, recorded as an open item since the spread unit and closed here. The switch was read only by the pattern hook, so with it **off** a shell was owned by nobody — the single-target gate stood down for the cartridge, the pattern hook stood down for the setting, and the shot did no damage at all. "Off" now means the module does not do patterns, so every shell takes the ordinary single-target route exactly as the slug already does. Put in `spreadFlowModeOf` (lookups.js) rather than at either gate because the guarantee that matters is that all **three** callers — both damage gates and the presentation rail's `patternFlowOwns` — cannot answer differently, and a second reader of the setting is precisely how they disagreed. ⏪ Supersedes the note at `patternFlowOwns` that the setting was deliberately not consulted "because neither damage gate does": neither did, and that was the bug. |
| **FR#25, 2026-08-09** | ⏪ An ammo recolour now reaches the **pellet fan**; the base fan stays untinted | "For incendiary on autoshotgun the little dorito shaped pellets themselves didn't get the same red treatment as the spiky cone and starburst. Make sure when you update the animation for one shotgun ammo type, it's updated for all." Expressed as `tracerColor: null` on the class row — declared repaintable, painted with nothing — so the base look is byte-identical and every recolouring overlay (`api`, `ap`, `dualPurpose`, `rubber`, `stundart`) lands on column and fan alike. ⏪ Supersedes FR#24's "shell pellets are never tinted" for overlays only. |

---

## 7. Testing story

**The keeper.** `tests/cp2020-augmented-fx-rail.mjs` in the fork repo, run against a rig carrying
Foundry + this module + Sequencer + the free JB2A tier:

```
FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=<pw> node cp2020-augmented-fx-rail.mjs
```

What it pins, in outline: capability detection against the *installed* engine and tier · class
resolution from item type data, including the attack-type discriminator that runs ahead of the type
map · **every mapped database key resolving on the free tier** (so a paid-tier-only key is caught here
rather than by showing nothing) · the flash envelope by value, the applied write sequence, and that
**no document write reaches the shooter token** other than the face-target rotation · the fan-out's
counts and cadence · the ammo overlay resolution, every treatment's values, the tail threading, the
burning ground's placement gate, its planners and its scene cap, and the flash tint through the
darkness gate · **the pacing contract** — the anchored slot ladder and the drop decision as pure values
(including the separation guarantee at every shipped cadence and the last-round exemption), then live
both ways: the threshold held out of reach to prove a healthy client drops **nothing**, and the
threshold at the floor with a 30-round flechette fan-out (a load this host genuinely cannot keep up
with, so the refusals are real) to prove late rounds are dropped, the burst still ends on its own
schedule, the last round still carries the settle name, and the window still closes on the engine's
signal · **the api overlay after the report** — no promoted mark on any class, the eased hue with its
revert value, and the other promotions untouched · two real sessions, to
prove the socket relay draws a flash on a client the fire never ran on · a non-GM session driving a
write, because a rule that reads right and a write the server refuses look identical from the GM's
side · 0 console errors.

**Assertion style.** Every pure helper on the rail (`muzzleSourceSpecs`, `pelletEndpoints`,
`moteEndpoints`, `smokePuffPlan`, `presentationTailMs`, `flashColorFor`, `ammoFxEntry`, …) takes an
injectable `rng` or plain arguments precisely so its output is asserted **by value**, with no canvas,
no engine and no shot. Anything that cannot be — which asset was queued, how many were emitted, what
colour a source was built with — is driven live and read back off the engine.

⚠ **And the limit of that style, which this unit exists to fix.** A leg that hands a pure helper a payload it built
itself proves the helper, and says **nothing** about whether the seam sends that field. `payload.modifier`
went missing from `AMMO_EFFECT_FIELDS` for a whole build while 610 checks stayed green, because every
one of them supplied the id in the fixture. `tests/cp2020-augmented-b1-seam-payload.mjs` is the answer
and is now the seam's own keeper: it fires bench guns **07** and **16** through the real UI path and
asserts `modifier`, `caliber` and the resolved overlay key **off the payload the hook actually carried**,
with gun 16 chosen because it is the one load a fingerprint physically cannot identify. Its sharpest leg
asks the resolver twice about the same real payload — once as fired, once with the id deleted — so the
record contains the fallback answering `ap`, which is what makes the id's presence a claim and not a
formality. The fx-rail spec carries the same question in miniature against the real bench items rather
than a fixture. **Any field the seam forwards wants one leg of this shape**; a fixture cannot fail for
the absence of something it supplies.

**The baton pair's legs are written as the inverse of the ones they replace.** Two legs used to assert
that this pair's matrix was the only one that *darkened* and that it drew a *dull bolt and a small mark*.
Both facts are now false by design, so the replacements assert the opposite on purpose: that **no** live
matrix darkens and that the retired one appears on **no** shipped row; that the load is said with a
different asset on every class; that a class which painted its round now travels it; that the shell's
shot **count** and spread are untouched while its size and speed are replaced; that the mark is the dust
key at the class's own width with no `impactScale` anywhere; and that the tail is `240 + 833` on all five
classes. Two legs drive it live and read the file the *engine* was handed rather than the merge — an asset
swap is exactly the change a value-only assertion cannot see.

**The burning-ground section is written as the inverse of the one it replaces**, in the same way the
baton pair's was, because the rebuild made three of its facts false on purpose. Where the old legs said
the lifetime was *a few seconds*, that ONE fire was set, and that the fire was the crack family, the
replacements say the lifetime is **tens of** seconds, that a ten-round burst sets **four** fires and one
scorch, and that the crack survives only as the armour-piercing *impact* — a different element that was
never the thing reported. Around those sit the legs the redesign needs: both planners asserted **by
value** (a fanned class's fires must each be a member of the very pellet fan the tracer draws, and must
span it rather than cluster; a single-bolt class's must be N distinct points inside the scatter disc);
determinism computed **twice** and compared, with a second seed proving the seed is really the source;
the pattern's scatter checked against the **real polygon** with the module's own `pointInPolygon`, which
is deliberately a different piece of arithmetic from the ray-local construction that produced it; the
either/or by value on both sides; the scene cap **driven** — enough bursts to exceed it must leave the
cap's worth burning and not the sum — and the canvas clear leaving none; and the settle exclusion pinned
as an identity, that an incendiary payload's apply window is byte-for-byte the ordinary one on all five
classes. One leg decodes the shipped clip off the **installed file** and asserts its tail is no dimmer
than its middle, because "it darkens and cools" is a claim about frames and is answered with frames.

The gore unit added a section of its own, and it is almost entirely negatives, because four
independent gates each mean "this must NOT be drawn": the switch registered world-scoped and shipping
OFF · the reader following it both ways · the target-type answer by value for flesh, npc, vehicle,
powered armour, full conversion and the ruled cyberlimb case (which also asserts that the *zone*
routes to structure while the *actor* does not) · the asset key resolving on the free tier and the
installed file measuring the length the trim was chosen against · then live: nothing with the switch
off, exactly ONE splash from a ten-round burst, nothing on a vehicle, nothing on a full conversion,
nothing on a ruled fumble, nothing on a burst that misses, nothing when no token was aimed at, and the
scheduled tail identical with the switch on and off.

**The shot pattern has its own spec**, `tests/cp2020-augmented-spread-zone.mjs` (81 checks), because
what it tests is the damage rail and a canvas document's lifetime rather than anything the effect
engine draws. Eight sections: the derivation asserted by value across the whole caliber × load matrix
(including every gauge alias and both blanks) · the seam carrying the cartridge, checked against the
**shipped shell compendium** rather than a fixture, so a catalogue that stopped recording gauges would
fail here · the either/or, driven by raising the real hook and asking whether the single-target flow
**claimed** the payload — which answers "was a dialog opened?" without opening one · placement, with
core's own 0.5-and-hatched values asserted on an untouched region before ours are asserted on
ours · per-shell resolution against a **fixtured** band formula, so three shells must read `5, 5, 5`
and can never be one roll counted three times, driven by a real DOM click on the posted card's
button · both expiry rules as pure predicates by value, then driven live · cover occlusion · and a
source scan for the two ways this could silently rot (the stored flag being read again, and
`region.behaviors.length`).

⛔ **The spec must not disturb the review rig**, and two of its legs exist only because of that. The
showcase encounter on :30004 is the user's, so the round rule is driven by raising `updateCombat` with
that encounter's **own unchanged round** and a backdated pattern — nothing about the combat is
written, and a leg asserts afterwards that it still stands where it did. The clock rule is reached by
clearing the pattern's recorded encounter, which is exactly the document state an out-of-combat throw
produces. Fixtures live in an empty lane far from the review targets: the first run of this spec put
its pattern across **Review · Shooter** and damaged it, which is also how the ray-overshoot defect
above was found.

**Traps a new leg will hit.** A `timeRange` end is a **budget, not a guarantee** — the media element
starts after the effect does and can run past the range end, so anything asserting "content X is never
drawn" must be measured against the video's own `currentTime`, not inferred from the constant · the
host refuses a media `playbackRate` below **0.0625** (it throws `NotSupportedError` and the clip then
plays at 1, which silently invalidates every held capture taken through it) · this rig renders at about
**12 fps**, so a `requestAnimationFrame` sampler sees a 200 ms effect three times and every duration
inferred from it is noise — sample on an interval and read the media clock ·
Sequencer randomisers roll once per section · `endTimePerc` is a no-op on
this build (use `timeRange`) · `rotateTowards` sets the movement destination · core packs colours to
**numbers** on source data, so compare in core's units · the capture seam must be applied *first* in a
chain (the engine reads the playback rate when it works out a trim point) · `endAllEffects()` between
sections can make the engine lose a race with itself, which is why the harness absorbs exactly that one
third-party signature and nothing else · **a multi-document create does not guarantee the order of what
it hands back** — this rig returned four tokens in database order, so a leg that destructured them by
position read the wrong target's result and two gates looked broken that were not. Create one at a
time, and assert the handle carries the actor its leg names.

**Capture seams.** Screenshots on a software rasteriser cannot catch a 110 ms sprite or a pellet that
crosses in under a frame. `_setSpriteRate`, `_setDashMs` and `_setFlashLevels` stretch the *clock*
without changing a single shipped value — sizes, trims, geometry and colour are untouched. Every image
taken through one says **HELD** in its filename.

**Provisioning — the review bench.** `tests/cp2020-augmented-provision-review-bench.mjs` builds the
whole review loadout: **one weapon per (class × distinct-visual load), each already loaded**, named with
a numbered prefix so the shooter's Combat tab reads as an ordered walk-down list. It is idempotent by
**rebuild** — every run deletes what it owns and recreates the same rows, one at a time, because the
Combat tab lists `actor.itemTypes.weapon` in collection order and not by name, so creation order *is*
the reading order. Re-running is therefore also the reset (magazines full, loads re-linked, damage
zeroed, targets back in position).

⚠ **"Loaded" on the ship target means `system.ammoItemId`, and only that.** That is the field the seam
reads (`ammoEffectFields`), so it is what puts a load's mechanics and its cartridge on the payload. The
`loadedAmmoId` / `loadedAmmo` snapshot pair exists on the **fork's** weapon schema and not on the
shipped system's; the provisioner writes the pair when the running schema carries it and reports when it
does not, rather than writing keys the DataModel drops.

⏪ It **supersedes** `tests/cp2020-augmented-provision-fx-ammo.mjs`, which stocked loose ammo boxes on a
shooter carrying unloaded guns and left the reviewer to load each one from the sheet. That design was
retired by the user on 2026-08-09: *"preload my guns with the right ammo and give me multiple guns of the
same type with different ammo so I can just go down the list and shoot each of them."*

The bench, as it ships (walk-down order, pistol → smg → rifle → shell → heavy):

| # | Weapon | Caliber | Load | Class | What that row exists to show |
|---|---|---|---|---|---|
| 01 | Stolbovoy St-2 Pistol | 10mm | `standard` | pistol | the class baseline — 0.70 sq mark; the control for 02/03 |
| 02 | Stolbovoy St-2 Pistol | 10mm | `hollowPoint` | pistol | `impactScale` × 1.60 → 1.12 sq |
| 03 | Stolbovoy St-2 Pistol | 10mm | `safety` | pistol | `impactScale` × 0.55 → 0.385 sq |
| 04 | H&K MPK-9 | 9mm | `standard` | smg | the burst cadence (80 ms), mote spray, smokeless auto |
| 05 | H&K MPK-9 | 9mm | `rubber` | smg | **the baton pair, class half** — `cannon_ball` slug + dust puff |
| 06 | Militech Ronin Light Assault | 5.56 | `standard` | rifle | the class baseline — 0.95 sq mark |
| 07 | Militech Ronin Light Assault | 5.56 | `api` | rifle | **burning ground on the single-target flow** — ≤ 4 flames in the scatter disc + one scorch |
| 08 | Militech Ronin Light Assault | 5.56 | `ap` | rifle | near-white bolt + ground-crack impact; the control for 16 |
| 09 | Militech Ronin Light Assault | 5.56 | `flechette` | rifle | 8 darts at 1.1 sq from a class that draws one bolt |
| 10 | Arasaka Rapid Assault Shot 12 | 00 | `standard` | shotgun | **the RAW buck pattern** + confirm + delete; and the discharge column at its 55/220 trim |
| 11 | Arasaka Rapid Assault Shot 12 | 00 | `slug` | shotgun | **the single-target contrast** — the one shell load that throws no pattern |
| 12 | Arasaka Rapid Assault Shot 12 | 00 | `api` | shotgun | **burning ground on the pattern flow** — ≤ 5 flames placed on *confirm*; column **and** fan both red |
| 13 | Arasaka Rapid Assault Shot 12 | 00 | `stundart` | shotgun | **the baton pair, shell half** — one matrix across column and pellets |
| 14 | Arasaka Rapid Assault Shot 12 | 00 | `flechette` | shotgun | a dart swarm, and a flechette pattern rather than a buck one |
| 15 | Barrett-Arasaka Light 20mm | 20/9mm | `standard` | heavy | the top of the impact ladder — 1.30 sq |
| 16 | Barrett-Arasaka Light 20mm | 20/9mm | `dualPurpose` | heavy | identical to `ap` by ruling — the pair the payload's ammo **id** exists for |

Every pairing is checked against `modifiersForCaliber` before the row is built, and every magazine's
caliber IS its gun's own `ammoType` string — so a load can never land in a barrel that does not take it,
and the check is the registry's answer rather than the script's. Sixteen rows, five classes, ten distinct
loads; `brassCased` is the one treated modifier with no row, because it draws exactly what `standard`
draws. The range is set up with it: three labelled targets (flesh · cyberlimb · vehicle) at 10–11 m,
inside every bench gun's Close band and in the pattern's Medium band, at zero damage, gore ON.

**The bench's own smoke test.** `tests/cp2020-augmented-review-bench-smoke.mjs` (36 checks) is not a
keeper — it pins no values. It answers one question: can each gun be picked up and fired with zero
loading steps, and does the thing that row exists to show actually reach the canvas? Every shot goes
through the **real UI path** (the sheet's fire button → the modifiers dialog → its submit) and every
claim is read off the **engine**: the payload the seam raised, the database keys Sequencer was handed
(`createSequencerEffect`), the region documents the pattern flow wrote. It drives blood on flesh and its
absence on the vehicle, the baton asset and its dust mark, the burning ground and its scorch, the buck
pattern's placement / confirm / deletion, the incendiary shell's fires arriving only **on confirm**, and
the either/or by value on both sides — `payload.handled` unset for buckshot and `"cp2020-augmented"` for
the slug. It restores everything it disturbs.

⚠ **Two traps it hit, recorded because the next leg will hit them too.** `createSequencerEffect` reports
the **database key** a section was handed (sometimes with a variant suffix, `…yellow.1`), *not* a resolved
file path — a leg matching on `Sequencer.Database` filenames matches nothing. And the apply window is
**deferred until the presentation settles**, up to `PRESENTATION_CAP_MS` (8 s), so a window opened by the
*previous* shot arrives long after that shot's own read: a leg that counts windows must drain past the cap
before it fires, or it attributes one shot's dialog to the next one's payload.

---

## 8. Open items

| Item | State |
|---|---|
| ~~The ammo's `modifier` id is ruled onto the payload but is not on it~~ | ✅ **CLOSED 2026-08-09.** `AMMO_EFFECT_FIELDS` had had `modifier` **replaced** by `caliber` rather than joined by it, so `payload.modifier` was `undefined` on every real shot and every load resolved through `ammoFxKeyOf`'s fingerprint branch — collapsing `dualPurpose` onto `ap`, the one case the id exists to settle. Both fields now sit in the list, with the comment block saying why one may never displace the other. The guard is the point: `tests/cp2020-augmented-b1-seam-payload.mjs` now fires bench guns **07** (`api`, 5.56) and **16** (`dualPurpose`, 20/9mm) through the real UI path and asserts `payload.modifier`, `payload.caliber` and the resolved key off the payload the hook actually carried — plus, on that same object, that stripping the id makes it answer `ap`. Reverting the one string turns four of its legs red. See §6. |
| **The burning ground's size, density and lifetime are not signed off** | ⚠ **The open item of this unit.** The asset was chosen by measurement and the placement was ruled, but three numbers are look calls the build lane made while the user was away: one flame is **0.9 squares** (picked off a 0.5 / 0.7 / 1.0 / 1.6 comparison on the dark range), a payload places **up to 4** and a pattern **5**, and a flame burns **45 s**. Each is one constant, and a veto costs nothing: `GROUND_FIRE.squares`, `.maxPerPayload` / `.maxPerPattern`, `.lifetimeMs`. Captures 61a–61d. |
| ~~A shell fired with the shot pattern **switched off** is claimed by neither flow~~ | ✅ **CLOSED 2026-08-09.** The world switch is now part of the flow question itself, asked at one shared site (`spreadFlowModeOf`, lookups.js) by both damage gates and by `patternFlowOwns`. With the pattern off a shell resolves to `single`, so the ordinary apply flow claims it exactly as it claims a slug, and the fan-out draws an incendiary shell's burning ground itself because no confirm will. Pinned three ways: the spread-zone spec drives a shell with the setting off and asserts the single-target flow **claimed** it (and that no pattern was placed), the fx-rail spec drives the same payload's fires on the rail, and a source leg asserts the damage rail reads the setting **nowhere** of its own. Both specs restore the setting in a `finally`. See §1.1a and §6. |
| **The baton round's final look is not signed off** | ⚠ **The open item of this unit.** The darkening was rejected and the replacement was chosen, built and shipped while the user was away, so what is in the file is the build lane's best call and not a ruling. Three candidates were composed on the rig and photographed on **both** classes the uniformity rule covers — the SMG (rubber 9mm) and the shell (stun-dart 00) — against the rejected look as a control: **59-AB-smg-all-candidates-HELD.png** and **59-AB-shell-all-candidates-HELD.png** are the two grids to open, with per-candidate files 59-control / 59a (slug) / 59b (slug + dust, **shipped**) / 59c (stone) beside them. Every frame is HELD: the crossing time is stretched to 1200 ms for the camera, which is the only value the captures do not show at its shipped setting. A veto is cheap by construction — the whole treatment is `BATON_ROUND` plus one matrix plus one impact key, and the retired matrix is still declared one row field away. |
| The discharge column's on-screen presence at the new trim | The tail ruling cut the clip from 300 ms to 55 ms and a 220 ms dwell replaces the lost presence, so the blast is now a short bright bloom rather than a developing one. Measured delivery is ~160 ms of wall clock rather than the 220 asked for (media start-up plus rate slippage under load). Nothing is wrong; it is a **look** call the user has not yet made in motion — the dwell is one constant. Captures 57a/57c. |
| Audio for the ammo treatments | Sourcing owed; no runtime pitch variation is available on this host (verified against core's audio sources — no `playbackRate`, no `detune`, and the broadcast path discards extra fields). |
| Real decal persistence (scorch, and blood) | Needs a ruling: who owns the write, who cleans it up, what a table does about a scene that accumulates them. Today's scorch is session-bound by choice, and the blood splash is transient by ruling — floor decals were explicitly held out of phase 1. Both change at the same time, in the same way, whenever that ruling arrives. |
| ~~Animations run in slow motion and trail out after the shooting stops~~ | ✅ **CLOSED 2026-08-09.** Measured, not guessed: a fixed per-round sleep against a starved timer compounded to **2.24×** on every burst size tried. Anchored schedule + drop rule brings a 30-round burst from +6 461 ms of drift to **+89 ms**. §4.1a, and the keeper drives both halves. |
| ~~The out-of-combat pattern TTL may not be deleting~~ | ✅ **CHECKED LIVE 2026-08-09, and it works.** A real fired pattern was placed out of combat, was still there at 20 s, and was removed by the module's own interval at **70.0 s** (TTL 60 s + one 15 s tick), with nothing called by hand. What had been seen lingering was a different rule — see the row below. |
| **A started encounter that never advances a round keeps its patterns forever** | ⚠ **Found during the 2026-08-09 autopsy; needs a ruling, not a fix.** 11 patterns were sitting on the rig's review scene 105 minutes after they were thrown. All of them belonged to an encounter that was **started and still on round 3**, and both clocks decline them by design: the wall-clock rule stands down whenever the owning encounter is running (`encounterRunning`), and the round rule only fires on a round **advance**. So an encounter left started and idle makes its patterns immortal. That is the rules as written — a pattern belongs to the round it was thrown on — but a table that stops advancing rounds accumulates them. Options are a wall-clock backstop for in-combat patterns, or a sweep when an encounter is deleted; both are design calls. |
| Blood asks the ACTOR, not the hit location | A cyberlimbed character bleeds even when the round struck the chrome arm. The payload carries how many rounds landed and never where, so the per-zone answer does not exist at draw time; getting it would mean the seam forwarding hit locations to the presentation rail, which is a change to what the payload *is*. Recorded as a known limit, not a defect. |
| The blood splash is routed above the lighting | The one departure from the file's own routing rule, taken because below it the mark does not exist on a dark scene. It is a **look** call the user has not yet made in motion: the cost is that a splash is drawn over ground the viewer cannot see, for under a second. One constant (`BLOOD_SPLATTER.aboveLighting`) reverses it. Captures 58a vs 58d. |
| **The rebuilt blood splash is not signed off** | ⚠ **The open item of this unit.** The direction and the per-hit rule are both rulings and both are built; the remaining numbers are build-lane calls made while the user was away — the payload cap of **4** and the one-grid-unit exit offset that sets the heading. Each is one constant (`BLOOD_SPLATTER.maxPerPayload`; the `+ gridPx` in `fxBloodSplatter`). Captures 64a (angled shot, held) and 64b (burst). |
| **The incendiary load still burns the ground the target is standing on** | ⚠ **Raised by capture 64c, needs a ruling.** The blast ring the report named is gone. But on a hit the aim point *is* the target's square, so the burning ground — which was ruled to stay — still lands there and reads as fire on the target. If what was actually objected to was the fire rather than the ring, the fix is a different one (offset the landing points off the target, or suppress ground fire on a hit). One look at 64c settles which. |
| **The slug is modelled as a LOAD, and that is a build-lane call** | ⚠ **The open item of the spread unit.** The registry has one shotgun cartridge, `"00"`, labelled *"00 Buck / Slug"* — so nothing about the caliber can say which is chambered, and the build expressed the slug as a shotgun-family ammo modifier instead (see §6). The alternative is splitting the cartridge into two registry entries, which is a migration and a re-seed and would break the gauge aliases that currently all point at one id. A veto is cheap by construction: the whole thing is one row in `AMMO_MODIFIERS`, one option on the ammo sheet's spread selector, and the first branch of `spreadModeForAmmo`. |
| One shipped shell weapon records **no gauge** | 10 of the 11 shell weapons in `supplement-shotguns` carry a gauge in `ammoType`; one carries an empty string, so it reports no cartridge and throws no pattern until an ammo item is loaded. Same shape as the known blank-`vehicleType` data gap, and it belongs to the pack-data sweep rather than to this rail. |
| The pattern's look is **verified on v14 only** | `spread-zone-look.js` carries a v13 branch (a MeasuredTemplate's own alpha, and its control icon hidden) written from that core's API and never run: the ship target is v14 and the rig is v14. Structurally the same two facts; it is untested and says so at the site. |
| Exotic weapon palette (bows, beams) | No FX class exists; the arrow ammo loads therefore have no overlay rows. A design unit of its own. |
| Pistol/SMG automatic fire is smokeless | A consequence of retiring the burst smoke stream — `bullet.01` carries none of its own. One row field (`tracer` → `bullet.02.orange`) if that is ever wanted. |
| Vision mask vs. self-luminous sprites | The engine offers no route that clears the darkness and keeps the mask. Accepted, documented at the site. |
