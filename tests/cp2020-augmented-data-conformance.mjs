/**
 * STANDING DATA-CONFORMANCE LINT (:30004, official cyberpunk2020 1.1.1 + cp2020-augmented).
 *
 * WHAT IT CHECKS. Every Item compendium in packages `cyberpunk2020` and `cp2020-augmented` is
 * walked and each document is validated in its POST-CORRECTION view — the pack's raw system data
 * with `applyPackRulesToItemSystem` and then the per-item `correctionFor(...).patch` merged over it,
 * in that order. That is the order `registerDataCorrections`' preCreateItem hook applies them, so
 * the view this lint validates is the data a user's copy actually receives, not what sits in the
 * pack file. Two legs prove that equivalence against a REAL `Item.create` rather than asserting it.
 *
 * The checks are named after the mechanism each one protects:
 *   - placeholder strings   a literal "undefined"/"null"/"NaN" left in a string field
 *   - enum select round-trip  availability / concealability / reliability must be legal-or-blank,
 *                           because `templates/fields/select.hbs` renders no blank option and marks
 *                           `selected` only on an exact match — an out-of-enum stored value displays
 *                           the FIRST option and the next sheet submit silently writes it back
 *   - jam-threshold lookup  every stored reliability must be a spelling `reliabilityThreshold()`
 *                           recognises, or it silently falls through to 5
 *   - caliber registry      every non-blank ammoType must resolve through `normalizeCaliber` into
 *                           `getCalibers()`, or the reload match fails and a box prices at 0eb/1 round
 *   - damage formula        every non-blank damage string must satisfy `Roll.validate`
 *   - attack-skill legality every weaponType's attackSkill must be in that type's allowed list
 *
 * THE ALLOWLIST is the load-bearing design piece. Data rot that is KNOWN-OPEN and awaiting a
 * decision is enumerated below as EXACT values with the reason it is open and what would close it.
 * Everything not in the allowlist fails. So this lint is green on today's data and goes red on NEW
 * rot, or when a fix that has already landed is reverted. It never fails on rot merely because that
 * rot is large — and it can never swallow rot silently, because the allowlist holds only exact
 * strings (a structural leg asserts that: no wildcards, no regex, no empty entries).
 *
 * WHEN AN ALLOWLIST ENTRY IS FIXED, DELETE IT. The lint prints stale entries (allowlisted values no
 * longer present in the data) as INFO so the block can be pruned; stale entries do not fail, because
 * fixing data must never turn the lint red.
 *
 * Read-only apart from two sample items created and deleted by the corrections-fidelity legs.
 *
 * Run from the fork's tests/:
 *   FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-data-conformance.mjs
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * ALLOWLIST — today's KNOWN-OPEN values. Snapshotted live on 2026-08-06 from :30004 after the
 * ratified caliber-alias tier landed. Every count below was measured, not estimated.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

/* ── Caliber strings with no registry entry: 91 strings / 221 items ────────────────────────────
 * Sources: import-staging/CALIBER-REGISTRY-PROPOSAL.md (§7b ADD, §7c QUESTION, §7d REJECT) and
 * PACK-DATA-ROT-SWEEP.md's judged-legitimate exclusions. The §7a ALIAS tier is NOT here — it is
 * wired in module/lookups.js CALIBER_ALIASES and a leg below asserts all 61 spellings resolve. */
