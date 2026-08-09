# The FX rail

*First edition — 2026-08-09. Covers `module/fx/effects.js` and the seam that feeds it.*

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
| `modifier` | the loaded ammo's modifier id — **the ammo overlay's input** | seam shim, from the loaded ammo item |
| `armorMultSoft`, `penDamageMult`, `spreadMode`, `dotType`, … | the loaded ammo's mechanics | seam shim, from the loaded ammo item |

Two target fields exist on purpose. `targetTokenId` decides whether the damage window opens
mid-action; `fxTargetTokenId` only says which way the shot was pointed. Folding them together would
silently move every single-shot and burst card onto the mid-action damage path, which the user
explicitly did not want.

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
| 10 | **Burning ground** | `jb2a.ground_cracks.orange` (GroundCrackLoop) | overlay names `groundFire` **and** ≥ 1 round landed — **once per payload** | yes |
| 11 | **Scorch** | `jb2a.scorched_earth.black` | with #10 | **no** (a black mark is not a light) |
| 12 | **Blood splash** | `jb2a.liquid.splash02.red`, trimmed to 900 ms, random rotation | the world setting **and** ≥ 1 round landed **and** there is a target token **and** that token's actor is not structure — **once per payload** | **yes** — a deliberate departure, below |

**The above-lighting rule.** Anything that *emits* light is routed above the lighting layer; anything
*lit by the world* stays below it. This is not cosmetic: measured on the rig at darkness 1.0, a sprite
left in the primary group crushes to a peak of 15/255 whatever the class or filter, and the same asset
reaches 232 the moment it is routed up. **The cost:** that route is above the *vision* mask too, so a
lifted sprite is drawn across ground the viewer cannot see. The engine offers no route that clears the
darkness and keeps the mask. The muzzle light is unaffected — it is a real light source and still
clips to walls, so the flash stays honest about the room even when the bolt is drawn over it.

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
| `api` | red-shifted (hue −20, sat +0.30, bright 1.20) | fire impact | class | — | **tinted `#ff6a1a`** (dark only) | fire + scorch |
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
fxGroundFire()                     ← once, incendiary + at least one hit; NOT awaited
fxBloodSplatter()                  ← once, gore on + a hit + a flesh target token; NOT awaited
for each round i of shots:
    if i > 0: await cadenceMs      ← the ONE wait in the loop
    sfx()                          ← audio
    fxSmokePuff()                  ← single-discharge classes only; NOT awaited
    fxShot()                       ← light + sprites + tracer + impact; NOT awaited
