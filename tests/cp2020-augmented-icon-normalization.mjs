/** Actor icon-normalization shim (module/icon-normalization-shim.js). On :30004 (STOCK base
 *  1.1.1 + module): the base actor field `system.icon` is a strict image FilePathField, so a
 *  legacy string without a recognized extension fails validation at document construction and
 *  the whole actor reads as unavailable. With the shim, migrateData coerces unusable values to
 *  "" before validation (valid paths and object.default shapes preserved), never touches a
 *  partial diff lacking the key, and the disengage predicate stands the wrap down where the
 *  field is relaxed or the upstream normalizer exists. Constructions are in-memory only — no
 *  world data is created or persisted. RED before the module sync, GREEN after. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l))||us[0];await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = { checks: [], fails: [] };
  const check = (n, ok, got) => { out.checks.push(`${ok?"  PASS":"  FAIL"}  ${n}${ok?"":"  got="+JSON.stringify(got)}`); if(!ok) out.fails.push(n); };
  const SH = await import("/modules/cp2020-augmented/module/icon-normalization-shim.js");
  const K = CONFIG.Actor.documentClass;
  const charCls = CONFIG.Actor.dataModels.character;
  const npcCls = CONFIG.Actor.dataModels.npc;
  const F = foundry.data.fields;

  // Precondition: this rig's base field is the STOCK strict one (the hand-patch would make
  // every rescue below vacuous). If this fails, the rig system copy is not the stock reference.
  check("rig precondition: base icon field is a strict FilePathField", charCls.schema.fields.icon instanceof F.FilePathField, charCls.schema.fields.icon?.constructor?.name);

  // Engagement: the wrap is installed and marked on both base actor models.
  check("wrap installed + marked (character model)", charCls.migrateData?.__cpIconShim === true, charCls.migrateData?.__cpIconShim);
  check("wrap installed + marked (npc model)", npcCls.migrateData?.__cpIconShim === true, npcCls.migrateData?.__cpIconShim);

  // Construction rescues (in-memory only, mirrors the upstream PR's verification table).
  const construct = (icon) => { try { const a = new K({ name: "__PW__iconProbe", type: "character", system: { icon } }); return { ok: true, icon: a.system.icon }; } catch (e) { return { ok: false, err: e.message }; } };
  const c1 = construct("systems/cyberpunk2020/icons/runner");
  check("extension-less path constructs, coerced to blank", c1.ok && c1.icon === "", c1);
  const c2 = construct("Default Runner");
  check("bare-label value constructs, coerced to blank", c2.ok && c2.icon === "", c2);
  const c3 = construct("icons/svg/mystery-man.svg");
  check("valid path constructs, preserved untouched", c3.ok && c3.icon === "icons/svg/mystery-man.svg", c3);
  const c4 = construct({ default: "icons/svg/item-bag.svg" });
  check("object shape constructs, flattened to its default (regression guard)", c4.ok && c4.icon === "icons/svg/item-bag.svg", c4);
  const c5 = construct("");
  check("blank constructs, stays blank", c5.ok && c5.icon === "", c5);

  // Partial-diff safety (the migrateData-over-update-changes hazard): a diff WITHOUT the icon
  // key must come back without one — the wrap never adds or default-fills.
  const diff = charCls.migrateData({ damage: 3 });
  check("partial diff lacking the key gains no icon key", !Object.prototype.hasOwnProperty.call(diff, "icon"), diff);

  // Disengage predicate (pure): strict field + no normalizer → needs the shim; the upstream
  // normalizer present, or a relaxed plain-string field → stands down.
  const strictIcon = new F.FilePathField({ categories: ["IMAGE"], blank: true });
  check("predicate: strict field without the normalizer needs the shim", SH.needsIconShim({ schema: { fields: { icon: strictIcon } }, migrateData: function(){} }) === true, null);
  check("predicate: the upstream normalizer present stands down", SH.needsIconShim({ schema: { fields: { icon: strictIcon } }, migrateData: function(){ return "normalizeIconPath"; } }) === false, null);
  check("predicate: a relaxed plain-string field stands down", SH.needsIconShim({ schema: { fields: { icon: new F.StringField({ blank: true }) } }, migrateData: function(){} }) === false, null);

  // Idempotence: re-registration keeps the same wrapped function object.
  const before = charCls.migrateData;
  SH.registerIconNormalizationShim();
  check("re-registration is a no-op (same wrapped function object)", charCls.migrateData === before, null);

  return out;
});

for (const line of r.checks) console.log(line);
const errOk = errors.length === 0;
console.log(`${errOk?"  PASS":"  FAIL"}  0 console errors${errOk?"":"  got="+JSON.stringify(errors.slice(0,5))}`);
const failed = r.fails.length + (errOk ? 0 : 1);
console.log(`\n${r.checks.length + 1} checks, ${failed} failed`);
await b.close();
process.exit(failed ? 1 : 0);
