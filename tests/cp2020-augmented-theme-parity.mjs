/** Colour-scheme parity keeper.
 *
 *  The model this locks down (user ruling): the vendored terminal skin IS the module's look under
 *  Foundry's DARK applications colour scheme, and under the LIGHT scheme the module must be
 *  indistinguishable from the base system. The per-user `carolingianSkin` toggle is retired — the
 *  choice is Foundry's own colour-scheme control.
 *
 *   A  scheme stamping — core puts exactly one of theme-light/theme-dark on <body>, and the skin
 *      class is present IFF the scheme is not light (no third, half-applied state)
 *   B  retirement — the setting is gone, a stale client flag is inert, and a live scheme flip
 *      re-gates the skin with no reload
 *   C  DARK IDENTITY — every recorded computed value equals the pre-change baseline, byte for byte
 *   D  LIGHT PARITY — the shared sheet classes equal the values read out of the BASE stylesheet
 *      at run time (fetched and parsed, not hardcoded), and every skin signature is absent
 *   E  READABILITY — no module surface renders below the contrast floor on the light ground
 *   F  EDITOR SURFACES — closed enumeration, the two surfaces agree in dark, and both equal the
 *      base system's editor rule in light
 *
 *  Baseline: tests/theme-parity-dark-baseline.json (captured on the pre-change serve copy).
 *  Re-capture only with a deliberate, reviewed dark-look change:  node <this> --capture
 *  Screenshots:  node <this> --shots <dir>
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, "theme-parity-dark-baseline.json");
const CAPTURE = process.argv.includes("--capture");
const SHOTS = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? process.argv[i + 1] : null; })();
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1700, height: 1050 } });
const errors = [];
/** Writing core.uiConfig is how a colour scheme is changed, and core's onChange for it calls
 *  canvas.draw() as well as configureUI. On a rig with an active scene that redraw restarts the
 *  scene's ambient audio, and a headless browser has no audio output for it to attach to — so
 *  core's own sound path throws on a null media element. Environmental, reproducible with the
 *  module absent, and unrelated to anything this keeper measures. Filtered by exact text so every
 *  other error still reds the run. */
const ENVIRONMENTAL = [/Cannot set properties of null \(setting 'volume'\)/];
const note = (s) => { if (!ENVIRONMENTAL.some(re => re.test(s))) errors.push(s); };
p.on("pageerror", e => note("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") note("console: " + m.text()); });
await joinGM(p);

const P = [];
const chk = (name, ok, detail = "") => P.push({ name, ok: !!ok, detail: String(detail) });
const S = (o) => JSON.stringify(o);