const OPEN_AMMO = {
  /* A bore the registry does not model — 50 strings / 134 items. CLOSES WHEN: the user rules on
   * the proposal's §7b (18 entries land in an existing cost class; 10 need a price or a new one). */
  noRegistryEntry: [
    ".40 S&W", ".454", "7 mm", "6.5 mm C", "5.45S", "7 mm C", "8 mm", "6.5 mm", ".50 AE", "14mm", "4.5 mm C",
    "5.7 mm", "4.7 mm", "5.8 mm", "12.7mm", "3.5FF", ".300WM", ".477", "micromissile", "7mm caseless", "7mm",
    "6.5 ET", "6.5mm Hybrid", "6.5mm", ".454 C", ".454 ET", "5.45SV", ".50S", "4.5 mm LP", ".41AE", ".41",
    ".41 ET", ".300M", "15mm Kurz", "15mm BMG", "15mm", "30mm", "30mm EHI", "30mm caseless", ".666",
    ".666 Magnum", "18mm G", "18mm HEAT", ".338", "5.2 mm", "7.5LP", "8.5mm Ramjet", "13mm", "14.5mm",
    "25mm Cockerill",
  ],
  /* Undecodable after a 78-PDF book sweep — 12 strings / 17 items. CLOSES WHEN: the user's eyes
   * settle the suffix or the bore (proposal §7c). */
  undecoded: [
    "7.62 TT", "12.5 mm", "5.5D", "Flec", "7.65M", ".460WM", ".30", "13mm mixed", "5.3mm", "4mm",
    ".177 caseless explosive", "7.7mm",
  ],
  /* Not a cartridge at all — 22 strings / 61 items. Launched ordnance, missiles, melee/thrown, dart
   * and capsule projectors, prose written into a data field, and three misparsed Reference Book
   * columns ("B6" = Body Minimum 6, "200m" = a range, "4m3" = a burst volume). CLOSES WHEN: never
   * by aliasing — these are correct as descriptive text (proposal §7d). */
  notACartridge: [
    "NA", "Grenade", "40mm grenade", "25mm mini-grenade", "Missile", "Squirt", "1", "25mm grenade",
    "25mm grenades", "Hard SP/2", "5.56 (also 10mm/12mm/.357mag)", "varies (.22LR to 12mm CL)", ".22/5mm",
    "B6", "200m", "sleep darts", "4m3", "ATGM missile", "rifle grenade", "beanbag", "polymer capsule",
    "wire darts",
  ],
  /* The weapon carries no cartridge by design — 3 strings / 5 items: energy weapons that recharge
   * (Laser / Microwave, "Special"), battery melee, and a thrown weapon. CLOSES WHEN: never. */
  noCartridgeByDesign: ["Special", "battery", "Throw"],
  /* A shotgun gauge label outside the ratified alias set — 4 strings / 4 items. These four spellings
   * ("CAL12 E", "CAL12 MAG" = a load on the gauge, "CAL477", "23 mm") were not in the proposal's
   * §7a alias table, so they were deliberately not wired. CLOSES WHEN: the user extends the alias
   * tier to cover them (each is a 12ga/other gauge under a load or scrape spelling). */
  gaugeOutsideAliasTier: ["CAL12 E", "CAL477", "23 mm", "CAL12 MAG"],
};

