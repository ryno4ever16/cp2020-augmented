/**
 * vehicle-weapon-catalog.js — Phase 5b seed catalog for Maximum Metal vehicle weapons.
 *
 * Engine-first build: one VERIFIED representative weapon per resolution class (A–F), checked
 * against the MM stat tables. The full ~80-weapon catalog is authored later as a dedicated pass.
 * Each entry's Penetration is the parenthetical (n) read directly from the book (MM p.4/17/19/20).
 *
 * Tests import SEED_VEHICLE_WEAPONS directly to create Items; seedVehicleWeaponCompendium()
 * populates the "Vehicle Weapons (MM)" compendium (idempotent) so GMs can drag them onto vehicles.
 */

import { mmEnabled } from "../settings.js";

const ICON = "icons/svg/explosion.svg";
const SOURCE = "Maximum Metal";

/** The seed weapons. system fields match CyberpunkVehicleWeaponData (item-data.js). */
export const SEED_VEHICLE_WEAPONS = [
  // A — Direct-fire ballistic. 20-25mm autocannon (MM p.17: 8D10, Pen 4, ROF 10, 800m).
  {
    name: "20mm Autocannon", img: ICON,
    system: {
      weaponClass: "directFire", mountType: "turret", arc: "turret",
      wa: 0, penetration: 4, damage: "8D10", ap: false,
      rof: 10, shots: 100, range: 800, reliability: "VR",
      space: 1, cost: 3000, source: SOURCE
    }
  },
  // B — Direct HE/HEAT (burst via shell variants). 105mm Cannon (MM p.17: Pen 10; Hi-Ex 6/6m; HEAT 11*/2m).
  {
    name: "105mm Cannon", img: ICON,
    system: {
      weaponClass: "directFire", mountType: "turret", arc: "turret",
      wa: 1, penetration: 10, damage: "", rof: 1, shots: 1, range: 1000, reliability: "ST",
      space: 10, cost: 250000, source: SOURCE,
      shellVariants: [
        { name: "Hi-Ex (105mm)", pen: 6, burst: 6, hiEx: true },
        { name: "HEAT (105mm)", pen: 11, burst: 2, heat: true, ap: true }
      ]
    }
  },
  // C — Unguided rocket (HE, range-immune, burst). 2.75" Rocket (MM p.19: 8D10, Pen 4, 6m burst, 500m).
  {
    name: "2.75\" Rocket", img: ICON,
    system: {
      weaponClass: "rocket", mountType: "pod", arc: "front",
      wa: -2, penetration: 4, damage: "8D10", hiEx: true, burst: 6,
      rof: 1, shots: 1, range: 500, reliability: "VR",
      space: 1, cost: 200, source: SOURCE
    }
  },
  // D — Guided missile (paint guidance, HEAT). Hellfire (MM p.19: Pen 21*, 4m burst, 3000m, paint).
  {
    name: "Hellfire", img: ICON,
    system: {
      weaponClass: "missile", mountType: "pod", arc: "front", guidance: "paint", homingMethod: "laser",
      wa: 0, penetration: 21, damage: "20D10AP", heat: true, ap: true, burst: 4,
      rof: 1, shots: 1, range: 3000, minRange: 300, reliability: "VR",
      space: 1, cost: 10000, source: SOURCE
    }
  },
  // E — Artillery / indirect (HE, burst). 105mm Howitzer (MM p.20: WA +1, Pen 6, 6m burst, 17000m).
  // Shell variants cover the artillery ammunition types (MM p.21): the warhead drives the resolver
  // (cluster/chemical ×3 the burst; WP burns; AP doubles Pen and drops the burst, howitzers only).
  {
    name: "105mm Howitzer", img: ICON,
    system: {
      weaponClass: "artillery", mountType: "fixed", arc: "front",
      wa: 1, penetration: 6, hiEx: true, burst: 6,
      rof: 1, shots: 1, range: 17000, reliability: "VR",
      space: 6, cost: 100000, source: SOURCE,
      shellVariants: [
        { name: "105mm AP", pen: 12, burst: 0, ap: true },                  // ×2 Pen on the 105mm, Burst 0
        { name: "105mm WP", pen: 0, burst: 6, warhead: "wp" },              // burn DOT, no Pen
        { name: "105mm Cluster", pen: 4, burst: 6, warhead: "cluster" },    // ×3 burst (→18m), Pen 4
        { name: "105mm Chemical", pen: 0, burst: 6, warhead: "chemical" }   // ×3 burst (→18m), gas cloud
      ]
    }
  },
  // D — Bomb (direct hit ×5 Pen). 250-lb GP bomb (MM p.22: WA −3, Pen 6, 16m burst).
  {
    name: "250-lb Bomb", img: ICON,
    system: {
      weaponClass: "bomb", mountType: "pod", arc: "front",
      wa: -3, penetration: 6, hiEx: true, burst: 16,
      rof: 1, shots: 1, range: 0, reliability: "VR",
      space: 3, cost: 600, source: SOURCE,
      shellVariants: [
        { name: "250-lb Cluster", pen: 4, burst: 16, warhead: "cluster" },   // ×3 burst, Pen 4
        { name: "250-lb Anti-Tank", pen: 6, burst: 4, warhead: "heat", heat: true, ap: true },
        { name: "250-lb Incendiary", pen: 0, burst: 16, warhead: "wp" }      // fire (reuses WP ignition)
      ]
    }
  },
  // F — Cone / scatter-pack (ACPA). BRP Ripple Flechette Pack (MM p.73: WA +4, Pen 3 AP, 60° cone, 24 proj, 15m).
  {
    name: "BRP Ripple Flechette Pack", img: ICON,
    system: {
      weaponClass: "cone", mountType: "open", arc: "front",
      wa: 4, penetration: 3, damage: "3D10AP", ap: true,
      coneAngle: 60, projectiles: 24, rof: 1, shots: 6, range: 15, reliability: "VR",
      space: 1, cost: 500, source: SOURCE
    }
  },
  // Additional ACPA scatter packs (MM p.73; BRP-anchored). DAMAGE dice OCR-cleaned (verify); (Pen) book-given.
  { name: "BFC-2 Flechette Cloud", img: ICON, system: { weight: 2, magWeight: 0, notes: "Needle-cloud anti-personnel scatter, 120° cone; mows down soft/light infantry, ineffective vs PA.",
      weaponClass: "cone", mountType: "open", arc: "front", wa: 6, penetration: 2, damage: "2D10AP", ap: true,
      coneAngle: 120, projectiles: 144, rof: 1, shots: 1, range: 25, reliability: "VR",
      space: 1, cost: 300, sp: 20, sdp: 20, area: "torso", source: SOURCE } },
  { name: "BFC-3 Flechette Cloud", img: ICON, system: { weight: 2, magWeight: 0, notes: "Highest needle count, 120° cone; widest soft-target spread, weakest per-hit, no effect vs PA.",
      weaponClass: "cone", mountType: "open", arc: "front", wa: 9, penetration: 1, damage: "1D10AP", ap: true,
      coneAngle: 120, projectiles: 288, rof: 1, shots: 1, range: 30, reliability: "VR",
      space: 1, cost: 300, sp: 20, sdp: 20, area: "torso", source: SOURCE } },
  { name: "BFC-4 Flechette Cloud", img: ICON, system: { weight: 2, magWeight: 0, notes: "Heaviest flechette cloud, 120° cone; the only BFC that bites light/medium PA.",
      weaponClass: "cone", mountType: "open", arc: "front", wa: 3, penetration: 4, damage: "4D10AP", ap: true,
      coneAngle: 120, projectiles: 72, rof: 1, shots: 1, range: 20, reliability: "VR",
      space: 1, cost: 1200, sp: 20, sdp: 20, area: "torso", source: SOURCE } },
  { name: "BFC-WA Flechette Cloud", img: ICON, system: { weight: 2, magWeight: 0, notes: "Wide-angle 180° flechette cloud; sweeps the broadest arc of soft targets.",
      weaponClass: "cone", mountType: "open", arc: "front", wa: 5, penetration: 2, damage: "2D10AP", ap: true,
      coneAngle: 180, projectiles: 144, rof: 1, shots: 1, range: 30, reliability: "VR",
      space: 1, cost: 300, sp: 20, sdp: 20, area: "torso", source: SOURCE } },
  { name: "BIM Minelet Volley", img: ICON, system: { weight: 2, magWeight: 0, notes: "Seeds a 60° cone with pressure-triggered mini-mines (maim legs/feet; non-PA flung 1-2m). Fired direct, they detonate on contact.",
      weaponClass: "cone", mountType: "open", arc: "front", wa: 3, penetration: 1, damage: "4D6",
      coneAngle: 60, projectiles: 50, rof: 1, shots: 1, range: 50, reliability: "VR",
      space: 1, cost: 1000, sp: 20, sdp: 20, area: "torso", source: SOURCE } },         // seeds mini-mines in a 60° cone
  { name: "BSP Variety Show", img: ICON, system: { weight: 2, magWeight: 0, notes: "Multi-munition launcher — loads rubber/smoke/paint/phosphorus pellets, delayed minelets, or pyrotechnics; effect varies by load.",
      weaponClass: "cone", mountType: "open", arc: "front", wa: 3, penetration: 0, damage: "",
      coneAngle: 60, projectiles: 50, rof: 1, shots: 1, range: 50, reliability: "VR",
      space: 1, cost: 300, sp: 20, sdp: 20, area: "torso", source: SOURCE } },           // SPECIAL: fires variety pellets (rubber/smoke/paint/phosphorus/minelet, p.74)

  // ───────────────────────── ACPA weapon roster (Maximum Metal charts, Appendix A p.95-96) ─────────────────────────
  // Each carries its own SP/SDP (ACPA mounting + per-weapon hit tracking). `area` defaults to torso;
  // re-assign it on the suit. ROF "N OR M" → rof N (high) / rofAlt M.

  // Heavy MGs & rifle (p.95).
  { name: "12.7mm Heavy MG", img: ICON, system: {
      weaponClass: "directFire", mountType: "articulated", arc: "front", wa: 1,
      penetration: 3, damage: "6D10", rof: 10, rofAlt: 5, shots: 100, range: 550, reliability: "VR",
      space: 2, cost: 2000, sp: 25, sdp: 30, area: "rArm", source: SOURCE } },
  { name: "14.5mm Heavy MG", img: ICON, system: {
      weaponClass: "directFire", mountType: "articulated", arc: "front", wa: 0,
      penetration: 4, damage: "7D10", rof: 5, rofAlt: 3, shots: 100, range: 550, reliability: "VR",
      space: 3, cost: 4000, sp: 20, sdp: 15, area: "rArm", source: SOURCE } },
  { name: "4mm Railgun", img: ICON, system: {
      weaponClass: "directFire", mountType: "articulated", arc: "front", wa: 3,
      penetration: 7, damage: "5D10+10AP", ap: true, rof: 1, shots: 5, range: 1500, reliability: "ST",
      space: 2, cost: 12000, sp: 15, sdp: 10, area: "rArm", source: SOURCE } },

  // ACPA cannon (p.96).
  { name: "BCL-20 ACPA Cannon", img: ICON, system: {
      weaponClass: "directFire", mountType: "articulated", arc: "front", wa: 1,
      penetration: 4, damage: "9D10", rof: 2, shots: 20, range: 550, reliability: "VR",
      space: 2, cost: 2700, sp: 25, sdp: 35, area: "rArm", source: SOURCE } },
  { name: "27-30mm Autocannon", img: ICON, system: {
      weaponClass: "directFire", mountType: "articulated", arc: "front", wa: 0,
      penetration: 5, damage: "9D10", rof: 10, shots: 50, range: 600, reliability: "VR",
      space: 3, cost: 4000, sp: 30, sdp: 30, area: "rArm", source: SOURCE } },
  { name: "EMG-83 Improved Railgun", img: ICON, system: {
      weaponClass: "directFire", mountType: "articulated", arc: "front", wa: 2,
      penetration: 7, damage: "5D10+10AP", ap: true, rof: 1, shots: 10, range: 1000, reliability: "ST",
      space: 3, cost: 17500, sp: 25, sdp: 15, area: "rArm", source: SOURCE } },
  { name: "75mm Recoilless", img: ICON, system: {
      weaponClass: "directFire", mountType: "articulated", arc: "front", wa: 0,
      penetration: 8, damage: "8D10AP", ap: true, heat: true, rof: 1, shots: 4, range: 500, reliability: "VR",
      space: 2, cost: 15000, sp: 15, sdp: 20, area: "rArm", source: SOURCE } },

  // Rockets (p.96) — unguided HE (range-immune), burst.
  { name: "IFAR Rocket", img: ICON, system: {
      weaponClass: "rocket", mountType: "pod", arc: "front", wa: -2,
      penetration: 4, damage: "8D10", hiEx: true, burst: 6, rof: 1, shots: 1, range: 500, reliability: "VR",
      space: 2, cost: 200, sp: 20, sdp: 30, area: "torso", source: SOURCE } },
  { name: "IFAR 6-Pod", img: ICON, system: {
      weaponClass: "rocket", mountType: "pod", arc: "front", wa: -2,
      penetration: 4, damage: "8D10", hiEx: true, burst: 6, rof: 1, shots: 6, range: 500, reliability: "VR",
      space: 4, cost: 4200, sp: 20, sdp: 105, area: "torso", source: SOURCE } },
  { name: "LAW-III", img: ICON, system: {
      weaponClass: "rocket", mountType: "pod", arc: "front", wa: -2,
      penetration: 4, damage: "4D10AP", ap: true, heat: true, burst: 2, rof: 1, shots: 1, range: 200, reliability: "VR",
      space: 1, cost: 300, sp: 20, sdp: 10, area: "torso", source: SOURCE } },

  // Guided missiles (p.96) — HEAT, paint/active.
  { name: "Light ATGM", img: ICON, system: {
      weaponClass: "missile", mountType: "pod", arc: "front", guidance: "paint", homingMethod: "laser", wa: 2,
      penetration: 12, damage: "12D10AP", ap: true, heat: true, burst: 4, rof: 1, shots: 1, range: 1000, minRange: 100, reliability: "VR",
      space: 2, cost: 3000, sp: 20, sdp: 20, area: "torso", source: SOURCE } },
  { name: "Spectre ATGM", img: ICON, system: {
      weaponClass: "missile", mountType: "pod", arc: "front", guidance: "active", homingMethod: "radar", guidanceSkill: 15, wa: 0,
      penetration: 18, damage: "18D10AP", ap: true, heat: true, burst: 4, rof: 1, shots: 1, range: 3000, minRange: 300, reliability: "VR",
      space: 2, cost: 10000, sp: 20, sdp: 25, area: "torso", source: SOURCE } },

  // Grenade launchers (p.96) — burst HE (standard grenade defaults; swap shells for other warheads).
  { name: "Tsunami 25mm Grenade Launcher", img: ICON, system: {
      weaponClass: "burst", mountType: "articulated", arc: "front", wa: 0,
      penetration: 4, damage: "", hiEx: true, burst: 5, rof: 3, rofAlt: 1, shots: 20, range: 1500, reliability: "VR",
      space: 1, cost: 1700, sp: 20, sdp: 25, area: "rArm", source: SOURCE } },
  { name: "40mm Auto-Grenade Launcher", img: ICON, system: {
      weaponClass: "burst", mountType: "articulated", arc: "front", wa: 1,
      penetration: 4, damage: "", hiEx: true, burst: 5, rof: 20, rofAlt: 3, shots: 50, range: 1600, reliability: "VR",
      space: 2, cost: 2500, sp: 25, sdp: 30, area: "rArm", source: SOURCE } },

  // Beam (MM p.72) — power-adjustable laser. Modelled with shell-variant PRESETS as the power dial:
  // base = Full 10D6/Pen4; pick a lower setting from the fire dialog's shell dropdown (dice + Pen drop
  // together per the book's table, 10D6=4 … 2D6=0). Pen set to 4 (book max) — was the flagged 6.
  { name: "\"Photon\" Assault Cannon", img: ICON, system: { weight: 40, magWeight: 0, notes: "Pre-existing. Meta-Armson dual-element combat laser. Power-adjustable from the fire dialog's shell dropdown: Full 10D6/Pen4 down to 2D6/Pen0 (MM p.72). 30 shots off a backpack battery; UR reliability.",
      weaponClass: "special", mountType: "articulated", arc: "front", wa: 2,
      penetration: 4, damage: "10D6AP", ap: true, rof: 2, shots: 30, range: 300, reliability: "ST",
      space: 3, cost: 80000, sp: 15, sdp: 10, area: "rArm", source: SOURCE,
      shellVariants: [
        { name: "9D6", damage: "9D6AP", pen: 3, ap: true },
        { name: "7D6", damage: "7D6AP", pen: 2, ap: true },
        { name: "4D6", damage: "4D6AP", pen: 1, ap: true },
        { name: "2D6", damage: "2D6AP", pen: 0, ap: true }
      ] } },

  // Melee (p.95) — ACPA hand weapons (used via the melee dialog; tracked here for mounting + SDP).
  { name: "Retractable Mono-PA Sword", img: ICON, system: {
      weaponClass: "melee", mountType: "articulated", arc: "front", wa: 1,
      penetration: 6, damage: "4D6AP", ap: true, addFist: true, rof: 1, shots: 1, range: 2, reliability: "VR",
      space: 1, cost: 2000, sp: 0, sdp: 15, area: "rArm", source: SOURCE } },          // 4d6AP+FIST (6+SPECIAL), p.71
  { name: "Large Power Saw", img: ICON, system: {
      weaponClass: "melee", mountType: "articulated", arc: "front", wa: -2,
      penetration: 6, damage: "8D6AP", ap: true, rof: 1, shots: 1, range: 2, reliability: "ST",
      space: 1, cost: 1250, sp: 20, sdp: 25, area: "rArm", source: SOURCE } },          // 8d6AP(6), no FIST (powered saw), p.71
  // Armed melee — weapon dice + chassis FIST (round(STR/9) d10). MM p.70-71; Pen = (n) + fist Pen.
  { name: "Heavy Bladed Weapon (1-Hand)", img: ICON, system: { weight: 6, magWeight: 0, notes: "One-handed powered blade; damage = its dice + chassis FIST, Pen = listed + fist's Pen. Sheathed external mount.",
      weaponClass: "melee", mountType: "articulated", arc: "front", wa: 1,
      penetration: 4, damage: "4D6AP", ap: true, addFist: true, rof: 1, shots: 1, range: 2, reliability: "VR",
      space: 0.5, cost: 550, sp: 20, sdp: 20, area: "rArm", source: SOURCE } },
  { name: "Heavy Bladed Weapon (2-Hand)", img: ICON, system: { weight: 10, magWeight: 0, notes: "Two-handed powered blade; bigger dice, same FIST-boosted melee. Sheathed external mount.",
      weaponClass: "melee", mountType: "articulated", arc: "front", wa: -1,
      penetration: 5, damage: "6D6AP", ap: true, addFist: true, rof: 1, shots: 1, range: 3, reliability: "VR",
      space: 1, cost: 1000, sp: 20, sdp: 30, area: "rArm", source: SOURCE } },
  { name: "Heavy Blunt Weapon (1-Hand)", img: ICON, system: { weight: 10, magWeight: 0, notes: "One-handed powered bludgeon; crushing (non-AP) damage plus chassis FIST.",
      weaponClass: "melee", mountType: "articulated", arc: "front", wa: 0,
      penetration: 2, damage: "4D6", addFist: true, rof: 1, shots: 1, range: 2, reliability: "VR",
      space: 0.5, cost: 200, sp: 20, sdp: 25, area: "rArm", source: SOURCE } },
  { name: "Heavy Blunt Weapon (2-Hand)", img: ICON, system: { weight: 20, magWeight: 0, notes: "Two-handed powered bludgeon; heavy crushing damage plus chassis FIST.",
      weaponClass: "melee", mountType: "articulated", arc: "front", wa: -1,
      penetration: 3, damage: "6D6", addFist: true, rof: 1, shots: 1, range: 3, reliability: "VR",
      space: 1, cost: 500, sp: 20, sdp: 40, area: "rArm", source: SOURCE } },
  { name: "Heavy Pointed Weapon (2-Hand)", img: ICON, system: { weight: 6, magWeight: 0, notes: "Two-handed powered spear/pick; AP thrust plus FIST; longest melee reach (5m).",
      weaponClass: "melee", mountType: "articulated", arc: "front", wa: 0,
      penetration: 2, damage: "3D6AP", ap: true, addFist: true, rof: 1, shots: 1, range: 5, reliability: "VR",
      space: 1, cost: 225, sp: 20, sdp: 15, area: "rArm", source: SOURCE } },

  // ═════════════════ NON-ACPA VEHICLE WEAPON TABLES (Maximum Metal p.16-23, verified) ═════════════════
  // Decoded from the MM weapon charts + their descriptions. DAMAGE dice drive the PC↔vehicle bridge and the
  // ACPA SDP flow; the (Pen) is the book's pre-derived Vehicle Penetration. HEAT/Hi-Ex Penetration ignores
  // range (hefPenetrator) and HEAT is halved by Composite Armor; cannons carry Hi-Ex/HEAT shell variants.
  // (Weapons already covered by the ACPA roster above — 20mm/27-30mm autocannon, 75mm recoilless, EMG-83,
  // 12.7/14.5mm heavy MG, 40mm Auto-GL, 2.75" rocket, Light ATGM, Spectre ATGM, 105mm Howitzer — are not repeated.)

  // ── Machine guns, miniguns & gatlings (p.17). Small-arms D6 weapons; the book Pen already halves the factor. ──
  { name: "5.56mm Minigun", img: ICON, system: { weaponClass:"directFire", mountType:"pintle", arc:"turret",
      wa:0, penetration:2, damage:"5D6", rof:100, shots:1000, range:450, reliability:"ST", space:1, cost:2000, source:SOURCE } },
  { name: "5.56mm Machinegun", img: ICON, system: { weaponClass:"directFire", mountType:"pintle", arc:"turret",
      wa:1, penetration:2, damage:"5D6", rof:10, shots:100, range:500, reliability:"VR", space:1, cost:1200, source:SOURCE } },
  { name: "7.62mm Minigun", img: ICON, system: { weaponClass:"directFire", mountType:"pintle", arc:"turret",
      wa:0, penetration:2, damage:"6D6+2", rof:100, shots:2000, range:600, reliability:"VR", space:1, cost:4000, source:SOURCE } },
  { name: "7.62mm Machinegun", img: ICON, system: { weaponClass:"directFire", mountType:"pintle", arc:"turret",
      wa:0, penetration:2, damage:"6D6+2", rof:10, shots:100, range:500, reliability:"VR", space:1, cost:1200, source:SOURCE } },
  { name: "12.7mm Gatling", img: ICON, system: { weaponClass:"directFire", mountType:"turret", arc:"turret",
      wa:0, penetration:3, damage:"6D10", rof:100, shots:1000, range:600, reliability:"ST", space:1, cost:6000, source:SOURCE } },
  { name: "12.7mm Machinegun", img: ICON, system: { weaponClass:"directFire", mountType:"pintle", arc:"turret",
      wa:0, penetration:3, damage:"6D10", rof:10, shots:100, range:800, reliability:"VR", space:1, cost:2000, source:SOURCE } },
  { name: "20mm Gatling", img: ICON, system: { weaponClass:"directFire", mountType:"turret", arc:"turret",
      wa:0, penetration:4, damage:"8D10", rof:100, shots:1000, range:500, reliability:"VR", space:2, cost:6000, source:SOURCE } },
  // 30mm Gatling fires depleted-uranium slugs — high-density AP (full damage through armor, errata p.107/110).
  { name: "30mm Gatling", img: ICON, system: { weaponClass:"directFire", mountType:"turret", arc:"turret",
      wa:0, penetration:6, damage:"6D10AP", ap:true, highDensityAP:true, rof:30, shots:1200, range:750, reliability:"VR", space:4, cost:25000, source:SOURCE } },

  // ── Anti-tank guns & grenade launchers (p.17). ──
  { name: "LATG 37mm", img: ICON, system: { weaponClass:"directFire", mountType:"turret", arc:"turret",
      wa:3, penetration:6, damage:"6D10AP", ap:true, rof:1, shots:10, range:800, reliability:"VR", space:2, cost:10000, source:SOURCE } },
  { name: "40mm Grenade Launcher", img: ICON, system: { weaponClass:"burst", mountType:"articulated", arc:"front",
      wa:1, penetration:2, damage:"", hiEx:true, burst:5, rof:1, shots:1, range:500, reliability:"VR", space:1, cost:500, source:SOURCE,
      shellVariants:[{ name:"40mm HEDP (anti-tank)", pen:4, burst:1, heat:true, ap:true }] } },

  // ── Cannons (p.17). Base line = the solid round (Pen); Hi-Ex + HEAT are shell variants. ──
  { name: "75mm Cannon", img: ICON, system: { weaponClass:"directFire", mountType:"turret", arc:"turret",
      wa:1, penetration:7, damage:"", rof:2, shots:10, range:1500, reliability:"VR", space:4, cost:75000, source:SOURCE,
      shellVariants:[{ name:"75mm Hi-Ex", pen:4, burst:5, hiEx:true }, { name:"75mm HEAT", pen:8, burst:2, heat:true, ap:true }] } },
  { name: "90mm Cannon", img: ICON, system: { weaponClass:"directFire", mountType:"turret", arc:"turret",
      wa:0, penetration:9, damage:"", rof:1, shots:1, range:500, reliability:"VR", space:7, cost:150000, source:SOURCE,
      shellVariants:[{ name:"90mm Hi-Ex", pen:5, burst:6, hiEx:true }, { name:"90mm HEAT", pen:10, burst:2, heat:true, ap:true }] } },
  { name: "120mm Cannon", img: ICON, system: { weaponClass:"directFire", mountType:"turret", arc:"turret",
      wa:0, penetration:13, damage:"", rof:1, shots:1, range:1000, reliability:"VR", space:14, cost:500000, source:SOURCE,
      shellVariants:[{ name:"120mm Hi-Ex", pen:7, burst:6, hiEx:true }, { name:"120mm HEAT", pen:12, burst:2, heat:true, ap:true }] } },
  { name: "140mm Cannon", img: ICON, system: { weaponClass:"directFire", mountType:"turret", arc:"turret",
      wa:0, penetration:16, damage:"", rof:1, shots:1, range:1000, reliability:"ST", space:20, cost:1000000, source:SOURCE,
      shellVariants:[{ name:"140mm Hi-Ex", pen:7, burst:6, hiEx:true }, { name:"140mm HEAT", pen:18, burst:3, heat:true, ap:true }] } },
  // 105mm Recoilless — backblast 6D6 to the rear, totally-sealed armor only; external mount (p.17).
  { name: "105mm Recoilless", img: ICON, system: { weaponClass:"directFire", mountType:"open", arc:"front",
      wa:0, penetration:11, damage:"10D10AP", ap:true, heat:true, rof:1, shots:1, range:1000, reliability:"VR", space:5, cost:30000, source:SOURCE } },

  // ── Railguns / gauss cannon (p.18). Inherently armor-piercing. ──
  { name: "1cm Rail Cannon", img: ICON, system: { weaponClass:"directFire", mountType:"turret", arc:"turret",
      wa:2, penetration:10, damage:"10D10AP", ap:true, rof:2, shots:50, range:1500, reliability:"ST", space:5, cost:750000, source:SOURCE } },
  { name: "2cm Rail Gun", img: ICON, system: { weaponClass:"directFire", mountType:"turret", arc:"turret",
      wa:1, penetration:17, damage:"16D10AP", ap:true, rof:1, shots:50, range:2000, reliability:"ST", space:9, cost:1500000, source:SOURCE } },
  { name: "3cm Rail Gun", img: ICON, system: { weaponClass:"directFire", mountType:"turret", arc:"turret",
      wa:0, penetration:22, damage:"20D10AP", ap:true, rof:1, shots:50, range:3000, reliability:"UR", space:15, cost:3000000, source:SOURCE } },
  { name: "EMG-84 Railgun", img: ICON, system: { weaponClass:"directFire", mountType:"turret", arc:"turret",
      wa:1, penetration:7, damage:"5D10+10AP", ap:true, rof:10, shots:500, range:1000, reliability:"UR", space:2, cost:25000, source:SOURCE } },
  { name: "EMG-85 Railgun", img: ICON, system: { weaponClass:"directFire", mountType:"articulated", arc:"front",
      wa:3, penetration:7, damage:"5D10+10AP", ap:true, rof:1, shots:5, range:1500, reliability:"ST", space:1, cost:11370, source:SOURCE } },
  // E-Harpoon: effective Pen 20 IGNORING armor (composite/Body still apply); damage is temporary (backup circuits).
  { name: "E-Harpoon", img: ICON, system: { weaponClass:"special", mountType:"pod", arc:"front",
      wa:1, penetration:20, damage:"", ap:true, rof:1, shots:1, range:500, reliability:"ST", space:2, cost:20000, source:SOURCE } },

  // ── Unguided rockets (p.19). High-explosive: Penetration is range-immune (hefPenetrator), scatter on a miss. ──
  { name: "2\" Rocket", img: ICON, system: { weaponClass:"rocket", mountType:"pod", arc:"front",
      wa:-2, penetration:3, damage:"6D10", hiEx:true, burst:3, rof:1, shots:1, range:500, reliability:"VR", space:1, cost:100, source:SOURCE } },
  { name: "3.5\" Rocket", img: ICON, system: { weaponClass:"rocket", mountType:"pod", arc:"front",
      wa:-2, penetration:5, damage:"9D10", hiEx:true, burst:8, rof:1, shots:1, range:600, reliability:"VR", space:1, cost:400, source:SOURCE } },
  { name: "5\" Rocket", img: ICON, system: { weaponClass:"rocket", mountType:"pod", arc:"front",
      wa:-2, penetration:7, damage:"13D10", hiEx:true, burst:15, rof:1, shots:1, range:2000, reliability:"VR", space:1, cost:1000, source:SOURCE } },
  // One-shot HEAT launchers (p.19). Pen = the book's value, matching the AP-dice factor (LAW 4D10AP→4, etc.).
  { name: "LAW", img: ICON, system: { weaponClass:"rocket", mountType:"pod", arc:"front",
      wa:-2, penetration:4, damage:"4D10AP", ap:true, heat:true, burst:2, rof:1, shots:1, range:200, reliability:"VR", space:1, cost:300, source:SOURCE } },
  { name: "HLAW", img: ICON, system: { weaponClass:"rocket", mountType:"pod", arc:"front",
      wa:-2, penetration:12, damage:"11D10AP", ap:true, heat:true, burst:4, rof:1, shots:1, range:200, reliability:"VR", space:1, cost:800, source:SOURCE } },
  { name: "Militech RPG-A", img: ICON, system: { weaponClass:"rocket", mountType:"pod", arc:"front",
      wa:-2, penetration:6, damage:"6D10AP", ap:true, heat:true, burst:4, rof:1, shots:1, range:750, reliability:"VR", space:1, cost:1500, source:SOURCE,
      shellVariants:[{ name:"RPG-A H-E", pen:3, burst:6, hiEx:true }] } },
  { name: "Militech RPG-B", img: ICON, system: { weaponClass:"rocket", mountType:"pod", arc:"front",
      wa:-2, penetration:10, damage:"9D10AP", ap:true, heat:true, burst:4, rof:1, shots:1, range:500, reliability:"VR", space:1, cost:1500, source:SOURCE } },

  // ── Guided missiles (p.19; stats taken from the clean Appendix B vehicle chart, p.101). HEAT warheads;
  //    guidance/homing set the to-hit method (missiles fly via the flight tracker). Heavy ATGM ≈ TOW/Songbird
  //    (wire-guided, semi-active). SAM (Scorpion) is operator-fired (HVY skill); VSAM/AAM/AAMRAM are self-guiding
  //    Active missiles (Skill +15/+20 — the firer's WA/skill don't apply); all ignore aerial-target movement and
  //    are +10/+20 vs ground. The (Pen) is the book's PRE-DERIVED Vehicle Penetration, NOT the d10 count. ──
  { name: "Heavy ATGM", img: ICON, system: { weaponClass:"missile", mountType:"pod", arc:"front", guidance:"semiActive", homingMethod:"wire",
      wa:2, penetration:18, damage:"18D10AP", ap:true, heat:true, burst:4, rof:1, shots:1, range:3000, minRange:300, reliability:"VR", space:5, cost:10000, source:SOURCE } },
  { name: "SAM (Scorpion)", img: ICON, system: { weaponClass:"missile", mountType:"pod", arc:"front", guidance:"semiActive", homingMethod:"radar",
      wa:-1, penetration:4, damage:"7D10", heat:true, burst:6, rof:1, shots:1, range:1000, minRange:100, reliability:"VR", space:1, cost:1000, source:SOURCE } },
  { name: "VSAM", img: ICON, system: { weaponClass:"missile", mountType:"pod", arc:"front", guidance:"active", homingMethod:"radar", guidanceSkill:15,
      wa:0, penetration:8, damage:"15D10", heat:true, burst:10, rof:1, shots:1, range:5000, minRange:500, reliability:"VR", space:1, cost:10000, source:SOURCE } },
  { name: "AAM (short-ranged)", img: ICON, system: { weaponClass:"missile", mountType:"pod", arc:"front", guidance:"active", homingMethod:"infrared", guidanceSkill:15,
      wa:0, penetration:8, damage:"15D10", heat:true, burst:12, rof:1, shots:1, range:15000, minRange:1500, reliability:"VR", space:1, cost:15000, source:SOURCE } },
  { name: "AAMRAM", img: ICON, system: { weaponClass:"missile", mountType:"pod", arc:"front", guidance:"active", homingMethod:"radar", guidanceSkill:20,
      wa:0, penetration:9, damage:"17D10", heat:true, burst:12, rof:1, shots:1, range:80000, minRange:8000, reliability:"VR", space:3, cost:250000, source:SOURCE } },

  // ── Artillery / indirect (p.20). Mortars 400 m/turn, howitzers/rockets 600 m/turn; spotter-corrected To-Hit.
  //    Mortars have a minimum range of 1/100 their max. Shell variants cover the artillery ammunition (p.21). ──
  { name: "60mm Mortar", img: ICON, system: { weaponClass:"artillery", mountType:"fixed", arc:"front",
      wa:0, penetration:4, hiEx:true, burst:5, rof:2, shots:1, range:2000, minRange:20, reliability:"VR", space:1, cost:750, source:SOURCE,
      shellVariants:[{ name:"60mm WP", pen:0, burst:15, warhead:"wp" }, { name:"60mm Chemical", pen:0, burst:15, warhead:"chemical" }] } },
  { name: "80mm Mortar", img: ICON, system: { weaponClass:"artillery", mountType:"fixed", arc:"front",
      wa:0, penetration:5, hiEx:true, burst:6, rof:1, shots:1, range:3500, minRange:35, reliability:"VR", space:1, cost:1500, source:SOURCE,
      shellVariants:[{ name:"80mm WP", pen:0, burst:18, warhead:"wp" }, { name:"80mm Cluster", pen:4, burst:18, warhead:"cluster" }] } },
  { name: "120mm Mortar", img: ICON, system: { weaponClass:"artillery", mountType:"fixed", arc:"front",
      wa:0, penetration:7, hiEx:true, burst:6, rof:1, shots:1, range:6000, minRange:60, reliability:"VR", space:3, cost:5000, source:SOURCE,
      shellVariants:[{ name:"120mm Cluster", pen:4, burst:18, warhead:"cluster" }, { name:"120mm Chemical", pen:0, burst:18, warhead:"chemical" }] } },
  // Howitzer AP doubles Pen / triples on 150-200mm and drops the burst to 0 (howitzers only).
  { name: "150mm Howitzer", img: ICON, system: { weaponClass:"artillery", mountType:"fixed", arc:"front",
      wa:1, penetration:7, hiEx:true, burst:6, rof:1, shots:1, range:24000, reliability:"VR", space:20, cost:150000, source:SOURCE,
      shellVariants:[{ name:"150mm AP", pen:21, burst:0, ap:true }, { name:"150mm WP", pen:0, burst:18, warhead:"wp" }, { name:"150mm Cluster", pen:4, burst:18, warhead:"cluster" }] } },
  { name: "200mm Howitzer", img: ICON, system: { weaponClass:"artillery", mountType:"fixed", arc:"front",
      wa:0, penetration:15, hiEx:true, burst:8, rof:1, shots:1, range:20000, reliability:"VR", space:30, cost:250000, source:SOURCE,
      shellVariants:[{ name:"200mm AP", pen:45, burst:0, ap:true }, { name:"200mm Chemical", pen:0, burst:24, warhead:"chemical" }] } },
  // 230mm Rocket — a 12-rocket pod with multiple-bomblet (cluster) warheads; covers a huge area.
  { name: "230mm Rocket", img: ICON, system: { weaponClass:"artillery", mountType:"pod", arc:"front",
      wa:0, penetration:4, heat:true, burst:45, rof:3, shots:12, range:28000, reliability:"VR", space:30, cost:175000, source:SOURCE } },

  // ── Bombs (p.22). Direct hit ×5 Pen (range-immune); a miss deviates with altitude. Options p.22. ──
  { name: "100-lb Bomb", img: ICON, system: { weaponClass:"bomb", mountType:"pod", arc:"front",
      wa:-3, penetration:5, hiEx:true, burst:10, rof:1, shots:1, range:0, reliability:"VR", space:1, cost:250, source:SOURCE,
      shellVariants:[{ name:"100-lb Anti-Tank", pen:5, burst:4, warhead:"heat", heat:true, ap:true }, { name:"100-lb Incendiary", pen:0, burst:10, warhead:"wp" }] } },
  { name: "500-lb Bomb", img: ICON, system: { weaponClass:"bomb", mountType:"pod", arc:"front",
      wa:-3, penetration:8, hiEx:true, burst:48, rof:1, shots:1, range:0, reliability:"VR", space:3, cost:1000, source:SOURCE,
      shellVariants:[{ name:"500-lb Cluster", pen:4, burst:48, warhead:"cluster" }, { name:"500-lb Anti-Tank", pen:8, burst:4, warhead:"heat", heat:true, ap:true }, { name:"500-lb Incendiary", pen:0, burst:48, warhead:"wp" }] } },
  { name: "1000-lb Bomb", img: ICON, system: { weaponClass:"bomb", mountType:"pod", arc:"front",
      wa:-3, penetration:10, hiEx:true, burst:72, rof:1, shots:1, range:0, reliability:"VR", space:5, cost:2000, source:SOURCE,
      shellVariants:[{ name:"1000-lb Cluster", pen:4, burst:72, warhead:"cluster" }, { name:"1000-lb FAE", pen:10, burst:144, hiEx:true }] } },
  { name: "2000-lb Bomb", img: ICON, system: { weaponClass:"bomb", mountType:"pod", arc:"front",
      wa:-3, penetration:11, hiEx:true, burst:96, rof:1, shots:1, range:0, reliability:"VR", space:6, cost:3000, source:SOURCE } },

  // ── Lasers (p.22). The only viable battlefield laser is the painting laser — no damage; it guides paint missiles. ──
  { name: "Painting Laser", img: ICON, system: { weight: 3, magWeight: 0, notes: "Pre-existing. Target designator for laser-guided weapons; no damage, but 90% chance to permanently blind unshielded biological eyes; blocked by smoke/anti-laser aerosol.", weaponClass:"special", mountType:"turret", arc:"turret",
      wa:3, penetration:0, damage:"", rof:1, shots:1, range:1000, reliability:"VR", space:1, cost:1000, source:SOURCE } },

  // ───── Additional ACPA weapons (MM p.75-77, anchor-validated vs the ones we have). DAMAGE dice OCR-cleaned — verify; (Pen) book-given. ─────
  // ACPA cannon/rifle (p.75)
  { name: "BHC-G8 30mm Rifle", img: ICON, system: { weight: 70, magWeight: 9, notes: "Huge 30mm A-10-style ACPA rifle; drops a heavy trooper in one hit, but very heavy.", weaponClass:"directFire", mountType:"articulated", arc:"front",
      wa:0, penetration:5, damage:"9D10", rof:1, shots:10, range:600, reliability:"VR", space:2, cost:3500, sp:30, sdp:40, area:"torso", source:SOURCE } },
  // Rockets / missiles (p.76)
  { name: "IFAR 3-Pod", img: ICON, system: { weight: 40, magWeight: 0, notes: "3-tube 2.75in folding-fin rocket pod (ACPA-specific); salvo any number per turn; 6m burst; 2-handed/torso.", weaponClass:"rocket", mountType:"pod", arc:"front",
      wa:-2, penetration:4, damage:"8D10", hiEx:true, burst:6, rof:1, shots:3, range:500, reliability:"VR", space:3, cost:2100, sp:20, sdp:45, area:"torso", source:SOURCE } },
  { name: "Mini-Roc 6", img: ICON, system: { weight: 69, magWeight: 0, notes: "6-shot 50mm light rocket pod; anti-personnel/light targets; 3m burst; leg-mountable.", weaponClass:"rocket", mountType:"pod", arc:"front",
      wa:-2, penetration:3, damage:"6D10", hiEx:true, burst:3, rof:1, shots:6, range:500, reliability:"VR", space:2, cost:1800, sp:20, sdp:45, area:"torso", source:SOURCE } },
  { name: "Mini-Roc 15C", img: ICON, system: { weight: 171, magWeight: 0, notes: "15-shot 50mm rocket pod; heavy bombardment; 3m burst; 2-handed/torso.", weaponClass:"rocket", mountType:"pod", arc:"front",
      wa:-2, penetration:3, damage:"6D10", hiEx:true, burst:3, rof:1, shots:15, range:500, reliability:"VR", space:3, cost:4500, sp:20, sdp:112, area:"torso", source:SOURCE } },
  { name: "Red Knight SAM", img: ICON, system: { weight: 23, magWeight: 0, notes: "4th-gen IR-guided SAM/AAM; overkill vs PA; 10m burst; 2-handed only.", weaponClass:"missile", mountType:"pod", arc:"front", guidance:"active", homingMethod:"radar", guidanceSkill:15,
      wa:0, penetration:5, damage:"10D10", burst:10, rof:1, shots:1, range:4500, minRange:450, reliability:"VR", space:1, cost:4600, sp:20, sdp:15, area:"torso", source:SOURCE } },
  // Anti-personnel guns (p.77)
  { name: "G-20 Caseless 10mm MG", img: ICON, system: { weight: 15, magWeight: 3, notes: "H&K caseless MG; beats all personal armor + some light ACPA; saboted-AP option (Veh Pen 3).", weaponClass:"directFire", mountType:"articulated", arc:"front",
      wa:0, penetration:2, damage:"8D6", rof:20, shots:200, range:800, reliability:"VR", space:2, cost:3000, sp:25, sdp:25, area:"torso", source:SOURCE } },
  { name: "HIVE 10mm Caseless Gatling", img: ICON, system: { weight: 50, magWeight: 25, notes: "Tri-barrel chain-driven 10mm gatling; shreds borgs, light ACPA, vehicles, infantry. Ammo cannister = 2 spaces if hand-carried.", weaponClass:"directFire", mountType:"articulated", arc:"front",
      wa:0, penetration:4, damage:"5D10AP", ap:true, rof:120, rofAlt:60, shots:2400, range:500, reliability:"VR", space:4, cost:12500, sp:20, sdp:20, area:"torso", source:SOURCE } },
  { name: "ONI Autoshotgun", img: ICON, system: { weight: 7, magWeight: 12, notes: "Arasaka 10-gauge auto-scattergun with deep ammo; can collapse building interiors.", weaponClass:"directFire", mountType:"articulated", arc:"front",
      wa:0, penetration:2, damage:"4D6+3", rof:20, rofAlt:5, shots:180, range:75, reliability:"VR", space:2, cost:1350, sp:25, sdp:20, area:"torso", source:SOURCE } },

  // ───── ACPA grenade launchers / small arms (MM p.78) + utility-obstacle packs (p.74). Dice OCR-cleaned (verify); (Pen) book-given. ─────
  { name: "30mm Auto-Grenade Launcher", img: ICON, system: { weight: 20, magWeight: 11, notes: "Russian 30-round auto-GL; ROF slow enough to single-fire; same grenade effects as the 40mm.", weaponClass:"directFire", mountType:"articulated", arc:"front",
      wa:0, penetration:0, damage:"", rof:1, rofAlt:10, shots:30, range:1300, reliability:"VR", space:2, cost:2000, sp:25, sdp:25, area:"torso", source:SOURCE } },  // SPECIAL: grenade types set damage
  { name: "Super Rakate", img: ICON, system: { weight: 5, magWeight: 0, notes: "PA-scale Rostovic Wrist Rakate; light, low-restriction support firepower (Chromebook 1).", weaponClass:"directFire", mountType:"articulated", arc:"front",
      wa:0, penetration:1, damage:"5D6", rof:1, shots:8, range:300, reliability:"VR", space:1, cost:700, sp:20, sdp:20, area:"torso", source:SOURCE } },
  { name: "Saucer Shooter", img: ICON, system: { weight: 15, magWeight: 0, notes: "Fires FENdz-22 Saucer Grenades; trick ricochet/declivity shots possible (Chromebook 1).", weaponClass:"directFire", mountType:"articulated", arc:"front",
      wa:-1, penetration:0, damage:"2D6+3", rof:1, shots:30, range:250, reliability:"VR", space:1, cost:1500, sp:20, sdp:20, area:"torso", source:SOURCE } },
  { name: "EMP Grenadier", img: ICON, system: { weight: 10, magWeight: 0, notes: "Launches EMP grenades — disrupts electronics on both sides; rare (Chromebook 1).", weaponClass:"directFire", mountType:"articulated", arc:"front",
      wa:0, penetration:0, damage:"", rof:1, shots:5, range:300, reliability:"VR", space:1, cost:2000, sp:20, sdp:15, area:"torso", source:SOURCE } },  // SPECIAL: EMP grenades
  { name: "M-31PA", img: ICON, system: { weight: 6, magWeight: 2, notes: "Stripped M-31a1 AICW with extra ammo; PA sidearm rifle (Chromebook 1).", weaponClass:"directFire", mountType:"articulated", arc:"front",
      wa:2, penetration:1, damage:"4D6", rof:1, rofAlt:30, shots:300, range:400, reliability:"VR", space:1, cost:1800, sp:20, sdp:10, area:"torso", source:SOURCE } },
  { name: "Auto-Flechette Pistol", img: ICON, system: { weight: 3, magWeight: 2, notes: "PA Malorian sub-flechette gun, triple ammo; shreds soft targets (Chromebook 1).", weaponClass:"directFire", mountType:"articulated", arc:"front",
      wa:2, penetration:1, damage:"1D6x1D6AP", ap:true, rof:3, rofAlt:30, shots:100, range:200, reliability:"VR", space:0.5, cost:900, sp:20, sdp:15, area:"torso", source:SOURCE } },
  { name: "14mm Pistol", img: ICON, system: { weight: 2, magWeight: 1, notes: "PA Malorian 3516 copy, triple ammo; hard-hitting backup pistol (Chromebook 1).", weaponClass:"directFire", mountType:"articulated", arc:"front",
      wa:0, penetration:1, damage:"6D6", rof:2, shots:20, range:75, reliability:"VR", space:0.5, cost:2260, sp:20, sdp:15, area:"torso", source:SOURCE } },
  { name: "\"Dragon\" Flamer", img: ICON, system: { weight: 5, magWeight: 0, notes: "Enlarged Kendachi Dragon flamethrower; more fuel + range (Chromebook 1).", weaponClass:"directFire", mountType:"articulated", arc:"front",
      wa:0, penetration:1, damage:"3D6", rof:1, shots:8, range:8, reliability:"VR", space:1, cost:990, sp:20, sdp:10, area:"torso", source:SOURCE } },  // flamethrower: 3d6 then 1d6 burn
  { name: "Micro-Missiles", img: ICON, system: { weight: 5, magWeight: 3, notes: "Magazine-fed micro-missiles; 2m blast, track around obstacles; reload 400eb (CP2020 / Chromebook 2).", weaponClass:"directFire", mountType:"articulated", arc:"front",
      wa:2, penetration:1, damage:"4D6", rof:2, shots:8, range:200, reliability:"VR", space:1, cost:900, sp:20, sdp:10, area:"torso", source:SOURCE } },
  { name: "\"Big Boomer\"", img: ICON, system: { weight: 12, magWeight: 1, notes: "Up-scaled .477 Boomer Buster with double the shots (Solo of Fortune).", weaponClass:"directFire", mountType:"articulated", arc:"front",
      wa:1, penetration:2, damage:"5D6AP", ap:true, rof:2, shots:8, range:100, reliability:"VR", space:0.5, cost:550, sp:20, sdp:20, area:"torso", source:SOURCE } },
  // Utility / obstacle packs (p.74) — no direct damage; deploy a terrain obstacle.
  { name: "BLP C6 Breech Spray", img: ICON, system: { weight: 1, magWeight: 0, notes: "TRAP/breach: sprays 3kg liquid C6 on a wall/door (6 rounds) + 2 timed detonators; blast opens a breach.", weaponClass:"special", mountType:"open", arc:"front",
      wa:-1, penetration:0, damage:"", rof:1, shots:1, range:2, reliability:"VR", space:0.5, cost:300, sp:20, sdp:10, area:"torso", source:SOURCE } },  // VARIES: 3kg liquid C6 breaching charge
  { name: "BOM Wire Obstacle", img: ICON, system: { weight: 2, magWeight: 0, notes: "TRAP: springs a piano-wire 'spider web' filling a 4×4×4m corridor; soft targets caught in the blast strung up (min 1D6×1D6); slow to clear.", weaponClass:"special", mountType:"open", arc:"front",
      wa:-1, penetration:0, damage:"", rof:1, shots:1, range:5, reliability:"VR", space:0.5, cost:100, sp:20, sdp:10, area:"torso", source:SOURCE } },  // razor-wire obstacle
  { name: "BPL Plastic Obstacle", img: ICON, system: { weight: 2, magWeight: 0, notes: "TRAP: scatters ~240 plastic loops over a 5m radius; non-PA crawl ≤0.5m/round, PA pass freely.", weaponClass:"special", mountType:"open", arc:"front",
      wa:0, penetration:0, damage:"", rof:1, shots:1, range:10, reliability:"VR", space:0.5, cost:10, sp:20, sdp:10, area:"torso", source:SOURCE } },  // plastic loops; slows to 0.5m/round
  { name: "BSS Silicon Spray", img: ICON, system: { weight: 2, magWeight: 0, notes: "TRAP/utility: sprays up to 3kg sticky glue; cures (24h) to a rubbery seal; repairs, hole-fills, or sticky obstacle.", weaponClass:"special", mountType:"open", arc:"front",
      wa:-1, penetration:0, damage:"", rof:1, shots:1, range:5, reliability:"VR", space:0.5, cost:30, sp:20, sdp:10, area:"torso", source:SOURCE } },  // slick silicon
  { name: "BES Epoxy Spray", img: ICON, system: { weight: 2, magWeight: 0, notes: "TRAP/utility: two-part epoxy; cures brittle-hard in 5 min; strongest bond while it lasts.", weaponClass:"special", mountType:"open", arc:"front",
      wa:-1, penetration:0, damage:"", rof:1, shots:1, range:2, reliability:"VR", space:0.5, cost:30, sp:20, sdp:10, area:"torso", source:SOURCE } }  // 24-hr curing epoxy
];