// ── shared in-page toolkit, installed once ───────────────────────────────────────────────
await p.evaluate(() => {
  const W = (window.__cpTheme = {});
  W.sleep = ms => new Promise(r => setTimeout(r, ms));
  W.PROPS = ["color", "backgroundColor", "backgroundImage", "borderTopColor", "borderBottomColor",
             "borderLeftColor", "borderRightColor", "borderTopWidth", "borderTopStyle",
             "fontFamily", "fontWeight", "textShadow", "boxShadow"];
  W.parseRGB = (s) => { const m = String(s).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
  W.lum = (c) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  W.over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  /** The painted ground behind an element: composite translucent layers down to the first opaque
   *  one. ⚠ The walk must STOP at the window's own `.application` box: core paints the light
   *  application ground with an IMAGE (ui/parchment.jpg), which contributes no background-COLOR,
   *  so an uncapped walk sails straight past the window and reports the dark page behind it —
   *  which reads as a false "black text on black" for every field on a light sheet. When the
   *  window paints an image, the caller's measured ground colour is the truth. */
  W.effBg = (el, fallback) => {
    const layers = []; let n = el; let imageGround = false;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      const c = W.parseRGB(cs.backgroundColor);
      if (c && c.a > 0) { layers.unshift(c); if (c.a === 1) break; }
      if (n.classList?.contains("application")) { if (cs.backgroundImage && cs.backgroundImage !== "none") imageGround = true; break; }
      n = n.parentElement;
    }
    let base = (imageGround && fallback) ? { ...fallback, a: 1 }
             : fallback ? { ...fallback, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
    for (const l of layers) base = W.over(l, base);
    return base;
  };
  W.contrast = (el, fallback) => {
    const fg = W.parseRGB(getComputedStyle(el).color); if (!fg) return null;
    const bg = W.effBg(el, fallback);
    const f = fg.a < 1 ? W.over(fg, bg) : fg;
    const [a, c] = [W.lum(f), W.lum(bg)].sort((x, y) => y - x);
    return Math.round(((a + 0.05) / (c + 0.05)) * 100) / 100;
  };
  W.snap = (el) => { const cs = getComputedStyle(el); const o = {}; for (const k of W.PROPS) o[k] = cs[k]; return o; };
  W.collect = (root, spec) => { const o = {}; for (const [k, sel] of Object.entries(spec)) { const el = root?.querySelector(sel); o[k] = el ? W.snap(el) : null; } return o; };
  W.setScheme = async (applications) => {
    const cfg = foundry.utils.deepClone(game.settings.get("core", "uiConfig"));
    cfg.colorScheme = Object.assign({}, cfg.colorScheme, { applications });
    await game.settings.set("core", "uiConfig", cfg);
    await W.sleep(700);
  };
  /** Normalise a CSS colour keyword the way the browser would compute it. */
  W.normColor = (v) => { const d = document.createElement("span"); d.style.color = ""; d.style.color = v; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
});

const priorScheme = await p.evaluate(() => foundry.utils.deepClone(game.settings.get("core", "uiConfig").colorScheme ?? {}));

// The element set the dark baseline is taken over. Kept in ONE place so capture and compare
// can never drift apart.
const SPEC = {
  actor: {
    windowContent: ".window-content", windowHeader: ".window-header",
    title: "h1.title", titleInput: "h1.title > input", h2: "h2",
    tabsNav: "section.window-content nav.tabs",
    tabActive: "section.window-content nav.tabs > .item.active",
    tabInactive: "section.window-content nav.tabs > .item:not(.active)",
    field: ".field", fieldLabel: ".field > label", fieldInput: ".field > input",
    statBase: ".statsrow > div.stat .stat-base", statTemp: ".statsrow > div.stat .stat-temp",
    statLabel: ".statsrow > div.stat label",
    woundState: ".wound-tracker .wound-state", armorSegment: ".armor-display .armor-segment",
  },
  item: {
    windowContent: ".window-content", title: "h1.title", titleInput: "h1.title > input",
    tabsNav: "section.window-content nav.tabs",
    tabActive: "section.window-content nav.tabs > .item.active",
    tabInactive: "section.window-content nav.tabs > .item:not(.active)",
    field: ".field", fieldLabel: ".field > label", fieldInput: ".field > input",
    fieldSelect: ".field select", flavor: "textarea.flavor",
  },
  catalog: {
    windowContent: ".window-content", chip: ".cp-cat-chip", row: ".cp-catalog-row",
    letterHeader: ".cp-letter-header", filters: ".cp-catalog-filters",
    sources: ".cp-catalog-sources", input: "input[type=text]",
    addBtn: ".cp-add-to-shop-btn", srcBadge: ".cp-src-badge",
  },
  goon: { windowContent: ".window-content", band: ".cp-goon-band" },
  ip: {
    windowContent: ".window-content", header: ".cyber-section-header",
    pipeline: ".cp-ip-pipeline", pipeStep: ".cp-ip-pipe-step b", input: "input",
  },
  chat: { card: ".cyberpunk", cardH2: ".cyberpunk h2", success: ".result-success" },
  editorItem: {
    canvas: ".cp-notes-canvas", view: ".cp-notes-view", editBtn: ".cp-notes-edit",
  },
  editorLife: {
    canvas: ".cp-notes-canvas", view: ".cp-notes-view", editBtn: ".cp-notes-edit",
  },
};

/** Open every measured surface for one scheme and return the whole reading. */
const readAll = (spec) => p.evaluate(async (spec) => {
  const W = window.__cpTheme;
  const out = { bodyClasses: Array.from(document.body.classList), surfaces: {}, notes: [] };

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__THEME"))) await a.delete().catch(() => {});
  for (const i of game.items.filter(i => i.name.startsWith("__PW__THEME"))) await i.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__THEME punk", type: "character" });
  const item = await Item.create({ name: "__PW__THEME gun", type: "weapon" });

  await actor.sheet.render(true); await W.sleep(1600);
  const aRoot = actor.sheet.element.closest(".application") ?? actor.sheet.element;
  out.surfaces.actor = W.collect(aRoot, spec.actor);
  out.appGround = getComputedStyle(aRoot).backgroundImage;
  // Skin signatures, read where they live rather than inferred from the class list.
  const tab = aRoot.querySelector("section.window-content nav.tabs > .item");
  const h2 = aRoot.querySelector("h2");
  out.signatures = {
    tabBracket: tab ? getComputedStyle(tab, "::before").content : null,
    promptCaret: h2 ? getComputedStyle(h2, "::before").content : null,
    promptAnimation: h2 ? getComputedStyle(h2, "::before").animationName : null,
    bodyFont: getComputedStyle(aRoot.querySelector("section.window-content")).fontFamily,
  };
  await actor.sheet.close(); await W.sleep(250);

  await item.sheet.render(true); await W.sleep(1300);
  const iRoot = item.sheet.element.closest(".application") ?? item.sheet.element;
  out.surfaces.item = W.collect(iRoot, spec.item);
  const ground = W.parseRGB(getComputedStyle(iRoot.querySelector(".window-content")).backgroundColor);
  out.itemFieldInputs = Array.from(iRoot.querySelectorAll(".field > input[type=text], .field > input[type=number]"))
    .filter(e => e.getBoundingClientRect().width > 0).slice(0, 40)
    .map(e => ({ name: e.name || e.className, color: getComputedStyle(e).color }));
  out.itemFieldBorders = Array.from(iRoot.querySelectorAll(".field"))
    .filter(e => e.getBoundingClientRect().width > 0).slice(0, 20)
    .map(e => getComputedStyle(e).borderTopColor);
  await item.sheet.close(); await W.sleep(250);

  try {
    const cat = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    cat.openCatalogBrowser(actor); await W.sleep(2500);
    // The catalog opens on its category tiles; the elements sampled below (rows, letter headers,
    // the filter chips and the two rails) live in the item list one step in.
    document.querySelector('.application.cp-catalog .cp-cat-tile[data-cat=""]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await W.sleep(3000);
    const r = document.querySelector(".application.cp-catalog");
    out.surfaces.catalog = r ? W.collect(r, spec.catalog) : null;
    for (const app of foundry.applications.instances.values()) if (app.options?.classes?.includes?.("cp-catalog")) await app.close();
    await W.sleep(250);
  } catch (e) { out.notes.push("catalog: " + e.message); }

  try {
    const g = await import("/modules/cp2020-augmented/module/npcgen/npcgen-app.js");
    g.openNpcGenerator(); await W.sleep(2000);
    const r = document.querySelector(".application.cp-npcgen-app") ?? document.getElementById("cp-npcgen");
    out.surfaces.goon = r ? W.collect(r, spec.goon) : null;
    for (const app of foundry.applications.instances.values()) if (app.options?.classes?.includes?.("cp-npcgen-app")) await app.close();
    await W.sleep(250);
  } catch (e) { out.notes.push("goon: " + e.message); }

  try {
    const t = await import("/modules/cp2020-augmented/module/ip/tracker.js");
    const Cls = t.IpTracker ?? t.IPTracker ?? t.default;
    if (typeof t.openIpTracker === "function") t.openIpTracker(); else if (Cls) new Cls().render(true);
    await W.sleep(1800);
    const r = document.querySelector(".application.cp-ip-tracker") ?? document.getElementById("cp-ip-tracker");
    out.surfaces.ip = r ? W.collect(r, spec.ip) : null;
    for (const app of foundry.applications.instances.values()) if (app.options?.classes?.includes?.("cp-ip-tracker")) await app.close();
    await W.sleep(250);
  } catch (e) { out.notes.push("ip: " + e.message); }

  try {
    const msg = await ChatMessage.create({ content: '<div class="cyberpunk cyberpunk-card"><h2>__PW__THEME</h2><p>row</p><span class="result-success">ok</span></div>' });
    await W.sleep(700);
    const el = document.querySelector(`.chat-message[data-message-id="${msg.id}"]`);
    out.surfaces.chat = el ? W.collect(el, spec.chat) : null;
    await msg.delete().catch(() => {});
  } catch (e) { out.notes.push("chat: " + e.message); }

  await actor.delete().catch(() => {});
  await item.delete().catch(() => {});
  return out;
}, spec);

// ══ A · scheme stamping ══════════════════════════════════════════════════════════════════
await p.evaluate(() => window.__cpTheme.setScheme("dark"));
const darkBody = await p.evaluate(() => Array.from(document.body.classList));
chk("A1 dark scheme: core stamps exactly one theme class on <body>",
  darkBody.filter(c => /^theme-(light|dark)$/.test(c)).length === 1 && darkBody.includes("theme-dark"), S(darkBody));
chk("A2 dark scheme: the skin class is applied", darkBody.includes("cp-carolingian"), S(darkBody));

await p.evaluate(() => window.__cpTheme.setScheme("light"));
const lightBody = await p.evaluate(() => Array.from(document.body.classList));
chk("A3 light scheme: core stamps exactly one theme class on <body>",
  lightBody.filter(c => /^theme-(light|dark)$/.test(c)).length === 1 && lightBody.includes("theme-light"), S(lightBody));
chk("A4 light scheme: the skin class is withdrawn (negative case)", !lightBody.includes("cp-carolingian"), S(lightBody));

// ══ B · retirement of the per-user toggle ════════════════════════════════════════════════
const retirement = await p.evaluate(async () => {
  const W = window.__cpTheme;
  const registered = game.settings.settings.has("cp2020-augmented.carolingianSkin");
  // A world upgraded from an older build still carries the orphan client value. It must be inert.
  const KEY = "cp2020-augmented.carolingianSkin";
  const had = window.localStorage.getItem(KEY);
  window.localStorage.setItem(KEY, "false");
  const a = await Actor.create({ name: "__PW__THEME stale", type: "character" });
  await a.sheet.render(true); await W.sleep(1200);
  const classWithStaleFlag = document.body.classList.contains("cp-carolingian");
  await a.sheet.close(); await a.delete().catch(() => {});
  if (had === null) window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, had);

  // Live flip, no reload: core rewrites the <body> class, our observer re-gates on it.
  const marker = (window.__cpReloadMarker ??= Math.random());
  await W.setScheme("dark");
  const afterDark = { skin: document.body.classList.contains("cp-carolingian"), marker: window.__cpReloadMarker === marker };
  await W.setScheme("light");
  const afterLight = { skin: document.body.classList.contains("cp-carolingian"), marker: window.__cpReloadMarker === marker };
  return { registered, classWithStaleFlag, afterDark, afterLight,
           settingsMenuKeys: Array.from(game.settings.settings.keys()).filter(k => /carolingian/i.test(k)) };
});
chk("B1 the per-user skin setting is no longer registered", retirement.registered === false, S({ registered: retirement.registered, matches: retirement.settingsMenuKeys }));
chk("B2 a stale client flag from an older build does not re-gate the skin (light stays light)",
  retirement.classWithStaleFlag === false, S(retirement));
chk("B3 live flip to dark re-applies the skin with no page reload",
  retirement.afterDark.skin === true && retirement.afterDark.marker === true, S(retirement.afterDark));
chk("B4 live flip back to light withdraws it, still with no reload",
  retirement.afterLight.skin === false && retirement.afterLight.marker === true, S(retirement.afterLight));

// ══ C · dark identity against the recorded baseline ══════════════════════════════════════
await p.evaluate(() => window.__cpTheme.setScheme("dark"));
const dark = await readAll(SPEC);
if (SHOTS) { await p.screenshot({ path: path.join(SHOTS, "dark-after-actor-sheet.png") }); }

if (CAPTURE) {
  fs.writeFileSync(BASELINE, JSON.stringify({ surfaces: dark.surfaces, itemFieldInputs: dark.itemFieldInputs, itemFieldBorders: dark.itemFieldBorders, signatures: dark.signatures }, null, 1));
  console.log("baseline written:", BASELINE);
} else if (!fs.existsSync(BASELINE)) {
  chk("C0 dark baseline file present", false, BASELINE);
} else {
  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  const drift = [];
  let compared = 0;
  const walk = (a, b, at) => {
    for (const k of Object.keys(a ?? {})) {
      const va = a[k], vb = (b ?? {})[k];
      if (va && typeof va === "object" && !Array.isArray(va)) { walk(va, vb, at + "." + k); continue; }
      compared++;
      if (String(va) !== String(vb)) drift.push(`${at}.${k}: baseline=${va} now=${vb}`);
    }
  };
  walk(base.surfaces, dark.surfaces, "surfaces");
  walk({ itemFieldInputs: base.itemFieldInputs, itemFieldBorders: base.itemFieldBorders, signatures: base.signatures },
       { itemFieldInputs: dark.itemFieldInputs, itemFieldBorders: dark.itemFieldBorders, signatures: dark.signatures }, "");
  chk(`C1 dark rendering identical to the recorded baseline (${compared} computed values)`,
    drift.length === 0, drift.slice(0, 12).join(" | "));
}
chk("C2 the skin's signature rules ARE live in dark (positive case)",
  /\[/.test(String(dark.signatures.tabBracket)) && dark.signatures.promptAnimation !== "none"
  && /Work Sans/.test(dark.signatures.bodyFont),
  S(dark.signatures));

// ══ D · light parity against values parsed out of the BASE stylesheet ════════════════════
await p.evaluate(() => window.__cpTheme.setScheme("light"));
const light = await readAll(SPEC);

const baseExpect = await p.evaluate(async () => {
  const W = window.__cpTheme;
  const css = await (await fetch("/systems/cyberpunk2020/css/cyberpunk2020.css")).text();
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  /** Last declaration of `prop` in the rule whose selector list contains `sel` verbatim. */
  const decl = (sel, prop) => {
    let found = null;
    for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sels = m[1].split(",").map(s => s.trim().replace(/\s+/g, " "));
      if (!sels.includes(sel)) continue;
      for (const d of m[2].split(";")) {
        const i = d.indexOf(":"); if (i < 0) continue;
        if (d.slice(0, i).trim().toLowerCase() !== prop) continue;
        found = d.slice(i + 1).replace(/!important/, "").trim();
      }
    }
    return found;
  };
  /** Colour out of a shorthand like "2px solid black" or "1px solid rgb(90, 90, 90)" — strip the
   *  width and the line style off the whole string rather than tokenising on whitespace, which
   *  splits an rgb() triple into pieces. */
  const colorOf = (v) => {
    if (!v) return null;
    const rest = v.replace(/\b\d+(\.\d+)?(px|em|rem|%)?\b(?![\d,)])/g, " ")
                  .replace(/\b(solid|dashed|dotted|none|groove|ridge|inset|outset|double|hidden)\b/g, " ")
                  .replace(/\s+/g, " ").trim();
    return rest ? W.normColor(rest) : null;
  };
  return {
    fieldBorder:      W.normColor(decl(".cyberpunk .field", "border-color")),
    fieldChildBg:     W.normColor(decl(".cyberpunk .field > *", "background-color")),
    fieldChildColor:  W.normColor(decl(".cyberpunk .field > *", "color")),
    fieldInputColor:  W.normColor(decl(".cyberpunk .field > input", "color")),
    fieldSelectBorder: colorOf(decl(".cyberpunk .field select", "border")),
    tabsNavBorder:    colorOf(decl(".cyberpunk section.window-content nav.tabs", "border-bottom")),
    tabActiveColor:   W.normColor(decl(".cyberpunk section.window-content nav.tabs > .item.active", "color")),
    tabActiveBg:      W.normColor(decl(".cyberpunk section.window-content nav.tabs > .item.active", "background-color")),
    statBaseColor:    W.normColor(decl(".statsrow > div.stat .stat-base", "color")),
    statBaseBg:       W.normColor(decl(".statsrow > div.stat .stat-base", "background")),
    statBaseBorder:   W.normColor(decl(".statsrow > div.stat .stat-base", "border-color")),
    statTempBg:       W.normColor(decl(".statsrow > div.stat .stat-temp", "background")),
    statTempColor:    W.normColor(decl(".statsrow > div.stat .stat-temp", "color")),
    flavorBorder:     colorOf(decl(".cyberpunk textarea.flavor", "border")),
    armorSegBorder:   colorOf(decl(".cyberpunk .armor-display .armor-segment", "border")),
    woundStateBorder: colorOf(decl(".wound-tracker .wound-state", "border")),
    editorBorder:     colorOf(decl(".cyberpunk section.window-content .editor-content", "border")),
    editorBorderWidth: (decl(".cyberpunk section.window-content .editor-content", "border") || "").split(/\s+/)[0],
    editorGround:     decl(".cyberpunk section.window-content .editor-content", "background-color"),
  };
});

const eq = (name, got, want) => chk(name, String(got) === String(want), `got=${got} base=${want}`);
eq("D1 light: .field border equals the base stylesheet's value", light.surfaces.actor.field?.borderTopColor, baseExpect.fieldBorder);
eq("D2 light: .field label ink equals the base stylesheet's value", light.surfaces.actor.fieldLabel?.color, baseExpect.fieldChildColor);
eq("D3 light: .field label ground equals the base stylesheet's value", light.surfaces.actor.fieldLabel?.backgroundColor, baseExpect.fieldChildBg);
eq("D4 light: .field input ink equals the base stylesheet's value", light.surfaces.actor.fieldInput?.color, baseExpect.fieldInputColor);
eq("D5 light: tab strip rule equals the base stylesheet's value", light.surfaces.actor.tabsNav?.borderBottomColor, baseExpect.tabsNavBorder);
eq("D6 light: active tab ink equals the base stylesheet's value", light.surfaces.actor.tabActive?.color, baseExpect.tabActiveColor);
eq("D7 light: active tab ground equals the base stylesheet's value", light.surfaces.actor.tabActive?.backgroundColor, baseExpect.tabActiveBg);
eq("D8 light: stat base box ink equals the base stylesheet's value", light.surfaces.actor.statBase?.color, baseExpect.statBaseColor);
eq("D9 light: stat base box ground equals the base stylesheet's value", light.surfaces.actor.statBase?.backgroundColor, baseExpect.statBaseBg);
eq("D10 light: stat base box rule equals the base stylesheet's value", light.surfaces.actor.statBase?.borderTopColor, baseExpect.statBaseBorder);
eq("D11 light: stat temp box ground equals the base stylesheet's value", light.surfaces.actor.statTemp?.backgroundColor, baseExpect.statTempBg);
eq("D12 light: stat temp box ink equals the base stylesheet's value", light.surfaces.actor.statTemp?.color, baseExpect.statTempColor);
eq("D13 light: wound state rule equals the base stylesheet's value", light.surfaces.actor.woundState?.borderTopColor, baseExpect.woundStateBorder);
eq("D14 light: armor segment rule equals the base stylesheet's value", light.surfaces.actor.armorSegment?.borderTopColor, baseExpect.armorSegBorder);
eq("D15 light: item flavour box rule equals the base stylesheet's value", light.surfaces.item.flavor?.borderTopColor, baseExpect.flavorBorder);
eq("D16 light: item field select rule equals the base stylesheet's value", light.surfaces.item.fieldSelect?.borderTopColor, baseExpect.fieldSelectBorder);
chk("D17 light: every item-sheet field input carries the base ink, none excepted",
  (light.itemFieldInputs ?? []).length > 0 && light.itemFieldInputs.every(x => x.color === baseExpect.fieldInputColor),
  S([...new Set((light.itemFieldInputs ?? []).map(x => x.color))]));
chk("D18 light: every item-sheet field rule carries the base colour, none excepted",
  (light.itemFieldBorders ?? []).length > 0 && light.itemFieldBorders.every(x => x === baseExpect.fieldBorder),
  S([...new Set(light.itemFieldBorders ?? [])]));
chk("D19 light: the application ground is core's own light page, not a module colour",
  /parchment/.test(String(light.appGround)), S({ ground: light.appGround }));
chk("D20 light: no skin signature survives — no bracket glyphs, no prompt caret, no skin face",
  String(light.signatures.tabBracket) === "none" && String(light.signatures.promptAnimation) === "none"
  && !/Work Sans/.test(String(light.signatures.bodyFont)),
  S(light.signatures));
chk("D21 light: chat cards drop the module ground and inherit the log's, as a base install does",
  light.surfaces.chat?.card?.backgroundColor === "rgba(0, 0, 0, 0)", S(light.surfaces.chat?.card));

/* D22 · the module ships a SECOND stylesheet, registered into the base system's cascade layer so
 * it can out-rank the base's own !important rules (css/cp2020-augmented-system-layer.css). Its
 * one colour rule cannot be measured through the light-scheme layer above — nothing overrides an
 * !important from a different layer — so it is asserted at the source: the value it falls back to
 * when `--cp-line` is undefined (i.e. under the light scheme) must be the value of the base rule
 * it displaces. Both sides are read out of the live stylesheets. */
const layerParity = await p.evaluate(async () => {
  const W = window.__cpTheme;
  const grab = async (url) => (await (await fetch(url)).text()).replace(/\/\*[\s\S]*?\*\//g, " ");
  const decl = (css, sel, prop) => {
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sels = m[1].split(",").map(s => s.trim().replace(/\s+/g, " "));
      if (!sels.includes(sel)) continue;
      for (const d of m[2].split(";")) {
        const i = d.indexOf(":"); if (i < 0) continue;
        if (d.slice(0, i).trim().toLowerCase() === prop) return d.slice(i + 1).replace(/!important/, "").trim();
      }
    }
    return null;
  };
  const ourCss = await grab("/modules/cp2020-augmented/css/cp2020-augmented-system-layer.css");
  const baseCss = await grab("/systems/cyberpunk2020/css/cyberpunk2020.css");
  const ours = decl(ourCss, ".application.cyberpunk .active-cyberware .active-cyberware-segment:hover", "border-color");
  const base = decl(baseCss, ".active-cyberware .active-cyberware-segment:hover", "border-color");
  const fallback = (ours ?? "").match(/var\(\s*--[a-z0-9-]+\s*,\s*([^)]+)\)/i)?.[1]?.trim() ?? null;
  // Closed check that this really is the only colour-bearing declaration in that file.
  const colourDecls = [...ourCss.matchAll(/(^|[;{])\s*(color|background|background-color|border[a-z-]*|outline[a-z-]*|box-shadow|fill|stroke)\s*:/gi)].length;
  return { ours, base, fallback, lightValue: fallback ? W.normColor(fallback) : null,
           baseValue: base ? W.normColor(base) : null, colourDecls };
});
chk("D22 light: the system-layer stylesheet's one colour rule falls back to the base rule's own value",
  layerParity.lightValue !== null && layerParity.lightValue === layerParity.baseValue, S(layerParity));
chk("D23 the system-layer stylesheet still carries exactly the colour rules this check covers",
  layerParity.colourDecls === 2, S({ colourBearingDeclarations: layerParity.colourDecls }));

// ══ E · readability floor on the light ground ════════════════════════════════════════════
const readability = await p.evaluate(async () => {
  const W = window.__cpTheme;
  const a = await Actor.create({ name: "__PW__THEME punk2", type: "character" });
  const i = await Item.create({ name: "__PW__THEME gun2", type: "weapon" });
  await i.sheet.render(true); await W.sleep(1300);
  const root = i.sheet.element.closest(".application") ?? i.sheet.element;
  // Core paints the light page with an image, so hand the measurer that ground explicitly.
  const GROUND = { r: 218, g: 216, b: 205 };
  const rows = [];
  for (const el of root.querySelectorAll("label, input, select, .field > span, h1.title, h2, nav.tabs > .item")) {
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    const txt = (el.value ?? el.textContent ?? "").trim(); if (!txt) continue;
    const c = W.contrast(el, GROUND); if (c === null) continue;
    rows.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 30), contrast: c });
  }
  await i.sheet.close(); await a.delete().catch(() => {}); await i.delete().catch(() => {});
  const worst = rows.slice().sort((x, y) => x.contrast - y.contrast).slice(0, 5);
  return { count: rows.length, worst, min: worst[0]?.contrast ?? null };
});
chk("E1 light item sheet: every legible text node clears the 4.5:1 floor on the light ground",
  readability.count > 10 && readability.min >= 4.5, S(readability));

