/**
 * Data-corrections layer (:30004, official 1.1.1 + module) — the user's eyes-verified Chromebook 3
 * audit (import-staging/item-audit/USER-AUDIT-2026-07-05.md).
 *
 * The base system's cyberware-old pack can't be edited in place, so book corrections live in
 * module/data-corrections.js and are applied at (1) the shop's price/name reads and (2) preCreateItem
 * for copies created from a corrected compendium item (matched by _stats.compendiumSource, never name).
 * Variable-price items (priceRange) show the book range and let a GM override WIN over the compendium
 * cost (resolveCatalogPrice preferOverride).
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-data-corrections.mjs
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

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
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 15_000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await sel.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join as " + u.l);
}

const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await joinAs(page, /^gamemaster$/i, [GM_PW]);

  const R = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const PACK = "cyberpunk2020.cyberware-old";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const created = [];
    let overrideSet = false;
    try {
      const { correctionFor, correctedCost } = await import(`${M}/data-corrections.js`);
      const { resolveCatalogPrice } = await import(`${M}/shop/purchase.js`);
      const CAT = await import(`${M}/shop/catalog.js`);
      const SET = await import(`${M}/settings.js`);

      // ---- pure lookups ----
      ok("correctedCost: Enable Cyberarm 500→4000", correctedCost(PACK, "ksNQKhJLA69OyVZi", 500) === 4000, correctedCost(PACK, "ksNQKhJLA69OyVZi", 500));
      ok("correctedCost: Enable Cyberleg 700→6000", correctedCost(PACK, "58jU3dLX2vobSely", 700) === 6000, correctedCost(PACK, "58jU3dLX2vobSely", 700));
      ok("correctedCost: LiveWires 400→200 (implant price)", correctedCost(PACK, "s4D3tB3dwEsVs3AE", 400) === 200, correctedCost(PACK, "s4D3tB3dwEsVs3AE", 400));
      ok("correctedCost: uncorrected item passes through", correctedCost(PACK, "zzzzzzzzzzzzzzzz", 123) === 123, correctedCost(PACK, "zzzzzzzzzzzzzzzz", 123));
      const spec = correctionFor(PACK, "hqp1XekLTwvDxuIC");
      ok("Spectrum Outer Ear carries priceRange 200–1000", spec?.priceRange?.min === 200 && spec?.priceRange?.max === 1000, JSON.stringify(spec?.priceRange));

      // ---- resolveCatalogPrice preferOverride ----
      const ov = { X: 600 };
      ok("preferOverride: override beats positive compendium cost", resolveCatalogPrice(1000, "X", ov, { preferOverride: true }).price === 600, JSON.stringify(resolveCatalogPrice(1000, "X", ov, { preferOverride: true })));
      ok("default: positive compendium cost still beats override", resolveCatalogPrice(1000, "X", ov).price === 1000, JSON.stringify(resolveCatalogPrice(1000, "X", ov)));
      ok("preferOverride without an override falls through to compendium", resolveCatalogPrice(1000, "Y", ov, { preferOverride: true }).price === 1000, JSON.stringify(resolveCatalogPrice(1000, "Y", ov, { preferOverride: true })));

      // ---- catalog index (corrected cost/name + priceRange on rows) ----
      CAT.clearCatalogIndexCache();
      const idx = await CAT.getCatalogIndex();
      const row = (id) => idx.find(r => r.id === id && r.packId === PACK);
      ok("index: Enable Cyberarm priced 4000", row("ksNQKhJLA69OyVZi")?.cost === 4000, row("ksNQKhJLA69OyVZi")?.cost);
      ok("index: Enable Cyberleg priced 6000", row("58jU3dLX2vobSely")?.cost === 6000, row("58jU3dLX2vobSely")?.cost);
      ok("index: LiveWires priced 200", row("s4D3tB3dwEsVs3AE")?.cost === 200, row("s4D3tB3dwEsVs3AE")?.cost);
      ok("index: braindance renamed …Recorder", row("tsY2j88C5WxOTbDG")?.name === "Super Compact Braindance Recorder", row("tsY2j88C5WxOTbDG")?.name);
      ok("index: Spectrum row carries priceRange", row("hqp1XekLTwvDxuIC")?.priceRange?.max === 1000, JSON.stringify(row("hqp1XekLTwvDxuIC")?.priceRange));
      ok("index: uncorrected row untouched (Bonespike cost 1000)", row("lNqrIKwpKnbbkZKi")?.cost === 1000, row("lNqrIKwpKnbbkZKi")?.cost);

      // ---- GM override wins for the range item end-to-end (index rebuild) ----
      await SET.setShopPriceOverride("hqp1XekLTwvDxuIC", 600);
      overrideSet = true;
      CAT.clearCatalogIndexCache();
      const idx2 = await CAT.getCatalogIndex();
      const specRow = idx2.find(r => r.id === "hqp1XekLTwvDxuIC" && r.packId === PACK);
      ok("index after GM override 600: Spectrum priced 600 (override wins for range items)", specRow?.cost === 600, specRow?.cost);

      // ---- preCreateItem: imported copies carry the corrections ----
      const pack = game.packs.get(PACK);
      const mk = async (id) => {
        const doc = await pack.getDocument(id);
        const it = await Item.create(game.items.fromCompendium(doc));
        created.push(it);
        return it;
      };
      const spike = await mk("lNqrIKwpKnbbkZKi");
      ok("import Bonespike: notes carry surgery MA + breakage + concealment", /Surgery: MA/.test(spike.system.notes) && /Very Difficult Awareness/.test(spike.system.notes), String(spike.system.notes).slice(0, 80));
      const arm = await mk("ksNQKhJLA69OyVZi");
      ok("import Enable Cyberarm: cost 4000 + used price in notes", arm.system.cost === 4000 && /used examples ~500eb/.test(arm.system.notes), `${arm.system.cost}`);
      const bd = await mk("tsY2j88C5WxOTbDG");
      ok("import braindance: renamed …Recorder", bd.name === "Super Compact Braindance Recorder", bd.name);
      const finger = await mk("oC2Znx4VqJKXvTYD");
      ok("import Probe Link: cyberfinger option note (hand/arm requirement, 5 per hand)", /cyberhand or cyberarm/.test(finger.system.notes) && /5 cyberfinger options/.test(finger.system.notes), String(finger.system.notes).slice(0, 70));
      const plain = await mk("ZjhRESlVVg9kpjQ9"); // Dynalar Web Hand — uncorrected
      ok("import uncorrected item: untouched", plain.system.cost === 250 && !String(plain.system.notes).includes("Chromebook 3 p.22"), plain.system.cost);

      // ---- PR #41/#42/#43 ports + the RU-payload fixes (patch support) ----
      const mkFrom = async (packId, id) => {
        const doc = await game.packs.get(packId).getDocument(id);
        const it = await Item.create(game.items.fromCompendium(doc));
        created.push(it);
        return it;
      };
      const kiroshi = await mkFrom(PACK, "6YZWh3c73DRynHoi");
      ok("PR41: Kiroshi humanityCost '3d6+' → '3d6'", kiroshi.system.humanityCost === "3d6", kiroshi.system.humanityCost);
      const blitz = await mkFrom(PACK, "Vg33kDXF2VZlqX1K");
      ok("PR43: Blitzkrieg 1050eb / surg M / HC 2d6", blitz.system.cost === 1050 && blitz.system.surgCode === "M" && blitz.system.humanityCost === "2d6", `${blitz.system.cost}/${blitz.system.surgCode}/${blitz.system.humanityCost}`);
      const fak = await mkFrom("cyberpunk2020.medical", "fA02aOWaC6JRuWg8");
      ok("PR41: 'Fist Aid Kit' → 'First Aid Kit'", fak.name === "First Aid Kit", fak.name);
      const gas = await mkFrom("cyberpunk2020.heavy", "CG2nNDkUA2eroMti");
      ok("PR42: Gas Grenade accuracy → 0", Number(gas.system.accuracy) === 0, gas.system.accuracy);
      const nagi = await mkFrom("cyberpunk2020.melee", "CfQQEwck7VZNQzC6");
      ok("PR42: Naginata accuracy '' → 1", Number(nagi.system.accuracy) === 1, nagi.system.accuracy);
      const avante = await mkFrom("cyberpunk2020.exotics", "5d4juFywt9NMCYTw");
      ok("PR43: Avante renamed P-1135 + WA 0", avante.name === "Avante P-1135 Needlegun" && Number(avante.system.accuracy) === 0, `${avante.name}/${avante.system.accuracy}`);
      const kick = await mkFrom("cyberpunk2020.melee", "TF0nBrjofPX2RiuG");
      ok("RU fix: Kick attackSkill → Brawling", kick.system.attackSkill === "Brawling", kick.system.attackSkill);
      const rippers = await mkFrom("cyberpunk2020.cyberweapons", "Ec5j4rEoTSDUkvbY");
      ok("RU fix: Rippers embedded attackSkill → Brawling", rippers.system.CyberWorkType?.Weapon?.attackSkill === "Brawling", rippers.system.CyberWorkType?.Weapon?.attackSkill);
      const hearing = await mkFrom("cyberpunk2020.cyberaudio", "JNhdO6o73hylJLga");
      const sk = hearing.system.CyberWorkType?.Skill ?? {};
      ok("RU fix: Amplified Hearing Skill map keeps _id key + gains EN name key", sk["jBfPdSDGwvIEq66p"] === 1 && sk["Awareness/Notice"] === 1, JSON.stringify(sk));

      // ---- FULL CHAIN: corrected copy on an ACTOR feeds the Characteristic skill engine ----
      const actor = await Actor.create({ name: "__PW__CorrTest", type: "character" });
      const hDoc = await game.packs.get("cyberpunk2020.cyberaudio").getDocument("JNhdO6o73hylJLga");
      const [emb] = await actor.createEmbeddedDocuments("Item", [game.items.fromCompendium(hDoc)]);
      const before = actor._getCharacteristicSkillMod({ id: null, name: "Awareness/Notice" });
      await emb.update({ "system.EffectActive": true });   // Activatable implant: enable it
      const after = actor._getCharacteristicSkillMod({ id: null, name: "Awareness/Notice" });
      ok("full chain: Amplified Hearing grants Awareness/Notice +1 once activated (0 while off)", before === 0 && after === 1, `${before}→${after}`);
      await actor.delete().catch(() => {});

      // ---- request card render: range note + optional price input ----
      const { renderChatCard } = await import(`${M}/compat.js`);
      const withRange = await renderChatCard("shop/purchase-request.hbs", { requester: "P", buyer: "B", name: "Spectrum", qty: 1, total: 1000, pending: true, needsPrice: false, priceRange: { min: 200, max: 1000 } });
      ok("request card (range): shows book range + price input", /200/.test(withRange) && /1000/.test(withRange) && /cp-shop-request-price"/.test(withRange) && !/CYBERPUNK\.Shop/.test(withRange), true);
      const plainCard = await renderChatCard("shop/purchase-request.hbs", { requester: "P", buyer: "B", name: "Knife", qty: 1, total: 20, pending: true, needsPrice: false, priceRange: null });
      ok("request card (normal): NO price input", !/cp-shop-request-price"/.test(plainCard), true);
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    } finally {
      for (const it of created) { try { await it.delete(); } catch {} }
      // remove the test override + rebuild the index so the world is left clean
      try { if (overrideSet) { const S = await import(`${M}/settings.js`); await S.setShopPriceOverride("hqp1XekLTwvDxuIC", null); } } catch {}
      try { (await import(`${M}/shop/catalog.js`)).clearCatalogIndexCache(); } catch {}
    }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("Data corrections (CB3 audit)\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(70)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;
  if (errors.length) { console.error("PAGE ERRORS:", errors.join(" | ")); failures++; }
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