/* ── Damage strings Roll.validate rejects ──────────────────────────────────────────────────────── */
const OPEN_DAMAGE = {
  /* The books' own damage entries for weapons whose effect is not a die roll — 47 strings / 68
   * items (PACK-DATA-ROT-SWEEP.md class E2). These are faithful transcriptions, not typos.
   * CLOSES WHEN: a data model for non-dice damage is decided (a `damageNote` field or an effect
   * tag). Editing the 68 strings is not the fix. */
  descriptive: [
    "1-2 + drugs (sleep)", "10D10 special", "10d10 special", "1D10 (HE)", "1D6+3 (3m)", "1d6 + special",
    "1d6+1*", "2D6+3 (15m)", "2D6/4D6 (mono)", "2d6+3 + Mace", "2d6+3 + Stun (-2)", "2d6+3*",
    "3d6 + special", "3d6*", "4D6 (00)", "4D6 (micromissile)", "4d6+3 (.454)", "5D10AP HEAT + 3D6 frag (5m)",
    "Blind", "Chemical", "Chemical (odor)", "Deaf", "Drugs", "EMP (electronics)", "EMP Effect", "Entangle",
    "Gas", "Net", "Special", "Special (1D6 splatballs)", "Special (4m)", "Special (5m)",
    "Special (restraint)", "Stun", "Stun (.45 LVD)", "Stun (beanbag)", "Stun -3", "Tangle (15mm)", "Varies",
    "Varies (12mm)", "Varies (13mm)", "Varies (25mm)", "Varies (25mm/10ga)", "Varies (30mm)",
    "Varies (40mm)", "Varies (rifle grenade)", "d6/2+2x1d6/3",
  ],
  /* ⚠ UNFIXED ROT, not a design decision — 3 strings / 3 items. A bare " AP" marker glued onto an
   * otherwise valid formula, with `system.ap` still false, so the marker is lost AND the roll is
   * broken. Ten items of this shape were fixed via data-corrections entries; these three sit in
   * MODULE-OWNED packs (supplement-heavy / supplement-exotics), which the corrections layer does not
   * serve — they are fixed at pack SOURCE. Two of them additionally need a ruling on whether "AP"
   * there means the boolean or a damage value ("5D10+10 AP" Cockerill, "Entangle, 40 AP").
   * CLOSES WHEN: the source packs are edited and re-seeded. */
  apSuffixLeftovers: ["5D10+10 AP", "5D6 AP", "Entangle, 40 AP (all locations)"],
  /* ⚠ NEW ROT found by this lint's module-doctype coverage, NOT in the original sweep (which did
   * not run class E over vehicleWeapon) — 1 string / 4 items, all in cp2020-augmented.vehicle-weapons:
   * EMG-83/84/85 and 4mm Railgun store "5D10+10AP". `system.ap` is ALREADY true on all four, so the
   * "AP" text is redundant as well as unrollable — the fix is to store "5D10+10".
   * CLOSES WHEN: the user approves the pack-source edit. Allowlisted only to keep the lint honest
   * about today's baseline; it is reported as a defect, not accepted as correct. */
  moduleDoctypeApSuffix: ["5D10+10AP"],
};

/* ── Enum values outside the legal set — 4 values / 45 field-instances ──────────────────────────
 * Each is legal-looking data that the sheet's select cannot round-trip. CLOSES WHEN: the value is
 * normalized (by a pack rule for base packs, at source for module packs). */
const OPEN_ENUM = {
  /* DataModel defaults leaking into the pack file rather than a real authored value. base:smgs-add
   * ×3, base:cyberweapons ×12, base:cyberlimbs ×6. */
  "availability|common": 21,
  /* `DEFAULT_WEAPON.concealability` leaking the same way. base:cyberweapons ×12, base:cyberlimbs ×6. */
  "concealability|P": 18,
  /* Capital-C typo in three MODULE-owned supplement packs — fixable at source. */
  "concealability|ConcealLongCoat": 3,
  /* base:smgs-add ×3. Cosmetic only: "standard" IS recognised by reliabilityThreshold (→5), so no
   * dice change; it is the sheet select that cannot round-trip it. The pack normalization RULE
   * covers pistols-add/rifles-add only, and smgs-add is deliberately outside it. */
  "reliability|standard": 3,
};

/* ── Literal placeholder strings — 1 path / 4 items ────────────────────────────────────────────
 * ⚠ NEW ROT found by this lint's world-scoped coverage, NOT in the original sweep (which walked
 * only the 1,053 weapon-shaped items). `system.source` holds the literal "undefined" on 4 armor
 * documents in the base pack `cyberpunk2020.armor-add` (Kevlar Vest, HeadGear Cybermodem Helmet,
 * both Net-Runner Cybermodem Utility Suits). `source` is provenance text with no mechanical
 * consumer, so nothing miscomputes — it displays the word "undefined" to the user.
 * CLOSES WHEN: a corrections entry or pack rule blanks it. Reported as a defect, not accepted. */