// ══ F · rich-text editor surfaces ════════════════════════════════════════════════════════
/** Open one editor surface and read it in view mode and again in edit mode. */
const readEditor = (kind) => p.evaluate(async (kind) => {
  const W = window.__cpTheme;
  for (const it of game.items.filter(i => i.name.startsWith("__PW__ED"))) await it.delete().catch(() => {});
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__ED"))) await a.delete().catch(() => {});
  const doc = kind === "item"
    ? await Item.create({ name: "__PW__ED gun", type: "weapon", system: { notes: "<p>parity sample</p>" } })
    : await Actor.create({ name: "__PW__ED punk", type: "character", system: { notes: "<p>parity sample</p>" } });
  await doc.sheet.render(true); await W.sleep(kind === "item" ? 1100 : 1600);
  const root = doc.sheet.element.closest(".application") ?? doc.sheet.element;
  root.querySelector(kind === "item" ? 'nav.sheet-tabs a[data-tab="notes"]' : 'nav a[data-tab="life"]')?.click();
  await W.sleep(400);
  const readOne = () => {
    const canvas = root.querySelector(".cp-notes-canvas");
    const view = root.querySelector(".cp-notes-view");
    const pm = root.querySelector(".cp-notes-prosemirror");
    const content = root.querySelector("prose-mirror .ProseMirror") ?? root.querySelector(".editor-content");
    const menu = root.querySelector("prose-mirror menu") ?? root.querySelector("prose-mirror .editor-menu");
    const grab = (el) => el ? W.snap(el) : null;
    return { canvas: grab(canvas), view: grab(view), prosemirror: grab(pm), content: grab(content), menu: grab(menu),
             has: { canvas: !!canvas, view: !!view, pm: !!pm, content: !!content, menu: !!menu } };
  };
  const viewMode = readOne();
  root.querySelector(".cp-notes-edit")?.click();
  await W.sleep(1200);
  const editMode = readOne();
  return { appId: root.id, docId: doc.id, viewMode, editMode };
}, kind);