_watchSettleTag(settleTag, presentationTailMs(class, ammo))
```

Everything a round draws starts in the **same tick** as that round's audio. Nothing in this path waits
on a server. Rounds are capped at `MAX_FX_SHOTS` (30).

Hits are assigned to the **leading** rounds of the burst: the payload knows how many rounds landed,
not which, and inventing an order would be inventing a fact.

**A ruled fumble draws nothing at all** — no light, no sprite, no tracer, no impact, no audio. The gate
is `payload.fumbleRuled` (the base actually resolved a fumble), *not* a natural 1: with the fumble
table switched off a natural 1 is an ordinary bad roll and the weapon really did fire.

### 4.2 The tail, and when the damage window may open

The damage window waits for the rail. Three routes, and each reports which one it took:

| Route | When | Value |
|---|---|---|
| `signal` | normal — the engine reported the last round's terminal elements gone | measured |
| `arithmetic` | no fan-out registered (rail off, unmapped weapon, nothing drawn) | `payloadPresentationMs()` |
| `cap` | the signal never arrived | `PRESENTATION_CAP_MS` (8 s) |

The **terminal elements** are the last round's tracer and impact; only they are named for the engine to
report on. The scheduled tail is the *floor* (never open early) and the fallback.

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
incendiary that loss is covered by the burning ground, which sits at the same point for seconds.

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
| `TRACER_COLOR_INCENDIARY` / `_HARDENED` / `_BATON` | see §3.2 | the ammo colour shifts |
| `TRACER_COLOR_INERT` | hue 0, sat −0.55, bright 0.60 | ⏪ **retired from use** — the rejected darkening; declared, on no shipped row |
| `BATON_ROUND` | `throwable.launch.cannon_ball.01.black`, 2.4 sq frame, 240 ms crossing | the whole less-lethal representation, in one block |
| `IMPACT_FIRE` / `IMPACT_CRACK` / `IMPACT_DUST` | keys + measured clip lengths | the promoted impacts |
| `AMMO_FX_RECOLOR_FIELDS` / `AMMO_FX_REPLACE_FIELDS` | colour pair / asset pair | which overlay fields may only repaint an element the class already declares |
| `GROUND_FIRE.lifetimeMs` | 3200 | how long the burning ground burns |
| `GROUND_SCORCH.lifetimeMs` | 180000 | the scorch's cap — **minutes, not forever** |
| `BLOOD_SPLATTER.key` | `jb2a.liquid.splash02.red` | the splash asset — **natively blood-coloured, no filter is applied** |
| `BLOOD_SPLATTER.squares` | 1.5 | the drawn **frame** width in grid units; the ink is ~0.75 sq at 170 ms, ~1.3 sq at peak |
| `BLOOD_SPLATTER.clipMs` | 900 | the trim — content is spent by ~700 ms of an 1133 ms file |
| `BLOOD_SPLATTER.aboveLighting` | `true` | the documented departure from the routing rule (§2) |
| `MUZZLE_SMOKE.*` | see the block | one puff's size, phase, drift and cap |
| `MUZZLE_MOTES.*` | see the block | speck geometry, all off the reference frame |
| `PRESENTATION_CAP_MS` | 8000 | hard ceiling on how long the damage window may be held |
| `APPLY_LEAD_MS` | 150 | how far ahead of the engine's report the window may open |
| `SETTLE_CONFIRM_MS` | 60 | how long "all ended" must hold before it is believed |
| `FACE_TARGET.durationMs` / `minDegrees` | 220 / 5 | the turn sweep and its dead zone |

Test/capture seams (**nothing ships with one armed**): `_setFlashLevels`, `_setDashMs`,
`_setSpriteRate`, `_setDbProbe`, `_setSoundManifest`.

---

## 6. Rulings log

Dated decisions, mined from the supersession chains in the code. Values and *why*, never change
history. ⏪ marks a decision that reversed an earlier one.

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
| **BLOOD, 2026-08-09** | The **radial** liquid, not the side one | Measured centroids: `splash02.red` holds at 0.50/0.51 of its own frame from 170 ms to 510 ms, so it is radial about its centre and needs no rotation to agree with the shot; `splash_side02.red` traverses 0.29 → 0.65 and is a directional wave. Rotation is randomised only so two hits are not the same picture. |
| **BLOOD, 2026-08-09** | Size is the drawn **frame**, 1.5 sq; trim is where the **content** ends, 900 ms | Ink coverage falls from 17.1% of the frame at 283 ms to 0.07% at 680 ms and peak alpha is 5/255 by 963 ms, so 900 keeps every frame that has anything in it. The frame-vs-ink distinction is the same trap the flechette dart length records. |
| **BLOOD, 2026-08-09** | Drawn **above the lighting**, against this file's own routing rule | Below it, on a dark scene, the mark does not exist (capture 58d). The accepted cost is the vision mask, for under a second. Stated as a departure with a knob rather than folded in silently. |
| **BLOOD, 2026-08-09** | **Once per payload**, and never part of the settle wait | The same rule and the same reason as the burning ground: the fan-out caps at 30 rounds, and the damage window may not be held for scene dressing. |
| **BATON, 2026-08-09** | ⏪⏪ The rubber / stun-dart **darkening is rejected outright**, not re-tuned | "What you did for rubber bullets doesn't look good. Instead of darkening/muting the color, let's look for a better asset to represent rubber bullets." The old treatment was a bolt at brightness **0.60** and a mark at **× 0.60**. Its premise was not wrong about the round — a baton round does carry less energy — it was wrong about the **screen**: a dimmed sprite on a dark scene is not a quieter round, it is a round the eye has to hunt for. Capture 59-control. Both halves are gone, including the shrink: a blunt round makes a *different* mark, not a *smaller* one. |
| **BATON, 2026-08-09** | The load is now said with a **different asset**: the round is a solid travelled slug | `jb2a.throwable.launch.cannon_ball.01.black`, sized 2.4 sq of frame (≈ 0.25–0.55 sq of actual ball, measured) and crossing in **240 ms** — the slowest thing the rail fires. Chosen from a closed enumeration of the tier's ranged family, not by name: `bullet.03.blue` develops a full spiky starburst at 0.30 s (the 2026-08-08 no-starburst ruling is about the shape, not the colour); `snowball_toss` ends in snowflakes; `boulder.toss.02` is legible but its art travels *backward* across its own frame (centroid 0.46 → 0.27 → 0.65) and reads as a thrown stone. Captures 59a / 59b / 59c. |
| **BATON, 2026-08-09** | The round is **travelled**, not painted — and that is a correctness choice, not a style one | A painted tracer's on-screen life is the *asset's* clip, bounded once for the whole rail by `TRACER_CLIP_MS` = 933. This asset's five distance bands are 467 / 767 / 1167 / 2067 / 2433 ms, so painting it would put two of them past that bound and the tail would come back short with no signal — exactly the silent, one-directional failure `presentationTailMs` exists to prevent. A travelled sprite's life is `dashMs + 260` and owes the asset nothing. |
| **BATON, 2026-08-09** | The hit mark becomes a **dust puff** (`jb2a.smoke.puff.ring.01.white`) | Enumerated the same way. Every blue impact on the tier (`001`–`004`, `011`, `012`) is a spike starburst; `impact.water.02.blue` reads liquid; `side_impact.part.smoke.*` is crystalline shards at 3067 ms; `smoke.puff.centered.grey` peaks at luminance 87/255 and is too faint to read as an arrival. The one genuinely *blunt* alternative — `side_impact.part.shockwave.blue`, a concentric ring wave — is rejected on **mechanism**, not looks: its arcs face one baked direction and the impact is drawn with no rotation, so it would point the same way whichever way the shot went. The chosen puff is radial, peaks at 217/255, and takes no `impactClipMs`, so the promotion rule trims it to the ordinary mark's 833 ms unchanged. |
| **BATON, 2026-08-09** | **One matrix** repaints the slug *and* the shell's discharge column | `TRACER_COLOR_BATON` = hue 0, sat −0.85, **brightness 1.30**. The number to read is 1.30 — above 1, where the rejected value was 0.60. It says a different true thing about each element it touches: the slug's art is already greyscale (mean luminance 99/255 measured), so the *brightness* is what lifts it off a black floor; the column is `bullet.02`'s orange bloom, so the *desaturation* is what turns a fire blast into the pale gas flash of a reduced-pressure load. One matrix rather than two is what makes the shell's two elements agree — the standing uniformity ruling. |
| **BATON, 2026-08-09** | The masked-merge rule is widened from **colour** to **asset** | The baton treatment is the first overlay that swaps a *file*, and a bare overwrite would have made `column` a way to hand a pistol a shotgun's discharge blast — one field away from what `columnColor` is already forbidden to do. `AMMO_FX_REPLACE_FIELDS` puts `tracer` and `column` behind the same key-presence mask. No shipped behaviour changes; the guarantee becomes structural instead of conventional. |
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
once-per-payload ground gate and the flash tint through the darkness gate · two real sessions, to
prove the socket relay draws a flash on a client the fire never ran on · a non-GM session driving a
write, because a rule that reads right and a write the server refuses look identical from the GM's
side · 0 console errors.

**Assertion style.** Every pure helper on the rail (`muzzleSourceSpecs`, `pelletEndpoints`,
`moteEndpoints`, `smokePuffPlan`, `presentationTailMs`, `flashColorFor`, `ammoFxEntry`, …) takes an
injectable `rng` or plain arguments precisely so its output is asserted **by value**, with no canvas,
no engine and no shot. Anything that cannot be — which asset was queued, how many were emitted, what
colour a source was built with — is driven live and read back off the engine.

**The baton pair's legs are written as the inverse of the ones they replace.** Two legs used to assert
that this pair's matrix was the only one that *darkened* and that it drew a *dull bolt and a small mark*.
Both facts are now false by design, so the replacements assert the opposite on purpose: that **no** live
matrix darkens and that the retired one appears on **no** shipped row; that the load is said with a
different asset on every class; that a class which painted its round now travels it; that the shell's
shot **count** and spread are untouched while its size and speed are replaced; that the mark is the dust
key at the class's own width with no `impactScale` anywhere; and that the tail is `240 + 833` on all five
classes. Two legs drive it live and read the file the *engine* was handed rather than the merge — an asset
swap is exactly the change a value-only assertion cannot see.

The gore unit added a section of its own, and it is almost entirely negatives, because four
independent gates each mean "this must NOT be drawn": the switch registered world-scoped and shipping
OFF · the reader following it both ways · the target-type answer by value for flesh, npc, vehicle,
powered armour, full conversion and the ruled cyberlimb case (which also asserts that the *zone*
routes to structure while the *actor* does not) · the asset key resolving on the free tier and the
installed file measuring the length the trim was chosen against · then live: nothing with the switch
off, exactly ONE splash from a ten-round burst, nothing on a vehicle, nothing on a full conversion,
nothing on a ruled fumble, nothing on a burst that misses, nothing when no token was aimed at, and the
scheduled tail identical with the switch on and off.

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

**Provisioning.** `tests/cp2020-augmented-provision-fx-ammo.mjs` stocks one ammo item per treated
modifier on the review shooter, in a caliber one of its own weapons takes. It is idempotent and never
changes what a weapon has loaded, so a reviewer swaps loads from the sheet and fires the same gun
twice.

---

## 8. Open items

| Item | State |
|---|---|
| **The baton round's final look is not signed off** | ⚠ **The open item of this unit.** The darkening was rejected and the replacement was chosen, built and shipped while the user was away, so what is in the file is the build lane's best call and not a ruling. Three candidates were composed on the rig and photographed on **both** classes the uniformity rule covers — the SMG (rubber 9mm) and the shell (stun-dart 00) — against the rejected look as a control: **59-AB-smg-all-candidates-HELD.png** and **59-AB-shell-all-candidates-HELD.png** are the two grids to open, with per-candidate files 59-control / 59a (slug) / 59b (slug + dust, **shipped**) / 59c (stone) beside them. Every frame is HELD: the crossing time is stretched to 1200 ms for the camera, which is the only value the captures do not show at its shipped setting. A veto is cheap by construction — the whole treatment is `BATON_ROUND` plus one matrix plus one impact key, and the retired matrix is still declared one row field away. |
| The discharge column's on-screen presence at the new trim | The tail ruling cut the clip from 300 ms to 55 ms and a 220 ms dwell replaces the lost presence, so the blast is now a short bright bloom rather than a developing one. Measured delivery is ~160 ms of wall clock rather than the 220 asked for (media start-up plus rate slippage under load). Nothing is wrong; it is a **look** call the user has not yet made in motion — the dwell is one constant. Captures 57a/57c. |
| Audio for the ammo treatments | Sourcing owed; no runtime pitch variation is available on this host (verified against core's audio sources — no `playbackRate`, no `detune`, and the broadcast path discards extra fields). |
| Real decal persistence (scorch, and blood) | Needs a ruling: who owns the write, who cleans it up, what a table does about a scene that accumulates them. Today's scorch is session-bound by choice, and the blood splash is transient by ruling — floor decals were explicitly held out of phase 1. Both change at the same time, in the same way, whenever that ruling arrives. |
| Blood asks the ACTOR, not the hit location | A cyberlimbed character bleeds even when the round struck the chrome arm. The payload carries how many rounds landed and never where, so the per-zone answer does not exist at draw time; getting it would mean the seam forwarding hit locations to the presentation rail, which is a change to what the payload *is*. Recorded as a known limit, not a defect. |
| The blood splash is routed above the lighting | The one departure from the file's own routing rule, taken because below it the mark does not exist on a dark scene. It is a **look** call the user has not yet made in motion: the cost is that a splash is drawn over ground the viewer cannot see, for under a second. One constant (`BLOOD_SPLATTER.aboveLighting`) reverses it. Captures 58a vs 58d. |
| Exotic weapon palette (bows, beams) | No FX class exists; the arrow ammo loads therefore have no overlay rows. A design unit of its own. |
| Pistol/SMG automatic fire is smokeless | A consequence of retiring the burst smoke stream — `bullet.01` carries none of its own. One row field (`tracer` → `bullet.02.orange`) if that is ever wanted. |
| Vision mask vs. self-luminous sprites | The engine offers no route that clears the darkness and keeps the mask. Accepted, documented at the site. |