const OPEN_LITERALS = { "armor|source|undefined": 4 };

/* The 61 ratified alias spellings (CALIBER-REGISTRY-PROPOSAL.md §7a). A leg asserts every one still
 * resolves, so a revert of the alias block turns this lint red rather than silently un-pricing 432
 * weapons. Kept as the spelling list only — the target ids live in module/lookups.js. */
const RATIFIED_ALIAS_SPELLINGS = [
  "7.62N", "7.62C", "7.62E", "7.62x37 mm", "7.62mm EAE cased", "7.62mm ETU", "7.62mm caseless",
  "7.62x54R", "7.62 mm SP-3", "7.62 mm SP-4",
  "9 mm C", "9 mm M", "9 mm SP-5", "9 mm SP-6", "9mm CL", "9 mm CL", "9mm L", "9mm caseless",
  "5.56C", "5.56 C", "5.56mm caseless",
  ".357M", ".357P", ".357mag", ".357 C",
  ".44M", ".44 Mag", ".44 C", ".44 ET", ".44B", ".445",
  ".45 ACP", ".45 ACPC", ".45 LVD stundart",
  "10 mm C", "10mm Caseless", "10mm cased", "10mm ramjet", "10mm caseless flechette",
  "11 mm C", "12 mm C", "12mm R", "12mm Long Caseless",
  "5 mm C", "6 mm C", "6mm R", ".22LR", "20/9mm", "20mm EHI", "20mm EHI cased",
  "12ga", "10ga", "4ga", ".410ga", "CAL12", "CAL10", "CAL20", "CAL28", "CAL410",
  "quarrels", "fuel (4 shots)",
];

/* ════════════════════════════════════════════════════════════════════════════════════════════ */