/** Closed enumeration: which module sheets host a rich-text canvas at all. */
const editorCensus = await p.evaluate(async () => {
  const W = window.__cpTheme;
  const out = { itemTypesWithCanvas: [], itemTypesWithout: [], actorTypesWithCanvas: [], actorTypesWithout: [] };
  for (const type of Object.keys(CONFIG.Item.dataModels ?? {}).filter(t => t !== "base")) {
    let it; try { it = await Item.create({ name: `__PW__CENSUS ${type}`, type }); } catch { out.itemTypesWithout.push(type); continue; }
    await it.sheet.render(true); await W.sleep(500);
    const root = it.sheet.element.closest(".application") ?? it.sheet.element;
    root.querySelector('nav.sheet-tabs a[data-tab="notes"]')?.click(); await W.sleep(200);
    (root.querySelector(".cp-notes-canvas") ? out.itemTypesWithCanvas : out.itemTypesWithout).push(type);
    await it.sheet.close(); await it.delete().catch(() => {});
  }
  for (const type of Object.keys(CONFIG.Actor.dataModels ?? {}).filter(t => t !== "base")) {
    let a; try { a = await Actor.create({ name: `__PW__CENSUS ${type}`, type }); } catch { out.actorTypesWithout.push(type); continue; }
    await a.sheet.render(true); await W.sleep(700);
    const root = a.sheet.element.closest(".application") ?? a.sheet.element;
    root.querySelector('nav a[data-tab="life"]')?.click(); await W.sleep(250);
    (root.querySelector(".cp-notes-canvas") ? out.actorTypesWithCanvas : out.actorTypesWithout).push(type);
    await a.sheet.close(); await a.delete().catch(() => {});
  }
  return out;
});
chk("F1 closed enumeration: the rich-text canvas appears only on the notes-bearing item types",
  editorCensus.itemTypesWithCanvas.slice().sort().join(",") === ["skill","program","weapon","ammo","armor","cyberware","vehicle","misc"].sort().join(","),
  S(editorCensus));