const PACK_ID = "cp2020-augmented.vehicle-weapons";

/**
 * Populate the Vehicle Weapons (MM) compendium from the seed catalog. Idempotent — creates only
 * entries whose name isn't already present (unless force). GM-only (configure/unlock requires it).
 * @returns {Promise<{ok:boolean, created?:number, reason?:string}>}
 */
export async function seedVehicleWeaponCompendium({ force = false } = {}) {
  const pack = game.packs?.get(PACK_ID);
  if (!pack) return { ok: false, reason: "pack-missing" };
  if (!game.user?.isGM) return { ok: false, reason: "not-gm" };

  const wasLocked = !!pack.locked;
  try {
    if (wasLocked) await pack.configure({ locked: false });
    const index = await pack.getIndex();
    // Map name → existing doc id. `force` UPDATES existing entries in place (refresh stats); without
    // force we only back-fill missing names. (Earlier this filtered all names through createDocuments
    // on force, which DUPLICATED the whole catalog instead of refreshing it.)
    const idByName = new Map(index.map(e => [e.name, e._id]));
    const toCreate = [], toUpdate = [];
    for (const w of SEED_VEHICLE_WEAPONS) {
      const id = idByName.get(w.name);
      if (id == null) toCreate.push({ name: w.name, type: "cp2020-augmented.vehicleWeapon", img: w.img, system: w.system });
      else if (force) toUpdate.push({ _id: id, img: w.img, system: w.system });
    }
    if (toCreate.length) await Item.createDocuments(toCreate, { pack: pack.collection });
    if (toUpdate.length) await Item.updateDocuments(toUpdate, { pack: pack.collection });
    return { ok: true, created: toCreate.length, updated: toUpdate.length };
  } catch (err) {
    console.warn("Cyberpunk2020 | vehicle-weapon compendium seed failed", err);
    return { ok: false, reason: "error" };
  } finally {
    if (wasLocked) await pack.configure({ locked: true }).catch(() => {});
  }
}

/** Ready-time one-shot: seed the compendium if it exists and is empty. Active GM only. */
export async function ensureVehicleWeaponSeed() {
  if (!mmEnabled()) return;                                   // Maximum Metal off → don't seed the MM compendium
  if (!game.user?.isGM || game.users?.activeGM?.id !== game.user.id) return;
  const pack = game.packs?.get(PACK_ID);
  if (!pack) return;
  try {
    // Idempotent by name: seeds the catalog and back-fills any newly added entries (e.g. when the
    // catalog gains a weapon like the 250-lb Bomb) without duplicating ones already present. Use
    // game.cyberpunk.vehicles.seedWeapons({ force: true }) to also refresh existing entries' stats.
    await seedVehicleWeaponCompendium();
  } catch (err) {
    console.warn("Cyberpunk2020 | ensureVehicleWeaponSeed failed", err);
  }
}