async function joinAs(page, match, passwords) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 30_000 });
  const users = await sel.locator("option").evaluateAll((o) =>
    o.map((x) => ({ v: x.value, l: (x.textContent || "").trim() })).filter((x) => x.v));
  const u = users.find((x) => match.test(x.l));
  if (!u) throw new Error("no user matching " + match);
  for (const pw of passwords) {
    await sel.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([
      page.waitForNavigation({ url: /\/game/, timeout: 15_000 }).catch(() => {}),
      page.locator('button[name="join"]').click(),
    ]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 20_000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await sel.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join as " + u.l);
}

const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  // Foundry logs a console error below 1366x768 — a real desktop viewport keeps the 0-errors leg
  // reporting the module's errors rather than the harness window size.
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await joinAs(page, /^gamemaster$/i, [GM_PW]);

  const R = await page.evaluate(async (AL) => {
    const M = "/modules/cp2020-augmented/module";
    const out = { checks: [], info: {}, violations: {} };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const created = [];

    try {
      const L = await import(`${M}/lookups.js`);
      const C = await import(`${M}/data-corrections.js`);
      const SL = await import("/systems/cyberpunk2020/module/lookups.js");
      const SU = await import("/systems/cyberpunk2020/module/utils.js");

      const legal = {
        availability: Object.values(SL.availability ?? {}).map(String),
        concealability: Object.values(SL.concealability ?? {}).map(String),
        reliability: Object.values(SL.reliability ?? {}).map(String),
      };
      // The vocabulary reliabilityThreshold() itself recognises (utils.js) — anything else falls
      // through to the default 5 without saying so.
      const RECOGNISED_RELIABILITY = ["veryreliable", "very", "vr", "standard", "st", "unreliable", "ur"];
      const PLACEHOLDERS = ["undefined", "null", "nan", "[object object]"];

      const allowedAmmo = new Set(Object.values(AL.OPEN_AMMO).flat());
      const allowedDamage = new Set(Object.values(AL.OPEN_DAMAGE).flat());

      /* ── the post-correction view, built exactly as registerDataCorrections' hook builds it ──── */
      const postCorrectionSystem = (packId, doc) => {
        const sys = foundry.utils.deepClone(doc.system ?? {});
        C.applyPackRulesToItemSystem(packId, sys);          // rules first
        const corr = C.correctionFor(packId, doc._id);       // then the per-item entry, which wins
        if (corr) {
          if (corr.cost !== undefined) sys.cost = corr.cost;
          if (corr.flavor !== undefined) sys.flavor = corr.flavor;
          for (const [path, value] of Object.entries(corr.patch ?? {})) {
            const parts = path.split(".");
            let o = sys;
            for (const seg of parts.slice(0, -1)) o = (o[seg] ??= {});
            o[parts[parts.length - 1]] = value;
          }
        }
        return sys;
      };

      const walkStrings = (obj, path, depth, fn) => {
        if (depth > 6 || obj == null) return;
        if (typeof obj === "string") { fn(path, obj); return; }
        if (Array.isArray(obj)) { obj.forEach((v, i) => walkStrings(v, `${path}[${i}]`, depth + 1, fn)); return; }
        if (typeof obj === "object") for (const [k, v] of Object.entries(obj)) walkStrings(v, path ? `${path}.${k}` : k, depth + 1, fn);
      };

      const V = out.violations;
      const flag = (bucket, key, where) => ((V[bucket] ??= {})[key] ??= []).push(where);
      const seenAmmo = new Set(), seenDamage = new Set(), seenEnum = new Set(), seenLiteral = new Set();

      /* ── the closed enumeration ─────────────────────────────────────────────────────────────── */
      const packs = game.packs.filter(p => p.documentName === "Item" &&
        (p.metadata.packageName === "cyberpunk2020" || p.metadata.packageName === "cp2020-augmented"));
      let docCount = 0, packRead = 0, readFailures = [];
      const typeTally = {};

      for (const p of packs) {
        let docs;
        try { docs = await p.getDocuments(); packRead++; }
        catch (e) { readFailures.push(`${p.collection}: ${e?.message ?? e}`); continue; }
        for (const d of docs) {
          docCount++;
          typeTally[d.type] = (typeTally[d.type] ?? 0) + 1;
          const sys = postCorrectionSystem(p.collection, d);
          const where = `${p.collection}/${d._id} ${d.name}`;

          /* placeholder strings — EVERY document type, every string field */
          walkStrings(sys, "", 0, (path, v) => {
            const t = v.trim().toLowerCase();
            if (!PLACEHOLDERS.includes(t)) return;
            const key = `${d.type}|${path}|${t}`;
            seenLiteral.add(key);
            if (!(key in AL.OPEN_LITERALS)) flag("literal", key, where);
          });

          /* jam-threshold lookup — every type that stores a reliability */
          const rel = String(sys.reliability ?? "").trim();
          if (rel !== "" && !RECOGNISED_RELIABILITY.includes(rel.toLowerCase())) {
            flag("reliabilityUnrecognised", `${d.type}|${rel}`, where);
          }

          /* the weapon-shaped block: a weapon item, or a cyberware carrying a live weapon block */
          let wb = null;
          if (d.type === "weapon") wb = sys;
          else if (d.type === "cyberware" && SU.cwHasType?.(sys.CyberWorkType, "Weapon")) wb = sys.CyberWorkType?.Weapon ?? null;

          if (wb) {
            for (const f of ["availability", "concealability", "reliability"]) {
              const v = String(wb[f] ?? "");
              if (v === "" || legal[f].includes(v)) continue;      // legal-or-blank
              const key = `${f}|${v}`;
              seenEnum.add(key);
              if (!(key in AL.OPEN_ENUM)) flag("enum", key, where);
            }
            const raw = String(wb.ammoType ?? "");
            if (raw.trim() !== "") {
              const resolves = Object.prototype.hasOwnProperty.call(L.getCalibers(), L.normalizeCaliber(raw));
              if (!resolves) { seenAmmo.add(raw); if (!allowedAmmo.has(raw)) flag("ammo", raw, where); }
            }
            const dmg = String(wb.damage ?? "");
            if (dmg.trim() !== "" && !Roll.validate(dmg)) {
              seenDamage.add(dmg);
              if (!allowedDamage.has(dmg)) flag("damage", dmg, where);
            }
            const wt = String(wb.weaponType ?? ""), ask = String(wb.attackSkill ?? "");
            const allowedSkills = SL.attackSkills?.[wt];
            if (Array.isArray(allowedSkills) && allowedSkills.length && ask !== "") {
              const labelOf = (k) => { try { return game.i18n.localize("CYBERPUNK.Skill" + k); } catch { return k; } };
              if (!allowedSkills.some(k => k === ask || labelOf(k) === ask)) {
                flag("attackSkill", `${wt}|${ask}`, where);
              }
            }
          }

          /* module-owned document types: their schema differs, so the damage fields are found by
           * walking for any string path containing "damage" (vehicleWeapon carries `damage` plus a
           * `shellVariants[].damage`; acpaSystem carries no damage field at all). */
          if (d.type.startsWith("cp2020-augmented.")) {
            walkStrings(sys, "", 0, (path, v) => {
              if (!/damage/i.test(path)) return;
              const s = v.trim();
              if (s === "" || Roll.validate(s)) return;
              seenDamage.add(s);
              if (!allowedDamage.has(s)) flag("damage", `${d.type} ${path}: ${s}`, where);
            });
          }
        }
      }

      out.info = { packs: packs.length, packRead, docCount, typeTally, readFailures };

      /* ── legs ───────────────────────────────────────────────────────────────────────────────── */
      ok(`enumeration closes: every Item compendium in both packages was read (${packRead}/${packs.length} packs, ${docCount} documents)`,
        packs.length > 0 && packRead === packs.length && readFailures.length === 0,
        `read failures: ${JSON.stringify(readFailures)}`);

      /* corrections-view fidelity — prove the merge above equals what a real create produces */
      const mkFrom = async (packId, id) => {
        const doc = await game.packs.get(packId).getDocument(id);
        const it = await Item.create(game.items.fromCompendium(doc));
        created.push(it);
        return { doc, it };
      };
      const sameView = async (packId, id, label) => {
        const { doc, it } = await mkFrom(packId, id);
        const computed = postCorrectionSystem(packId, doc);
        const drift = Object.keys(computed).filter(k =>
          JSON.stringify(computed[k]) !== JSON.stringify(foundry.utils.deepClone(it.system)[k]));
        ok(`corrections-view fidelity (${label}): the computed post-correction view equals a real create`,
          drift.length === 0, `fields differing: ${JSON.stringify(drift)}`);
      };
      // rule-only item (placeholder availability + spaced reliability), and rule+entry (entry wins).
      await sameView("cyberpunk2020.pistols-add", "yXpTaNDwOdjkCC8d", "pack rule only");
      await sameView("cyberpunk2020.rifles-add", "i5fKapFKJhgx3ia2", "pack rule plus a per-item entry");

      const legFor = (bucket, label) => {
        const bad = V[bucket] ?? {};
        const values = Object.keys(bad);
        const items = Object.values(bad).reduce((a, w) => a + w.length, 0);
        ok(`${label}: 0 values outside the allowlist`, values.length === 0,
          values.length === 0 ? "" :
            `${values.length} value(s) / ${items} item(s): ` +
            values.map(v => `${JSON.stringify(v)} × ${bad[v].length} (e.g. ${bad[v][0]})`).join(" · "));
      };

      legFor("literal", "placeholder strings (all document types, all string fields)");
      legFor("enum", "enum select round-trip (availability / concealability / reliability)");
      legFor("reliabilityUnrecognised", "jam-threshold lookup recognises every stored reliability");
      legFor("ammo", "caliber registry resolves every non-blank ammoType");
      legFor("damage", "damage formula parses (weapon, cyberweapon, and module document types)");
      legFor("attackSkill", "attack-skill legality for the weapon type");

      /* the ratified alias tier still resolves — a revert of the alias block turns this red */
      const aliasUnresolved = AL.RATIFIED_ALIAS_SPELLINGS.filter(s =>
        !Object.prototype.hasOwnProperty.call(L.getCalibers(), L.normalizeCaliber(s)));
      ok(`ratified caliber-alias tier resolves: ${AL.RATIFIED_ALIAS_SPELLINGS.length}/${AL.RATIFIED_ALIAS_SPELLINGS.length} spellings reach a registry entry`,
        aliasUnresolved.length === 0, JSON.stringify(aliasUnresolved));

      /* structural guard: the allowlist can only ever match exact strings */
      const allAllow = [...Object.values(AL.OPEN_AMMO).flat(), ...Object.values(AL.OPEN_DAMAGE).flat(),
        ...Object.keys(AL.OPEN_ENUM), ...Object.keys(AL.OPEN_LITERALS)];
      const loose = allAllow.filter(v => typeof v !== "string" || v.trim() === "" || v === "*" || v.includes("\\"));
      ok(`allowlist is exact-match only: ${allAllow.length} entries, none blank or wildcard`,
        loose.length === 0, JSON.stringify(loose));

      /* INFO — allowlisted values no longer present in the data, i.e. entries safe to prune. */
      out.info.stale = {
        ammo: Object.values(AL.OPEN_AMMO).flat().filter(v => !seenAmmo.has(v)),
        damage: Object.values(AL.OPEN_DAMAGE).flat().filter(v => !seenDamage.has(v)),
        enum: Object.keys(AL.OPEN_ENUM).filter(v => !seenEnum.has(v)),
        literal: Object.keys(AL.OPEN_LITERALS).filter(v => !seenLiteral.has(v)),
      };
      out.info.openTotals = {
        ammoValues: seenAmmo.size, damageValues: seenDamage.size,
        enumValues: seenEnum.size, literalPaths: seenLiteral.size,
      };
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    } finally {
      for (const it of created) { try { await it.delete(); } catch {} }
      out.leftover = game.items.filter(i => created.some(c => c.id === i.id)).length;
    }
    return out;
  }, { OPEN_AMMO, OPEN_DAMAGE, OPEN_ENUM, OPEN_LITERALS, RATIFIED_ALIAS_SPELLINGS });

  for (const c of R.checks) {
    if (!c.pass) failures++;
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.got ? "" : `\n        [${c.got}]`}`);
  }
  if (R.error) { failures++; console.log("FAIL  in-page error\n" + R.error); }

  const cleanOk = R.leftover === 0;
  if (!cleanOk) failures++;
  console.log(`${cleanOk ? "PASS" : "FAIL"}  cleanup: no created world items left behind (${R.leftover})`);

  const errOk = errors.length === 0;
  if (!errOk) failures++;
  console.log(`${errOk ? "PASS" : "FAIL"}  0 console errors${errOk ? "" : "\n" + errors.join("\n")}`);

  const i = R.info ?? {};
  console.log(`\nINFO  scope: ${i.packRead}/${i.packs} Item compendia, ${i.docCount} documents — ${JSON.stringify(i.typeTally)}`);
  console.log(`INFO  known-open values in the data: ${JSON.stringify(i.openTotals)}`);
  const stale = i.stale ?? {};
  const staleN = Object.values(stale).reduce((a, v) => a + v.length, 0);
  console.log(`INFO  allowlist entries no longer present in the data (safe to prune): ${staleN}` +
    (staleN ? `\n      ${JSON.stringify(stale)}` : ""));

  console.log(`\n${R.checks.length + 2 - failures}/${R.checks.length + 2} checks passed`);
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