chk("F2 closed enumeration: the two personnel actor types host it (the Life tab); the vehicle sheet hosts none",
  editorCensus.actorTypesWithCanvas.slice().sort().join(",") === "character,npc"
  && editorCensus.actorTypesWithout.every(t => /vehicle/.test(t)),
  S({ with: editorCensus.actorTypesWithCanvas, without: editorCensus.actorTypesWithout }));

// dark: the two surfaces must agree
await p.evaluate(() => window.__cpTheme.setScheme("dark"));
const edItemDark = await readEditor("item");
if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "dark-editor-item-edit.png") });
const edLifeDark = await readEditor("actor");
if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "dark-editor-life-edit.png") });

/** Ground, ink, rule, menubar strip — and typography, because prose that reads in a different
 *  face or weight on one of the two sheets is exactly the inconsistency this section exists to
 *  catch (it was live until this unit: the item Notes rules pinned no type block). */
const SURFACE_PROPS = ["color", "backgroundColor", "borderTopColor", "borderTopWidth", "borderTopStyle", "boxShadow",
                       "fontFamily", "fontWeight"];
const cmpEditors = (a, b, mode, label, props) => {
  const keys = ["canvas", "view", "prosemirror", "content", "menu"];
  const diffs = [];
  for (const k of keys) {
    const va = a[mode][k], vb = b[mode][k];
    if (!va || !vb) { if (!!va !== !!vb) diffs.push(`${k}: present item=${!!va} life=${!!vb}`); continue; }
    for (const prop of props) {
      if (String(va[prop]) !== String(vb[prop])) diffs.push(`${k}.${prop}: item=${va[prop]} life=${vb[prop]}`);
    }
  }
  chk(label, diffs.length === 0, diffs.slice(0, 8).join(" | "));
};
cmpEditors(edItemDark, edLifeDark, "viewMode", "F3 dark: the two editor surfaces share one treatment in view mode", SURFACE_PROPS);
cmpEditors(edItemDark, edLifeDark, "editMode", "F4 dark: the two editor surfaces share one treatment in edit mode", SURFACE_PROPS);
chk("F3b dark: editor prose is set at a normal weight, not the bold sheet copy around it",
  edItemDark.viewMode.view?.fontWeight === "400" && edLifeDark.viewMode.view?.fontWeight === "400",
  S({ item: edItemDark.viewMode.view?.fontWeight, life: edLifeDark.viewMode.view?.fontWeight }));
chk("F5 dark: both editor surfaces actually mounted a content area in edit mode",
  edItemDark.editMode.has.content && edLifeDark.editMode.has.content,
  S({ item: edItemDark.editMode.has, life: edLifeDark.editMode.has }));

// light: both must equal the base system's editor rule
await p.evaluate(() => window.__cpTheme.setScheme("light"));
const edItemLight = await readEditor("item");
if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "light-editor-item-edit.png") });
const edLifeLight = await readEditor("actor");
if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "light-editor-life-edit.png") });
cmpEditors(edItemLight, edLifeLight, "viewMode", "F6 light: the two editor surfaces agree in view mode, typography included", SURFACE_PROPS);
cmpEditors(edItemLight, edLifeLight, "editMode", "F7 light: the two editor surfaces agree in edit mode, typography included", SURFACE_PROPS);

for (const [who, ed] of [["item notes", edItemLight], ["actor life", edLifeLight]]) {
  eq(`F8 light ${who}: canvas rule colour equals the base stylesheet's editor rule`,
    ed.viewMode.canvas?.borderTopColor, baseExpect.editorBorder);
  eq(`F9 light ${who}: canvas rule width equals the base stylesheet's editor rule`,
    ed.viewMode.canvas?.borderTopWidth, baseExpect.editorBorderWidth);
  chk(`F10 light ${who}: canvas carries no ground of its own, as the base editor does not`,
    ed.viewMode.canvas?.backgroundColor === "rgba(0, 0, 0, 0)" && baseExpect.editorGround === null,
    S({ canvas: ed.viewMode.canvas?.backgroundColor, base: baseExpect.editorGround }));
  eq(`F11 light ${who}: view ink is the base stylesheet's field ink`,
    ed.viewMode.view?.color, baseExpect.fieldInputColor);
}

/* F12 · the editor's reading face is the BASE system's body face in both schemes, not the skin's
 * display face. The skin deliberately re-faces sheet chrome; prose is exempt, so a note written
 * on a dark sheet and read on a light one is the same text in the same face. */
chk("F12 the editor face is the base system's body face under BOTH schemes",
  /Noto Sans/.test(String(edItemDark.viewMode.view?.fontFamily))
  && /Noto Sans/.test(String(edLifeDark.viewMode.view?.fontFamily))
  && /Noto Sans/.test(String(edItemLight.viewMode.view?.fontFamily))
  && /Noto Sans/.test(String(edLifeLight.viewMode.view?.fontFamily)),
  S({ itemDark: edItemDark.viewMode.view?.fontFamily, lifeDark: edLifeDark.viewMode.view?.fontFamily,
      itemLight: edItemLight.viewMode.view?.fontFamily, lifeLight: edLifeLight.viewMode.view?.fontFamily }));

// ── extra screenshots for the user's eyes ────────────────────────────────────────────────
if (SHOTS) try {
  /** Close only the document sheets and module windows this run opened — never core's own UI
   *  singletons (closing the hotbar leaves configureUI dereferencing a null element). */
  const closeMine = () => p.evaluate(async () => {
    for (const app of Array.from(foundry.applications.instances.values())) {
      const cls = app.options?.classes ?? [];
      const mine = app.document?.name?.startsWith?.("__PW__")
        || cls.some(c => /^cp-(catalog|ip-tracker|npcgen-app|goon-app)$/.test(c));
      if (mine) await app.close?.().catch(() => {});
    }
  });
  const shoot = async (scheme, what, open) => {
    await p.evaluate((s) => window.__cpTheme.setScheme(s), scheme);
    await p.evaluate(open); await p.waitForTimeout(2200);
    await p.screenshot({ path: path.join(SHOTS, `${scheme}-${what}.png`) });
    await closeMine();
    await p.waitForTimeout(400);
  };
  const openActor = async () => { const a = await Actor.create({ name: "__PW__SHOT punk", type: "character" }); await a.sheet.render(true); };
  const openItem = async () => { const i = await Item.create({ name: "__PW__SHOT gun", type: "weapon" }); await i.sheet.render(true); };
  const openCatalog = async () => { const m = await import("/modules/cp2020-augmented/module/shop/catalog.js"); const a = game.actors.find(x => x.name === "__PW__SHOT punk") ?? await Actor.create({ name: "__PW__SHOT punk", type: "character" }); m.openCatalogBrowser(a); };
  await shoot("light", "actor-sheet", openActor);
  await shoot("light", "item-sheet", openItem);
  await shoot("light", "shop-catalog", openCatalog);
  await shoot("dark", "actor-sheet", openActor);
  await shoot("dark", "item-sheet", openItem);
  await shoot("dark", "shop-catalog", openCatalog);
  // view-mode editor shots (edit-mode ones were taken above)
  for (const scheme of ["dark", "light"]) {
    await p.evaluate((s) => window.__cpTheme.setScheme(s), scheme);
    for (const kind of ["item", "actor"]) {
      await p.evaluate(async (kind) => {
        const W = window.__cpTheme;
        for (const it of game.items.filter(i => i.name.startsWith("__PW__ED"))) await it.delete().catch(() => {});
        for (const a of game.actors.filter(a => a.name.startsWith("__PW__ED"))) await a.delete().catch(() => {});
        const doc = kind === "item"
          ? await Item.create({ name: "__PW__ED gun", type: "weapon", system: { notes: "<p>parity sample</p>" } })
          : await Actor.create({ name: "__PW__ED punk", type: "character", system: { notes: "<p>parity sample</p>" } });
        await doc.sheet.render(true); await W.sleep(kind === "item" ? 1100 : 1600);
        const root = doc.sheet.element.closest(".application") ?? doc.sheet.element;
        root.querySelector(kind === "item" ? 'nav.sheet-tabs a[data-tab="notes"]' : 'nav a[data-tab="life"]')?.click();
        await W.sleep(500);
      }, kind);
      await p.screenshot({ path: path.join(SHOTS, `${scheme}-editor-${kind === "item" ? "item" : "life"}-view.png`) });
      await closeMine();
      await p.waitForTimeout(300);
    }
  }
} catch (e) { chk("S1 screenshot pass completed", false, String(e.message).split("\n")[0]); }

// ── restore world state, then the standing zero-error check ──────────────────────────────
await p.evaluate(async (prior) => {
  const cfg = foundry.utils.deepClone(game.settings.get("core", "uiConfig"));
  cfg.colorScheme = prior;
  await game.settings.set("core", "uiConfig", cfg);
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__"))) await a.delete().catch(() => {});
  for (const i of game.items.filter(i => i.name.startsWith("__PW__"))) await i.delete().catch(() => {});
}, priorScheme).catch(() => {});

chk("Z 0 console errors across the whole run", errors.length === 0, errors.slice(0, 5).join(" | "));

let fail = 0;
for (const r of P) { if (!r.ok) fail++; console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  — " + r.detail}`); }
console.log(`\n${P.length - fail}/${P.length} checks passed`);
await b.close();
process.exit(fail ? 1 : 0);
