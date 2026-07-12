import { buyItem, FASHION_STYLES, styleMultOf, resolveCatalogPrice, isValidPrice } from "./purchase.js";
import { correctionFor, correctedCost } from "../data-corrections.js";
import { buyAndInstallCyberware } from "../cyberware/install.js";
import { classifyService, payOneOffService } from "./services.js";
import { classifySupplement, shortSupplement, isVisibleTo, knownOfficialSupplements, knownNoncanonSources } from "./supplements.js";
import { categoryOfPack, categoryOfItem, isMappedPack, CATEGORIES, EXCLUDED_TYPES, catalogPacks } from "./categories.js";
import { shoppingEnabled, shopBuySource, shopSourceConfig, shopShowSource, shopAllowHomebrew, getShopPriceOverrides, setShopPriceOverride } from "../settings.js";
import { shimmerWindow } from "../shimmer.js";
import { renderChatCard } from "../compat.js";
import { getCalibers, getCaliberBox, getAmmoBoxPrice, modifiersForCaliber } from "../lookups.js";
import { purchaseAmmo } from "./buy-ammo.js";
import {
  getShop, listShops, shopsVisibleTo, createShop, updateShop, deleteShop, duplicateShop,
  addShopItem, addShopItems, removeShopItem, clearShopItems, setShopItem, setAllShopStock, decrementShopStock,
  normalizeShopItem, effectivePrice
} from "./shops.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// ── Render-edge i18n for the (pure, English) shop taxonomy + fashion tables ──────────────────────────
// CATEGORIES (categories.js) and FASHION_STYLES (purchase.js) stay i18n-free + unit-tested — their keys
// are STABLE English identities (matched against item category/sub and stored on shop items). We map those
// identities to label keys HERE, at the render edge, so localization never enters the pure data (the
// pure/impure boundary: no game.i18n in unit-tested code). Unknown keys fall back to the English identity
// (categories) or "" (style), matching the pre-i18n behavior.
const SHOP_CAT_LABEL_KEYS = {
  Weapons: "CYBERPUNK.ShopCatWeapons", Armor: "CYBERPUNK.ShopCatArmor", Ammo: "CYBERPUNK.ShopCatAmmo",
  Cyberware: "CYBERPUNK.ShopCatCyberware", FBC: "CYBERPUNK.ShopCatFBC", Gear: "CYBERPUNK.ShopCatGear", Netrunning: "CYBERPUNK.ShopCatNetrunning",
  Programs: "CYBERPUNK.ShopCatPrograms", Vehicles: "CYBERPUNK.ShopCatVehicles",
};
const SHOP_SUB_LABEL_KEYS = {
  Pistols: "CYBERPUNK.ShopSubPistols", SMGs: "CYBERPUNK.ShopSubSMGs", Rifles: "CYBERPUNK.ShopSubRifles",
  Shotguns: "CYBERPUNK.ShopSubShotguns", Heavy: "CYBERPUNK.ShopSubHeavy", Melee: "CYBERPUNK.ShopSubMelee",
  Exotic: "CYBERPUNK.ShopSubExotic", Other: "CYBERPUNK.ShopSubOther",
  Cyberlimbs: "CYBERPUNK.ShopSubCyberlimbs", Cyberoptics: "CYBERPUNK.ShopSubCyberoptics",
  Cyberaudio: "CYBERPUNK.ShopSubCyberaudio", Neuralware: "CYBERPUNK.ShopSubNeuralware",
  Implants: "CYBERPUNK.ShopSubImplants", Bioware: "CYBERPUNK.ShopSubBioware",
  Fashionware: "CYBERPUNK.ShopSubFashionware", Cyberweapons: "CYBERPUNK.ShopSubCyberweapons",
  Chipware: "CYBERPUNK.ShopSubChipware",
  Communication: "CYBERPUNK.ShopSubCommunication", Electronics: "CYBERPUNK.ShopSubElectronics",
  Entertainment: "CYBERPUNK.ShopSubEntertainment", Fashion: "CYBERPUNK.ShopSubFashion",
  Furnishing: "CYBERPUNK.ShopSubFurnishing", Medical: "CYBERPUNK.ShopSubMedical",
  Security: "CYBERPUNK.ShopSubSecurity", Surveillance: "CYBERPUNK.ShopSubSurveillance",
  Tools: "CYBERPUNK.ShopSubTools", "Rentals & Services": "CYBERPUNK.ShopSubRentalsServices",
  Cars: "CYBERPUNK.ShopSubCars", Cycles: "CYBERPUNK.ShopSubCycles", Trucks: "CYBERPUNK.ShopSubTrucks",
  AVs: "CYBERPUNK.ShopSubAVs", Aircraft: "CYBERPUNK.ShopSubAircraft", Hover: "CYBERPUNK.ShopSubHover",
  Watercraft: "CYBERPUNK.ShopSubWatercraft", Spacecraft: "CYBERPUNK.ShopSubSpacecraft",
  Military: "CYBERPUNK.ShopSubMilitary", Drones: "CYBERPUNK.ShopSubDrones", ACPA: "CYBERPUNK.ShopSubACPA",
};
const SHOP_STYLE_LABEL_KEYS = {
  generic: "CYBERPUNK.ShopStyleGeneric", leisure: "CYBERPUNK.ShopStyleLeisure",
  urbanflash: "CYBERPUNK.ShopStyleUrbanFlash", business: "CYBERPUNK.ShopStyleBusiness",
  highfashion: "CYBERPUNK.ShopStyleHighFashion",
};
/** Localized top-category label (falls back to the English identity). */
const shopCatLabel = (key) => SHOP_CAT_LABEL_KEYS[key] ? game.i18n.localize(SHOP_CAT_LABEL_KEYS[key]) : key;
/** Localized sub-type label (falls back to the English identity). */
const shopSubLabel = (sub) => SHOP_SUB_LABEL_KEYS[sub] ? game.i18n.localize(SHOP_SUB_LABEL_KEYS[sub]) : sub;
/** Localized fashion-style label for a style key (unknown/empty → ""). */
const shopStyleLabel = (styleKey) => SHOP_STYLE_LABEL_KEYS[styleKey] ? game.i18n.localize(SHOP_STYLE_LABEL_KEYS[styleKey]) : "";
/** Fashion styles with localized labels for the render context: [{key,label,mult}]. */
const shopFashionStyleOptions = () => FASHION_STYLES.map(s => ({ key: s.key, label: shopStyleLabel(s.key), mult: s.mult }));

/**
 * The Shop window ([[shopping-design]] round-7). ONE standalone window (a singleton) that navigates
 * between four internal VIEWS — no native sidebar tab (V14-friendlier; see the design note):
 *   • "home"       — a directory: a pinned "Catalog" entry + every custom shop + (GM) "Create Custom Shop".
 *   • "catalog"    — the global master list (flat Core cost; GM source-curation; GM "Add to shop ▾").
 *   • "build"      — GM curation of a ShopDef: a vendor TRAY (curated stock + inline economics) docked
 *                    above the searchable catalog, with ＋Add / drag / "Add all shown", a config bar
 *                    (name / open / fullSearch / live discount / publish / delete).
 *   • "storefront" — the player view of a shop: curated items in the catalog row style (lighter chrome),
 *                    or the whole visible catalog when the shop's fullSearch is on (curated featured).
 *
 * Shops are WORLD DATA (module/shop/shops.js), not Actors. Player purchases charge the player and relay
 * the stock decrement to the GM over the socket.
 */

const SCOPE = "cp2020-augmented";

/** "Add all shown" asks for confirmation above this many NEW items (guards against dumping the whole catalog). */
const BULK_ADD_CONFIRM_OVER = 20;

/** Split a "packId.itemId" sourceKey (packId itself contains a dot). */
function splitSourceKey(sk) {
  const i = String(sk ?? "").lastIndexOf(".");
  return i < 0 ? [sk, ""] : [sk.slice(0, i), sk.slice(i + 1)];
}

// ── Catalog index (session cache) ───────────────────────────────────────────
let _catalogIndexPromise = null;

async function buildCatalogIndex() {
  // Read the GM price-override map ONCE for the whole index (avoids a settings read per row).
  const overrides = getShopPriceOverrides();
  const results = await Promise.all(catalogPacks().map(async (pack) => {
    const packName = pack.metadata.name;
    const mapped = isMappedPack(packName);          // legacy packs: one cat/sub for the whole pack
    const packCat = categoryOfPack(packName);
    let idx;
    try { idx = await pack.getIndex({ fields: ["system.cost", "system.source", "system.weaponType", "system.vehicleType", "system.cyberwareType", "flags.cp2020-augmented.borgBody", "type", "img"] }); }
    catch (e) { return []; }
    const items = [];
    for (const e of idx) {
      const type = e.type ?? "misc";
      if (EXCLUDED_TYPES.has(type)) continue;
      // Type-grouped supplement packs (and any other unmapped pack) categorize per-item from item data.
      // Vehicles ALWAYS categorize per-item: their class sub-filter reads system.vehicleType (the soft
      // enum), which a mapped pack's one-cat/sub-per-pack identity can't carry.
      const { category, sub } = (mapped && type !== "vehicle") ? packCat : categoryOfItem(type, e.system, e.flags);
      const { supplement, canon } = classifySupplement(e.system?.source);
      // Book-verified corrections to base-pack data (name/cost/priceRange) — data-corrections.js.
      const corr = correctionFor(pack.collection, e._id);
      // Price precedence (compendium → GM override → unpurchasable): an item the base leaves unpriced
      // is NOT free — it shows "GM-priced" and routes a buy through the GM price-request flow. For a
      // variable-price item (corr.priceRange) the GM override wins instead (the range is a suggestion).
      const pr = resolveCatalogPrice(correctedCost(pack.collection, e._id, e.system?.cost), e._id, overrides, { preferOverride: !!corr?.priceRange });
      items.push({
        id: e._id, packId: pack.collection, name: corr?.name ?? e.name, img: e.img,
        cost: pr.price ?? 0, unpriced: !pr.purchasable, priceRange: corr?.priceRange ?? null,
        type, category, sub, supplement, supplementShort: shortSupplement(supplement), canon,
        key: `${pack.collection}.${e._id}`
      });
    }
    return items;
  }));
  const all = results.flat();
  all.sort((a, b) => a.name.localeCompare(b.name));
  return all;
}

export function getCatalogIndex() {
  if (!_catalogIndexPromise) _catalogIndexPromise = buildCatalogIndex().catch(e => { _catalogIndexPromise = null; throw e; });
  return _catalogIndexPromise;
}
export function clearCatalogIndexCache() { _catalogIndexPromise = null; }

/** key → index row, for resolving a shop's sourceKeys to catalog entries. */
function indexByKey(all) { const m = new Map(); for (const it of all) m.set(it.key, it); return m; }

export class CatalogBrowser extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {Actor|null} buyer
   * @param {{view?:string, shopId?:string}} [options]
   */
  constructor(buyer, options = {}) {
    super(options);
    this.buyer = buyer ?? null;
    this.view = options.view ?? "home";   // home | catalog | build | storefront
    this.shopId = options.shopId ?? null;
    this._search = "";
    this._cats = new Set();
    this._books = new Set();
  }

  static DEFAULT_OPTIONS = {
    classes: ["cyberpunk", "cp-catalog"],
    position: { width: 880, height: 720 },
    window: { title: "CYBERPUNK.ShopTitle", resizable: true },
  };

  static PARTS = {
    // Single part = the existing one-template, conditional-by-view shop UI. `scrollable` preserves the
    // scroll position of EACH listed container across the `this.render()` a filter/search click triggers
    // (replaces the old V1 _render scroll-capture override). All three panels carry their own
    // `overflow-y:auto` (css §.cp-catalog-list/.cp-catalog-filters/.cp-src-scroll), so each needs listing —
    // otherwise clicking a category/book chip while the filter compartment is scrolled snaps it back to top.
    main: { template: "modules/cp2020-augmented/templates/shop/catalog.hbs", scrollable: [".cp-catalog-list", ".cp-catalog-filters", ".cp-src-scroll"] },
  };

  get title() {
    if (this.view === "build")      return game.i18n.format("CYBERPUNK.ShopBuilderTitle", { name: this._shop()?.name ?? "" });
    if (this.view === "storefront") return this._shop()?.name ?? game.i18n.localize("CYBERPUNK.ShopTitle");
    if (this.view === "catalog")    return game.i18n.localize("CYBERPUNK.CatalogTitle");
    return game.i18n.localize("CYBERPUNK.ShopTitle");
  }

  _shop() { return this.shopId ? getShop(this.shopId) : null; }

  /** Characters the current user can shop AS (players: their owned chars; GM: assigned + current buyer).
   *  Lets a player with several characters pick who's buying instead of fishing for the right token. */
  _buyerOptions() {
    let cands;
    if (game.user.isGM) cands = [game.user.character, this.buyer].filter(Boolean);
    else cands = (game.actors?.contents ?? []).filter(a => a?.isOwner);
    const seen = new Set();
    return cands
      .filter(a => a?.type === "character" && !seen.has(a.id) && seen.add(a.id))
      .map(a => ({ id: a.id, name: a.name, selected: a.id === this.buyer?.id }))
      .sort((x, y) => x.name.localeCompare(y.name));
  }

  /** Switch view (+ optional shop) and re-render. */
  navigate(view, shopId = null, render = true) {
    this.view = view;
    this.shopId = shopId;
    this._search = "";
    this._cats = new Set();
    this._books = new Set();
    // Plain render (NOT force): in-window navigation (Catalog, a custom shop, Back, …) just swaps the
    // view — it must not "reopen" the window, which would trip the global shimmer-on-reopen wrap. The
    // genuine external reopen (openShopWindow) keeps its own explicit shimmer.
    if (render) this.render();
  }

  // ── Shared row helpers ─────────────────────────────────────────────────────
  _filterRows(all, { isGM, cfg, search }) {
    // Both filter dimensions are additive (OR within, AND across): no chips in a dimension = that dimension
    // matches everything; selecting chips narrows to the UNION of those chips. The "Core" book chip uses the
    // synthetic key "__core__" and matches by canon (covers both the tagged core book and untagged core gear).
    const catsActive = this._cats.size > 0;
    const booksActive = this._books.size > 0;
    const matchesCat = (it) => !catsActive || this._cats.has(it.category) || this._cats.has(`${it.category}/${it.sub}`);
    const matchesBook = (it) => !booksActive || (it.canon === "core" && this._books.has("__core__")) || this._books.has(it.supplement);
    const rows = [];
    for (const it of all) {
      if (!isVisibleTo(it.supplement, it.canon, cfg, isGM)) continue;
      if (!matchesCat(it)) continue;
      if (!matchesBook(it)) continue;
      if (search && !it.name.toLowerCase().includes(search)) continue;
      rows.push({ ...it, fashion: it.category === "Gear" && it.sub === "Fashion" });
    }
    return rows;
  }
  _assignLetters(arr, collect, letters) {
    const seen = new Set();
    for (const r of arr) {
      const L = (r.name[0] || "#").toUpperCase();
      r._letter = /[A-Z]/.test(L) ? L : "#";
      if (!seen.has(r._letter)) { seen.add(r._letter); r._first = true; if (collect) letters.push(r._letter); }
    }
  }
  _greedySort(rows, search) {
    const band = (n) => { const s = n.toLowerCase(); return s === search ? 0 : s.startsWith(search) ? 1 : 2; };
    rows.sort((a, b) => band(a.name) - band(b.name) || a.name.localeCompare(b.name));
  }
  _catTree() {
    return CATEGORIES.map(c => ({
      key: c.key, label: shopCatLabel(c.key), active: this._cats.has(c.key),
      subs: c.subs.map(s => ({ key: `${c.key}/${s}`, label: shopSubLabel(s), active: this._cats.has(`${c.key}/${s}`) }))
    }));
  }
  /** The "Books" filter panel: one chip per source book that has items (Core pinned at the top, then
   *  official, then homebrew). Each chip is a display filter; on the GM's catalog/build view each official
   *  /homebrew chip also carries an eye toggle for player visibility (the old per-source curation). */
  _booksPanel(all, { isGM, cfg, canCurate }) {
    const present = new Set(all.map(i => i.supplement + " " + i.canon));
    const enabled = cfg.enabledSources ?? {};
    const seen = (name, canon) => present.has(name + " " + canon) && (isGM || isVisibleTo(name, canon, cfg, false));
    const mk = (names, canon) => names.filter(n => seen(n, canon)).map(n => ({
      key: n, name: n, short: shortSupplement(n),
      active: this._books.has(n), curate: canCurate, enabled: enabled[n] === true
    }));
    const coreLabel = game.i18n.localize("CYBERPUNK.CatalogCore");
    const core = all.some(i => i.canon === "core")
      ? [{ key: "__core__", name: coreLabel, short: coreLabel, active: this._books.has("__core__"), curate: false }]
      : [];
    const official = mk(knownOfficialSupplements(), "official");
    const homebrew = shopAllowHomebrew() ? mk(knownNoncanonSources(), "noncanon") : [];
    const total = core.length + official.length + homebrew.length;
    // canCurate gates the eye-toggles AND the one-line hint that explains them (GM catalog/build only).
    // Show the panel for the GM whenever any book exists; for players only when there's >1 to pick between.
    return { core, official, homebrew, allowHomebrew: shopAllowHomebrew(), canCurate, show: total > 0 && (isGM || total > 1) };
  }
  /** Resolve a shop's stock to display rows (joined to the catalog index). */
  _vendorRows(def, idxMap) {
    return Object.keys(def.items).map(sk => {
      const idx = idxMap.get(sk);
      const e = normalizeShopItem(def.items[sk]);
      const [packId, itemId] = splitSourceKey(sk);
      const catalogCost = idx ? idx.cost : 0;
      // Style pricing applies to clothing only (Gear/Fashion). The GM sets the tier per item; the
      // multiplier feeds the effective price. Non-clothing carries no style.
      const isClothing = idx?.category === "Gear" && idx?.sub === "Fashion";
      const styleMult = isClothing ? styleMultOf(e.style) : 1;
      return {
        sourceKey: sk, packId, itemId, available: !!idx,
        name: idx?.name ?? game.i18n.localize("CYBERPUNK.ShopItemUnavailable"),
        img: idx?.img ?? "icons/svg/item-bag.svg",
        category: idx?.category ?? "", sub: idx?.sub ?? "", supplement: idx?.supplement ?? "",
        catalogCost, override: e.price, unlimited: e.unlimited, qty: e.qty,
        isClothing, style: e.style,
        styleLabel: (isClothing && e.style && e.style !== "generic") ? shopStyleLabel(e.style) : "",
        styleOptions: isClothing ? FASHION_STYLES.map(s => ({ key: s.key, label: shopStyleLabel(s.key), mult: s.mult, selected: s.key === (e.style ?? "generic") })) : null,
        eff: effectivePrice(def, sk, catalogCost, styleMult), soldOut: !e.unlimited && e.qty <= 0
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Generated catalog rows for ammunition — one per caliber (incl. GM-custom calibers). Price shown is
   *  the STANDARD box price; the per-row load dropdown re-prices live and the Buy charges box × boxes. */
  _ammoCatalogRows() {
    const img = "modules/cp2020-augmented/img/weapon-icon.svg";
    return Object.entries(getCalibers()).map(([id, c]) => ({
      ammo: true, caliber: id,
      name: (c && c.label) ? c.label : id,
      img, cost: getAmmoBoxPrice(id, "standard"), boxSize: Number(getCaliberBox(id).box) || 1,
      // Load dropdown scoped to THIS caliber's family (arrow loads never appear on a bullet and vice
      // versa) — the same helper the item sheet uses. Standard is first (universal), matching `cost`.
      loads: modifiersForCaliber(id).map(([mid, m]) => ({ id: mid, label: (m && m.label) ? m.label : mid })),
      type: "ammo", category: "Ammo", sub: "",
      supplement: "Untagged", supplementShort: "", canon: "core",
      key: ""   // not a compendium doc → no source key (keeps it out of drag-to-buy / shop curation)
    }));
  }

  // ── context (V2 _prepareContext; was getData) ───────────────────────────────
  async _prepareContext(options) {
    const isGM = game.user.isGM;
    const common = {
      isGM, view: this.view,
      isHome: this.view === "home", isCatalog: this.view === "catalog",
      isBuild: this.view === "build", isStorefront: this.view === "storefront",
      hasBuyer: !!this.buyer,
      buyerName: this.buyer?.name ?? "",
      buyerFunds: this.buyer ? (Number(this.buyer.system?.eurobucks) || 0) : 0,
      buyerOptions: this._buyerOptions(),
      fashionStyles: shopFashionStyleOptions(), showSource: shopShowSource(), search: this._search,
      searching: !!this._search.trim()
    };
    if (this.view === "home") return { ...common, ...this._dataHome(isGM) };

    const all = await getCatalogIndex();
    const cfg = shopSourceConfig();
    // The TEXT search is applied CLIENT-SIDE (_applySearch) — the server renders the full
    // category/book-filtered set once, and typing just shows/hides rows with NO re-render. This keeps the
    // search box responsive (a full re-render per keystroke lags badly + drops input when popped out).
    const search = "";
    if (this.view === "catalog") {
      // Ammo isn't a compendium pack (caliber × load matrix, box pricing) — fold it into the master
      // catalog as generated rows. Only the catalog view shows ammo; custom shops curate compendium docs.
      const merged = [...all, ...this._ammoCatalogRows()].sort((a, b) => a.name.localeCompare(b.name));
      return { ...common, ...this._dataCatalog(merged, { isGM, cfg, search }) };
    }
    if (this.view === "build")      return { ...common, ...this._dataBuild(all, { isGM, cfg, search }) };
    return { ...common, ...this._dataStorefront(all, { isGM, cfg, search }) };
  }

  _dataHome(isGM) {
    const shops = shopsVisibleTo().map(s => ({ id: s.id, name: s.name, open: s.open, fullSearch: s.fullSearch, count: Object.keys(s.items).length }));
    return { shops, canCreate: isGM, hasShops: shops.length > 0 };
  }

  _dataCatalog(all, { isGM, cfg, search }) {
    const rows = this._filterRows(all, { isGM, cfg, search });
    const letters = [];
    if (search) this._greedySort(rows, search);
    else this._assignLetters(rows, true, letters);
    return {
      showFilters: true, showJump: true, showSearch: true,
      rows, rowCount: rows.length, letters, cats: this._catTree(),
      booksPanel: this._booksPanel(all, { isGM, cfg, canCurate: isGM })
    };
  }

  _dataBuild(all, { isGM, cfg, search }) {
    const def = this._shop();
    if (!def) return { missing: true, showSearch: false };
    const idxMap = indexByKey(all);
    const vendor = this._vendorRows(def, idxMap);
    const rows = this._filterRows(all, { isGM, cfg, search }).map(it => ({ ...it, inShop: !!def.items[it.key] }));
    const letters = [];
    if (search) this._greedySort(rows, search);
    else this._assignLetters(rows, true, letters);
    return {
      showFilters: true, showJump: true, showSearch: true,
      shop: { id: def.id, name: def.name, open: def.open, fullSearch: def.fullSearch, discountPct: def.discountPct, notes: def.notes },
      vendor, vendorCount: vendor.length,
      rows, rowCount: rows.length, letters, cats: this._catTree(),
      booksPanel: this._booksPanel(all, { isGM, cfg, canCurate: isGM })
    };
  }

  _dataStorefront(all, { isGM, cfg, search }) {
    const def = this._shop();
    if (!def) return { missing: true, showSearch: false };
    if (def.open === false && !isGM) return { closed: true, showSearch: false, shop: { id: def.id, name: def.name } };
    const idxMap = indexByKey(all);
    const fullSearch = def.fullSearch === true;
    let curated = this._vendorRows(def, idxMap)
      .filter(r => fullSearch || !search || r.name.toLowerCase().includes(search))
      .map(r => ({ ...r, curated: true }));

    if (!fullSearch) {
      this._assignLetters(curated, false, []);
      return {
        showSearch: true, showFilters: false, showJump: false,
        shop: { id: def.id, name: def.name, open: def.open, discountPct: def.discountPct },
        rows: curated, rowCount: curated.length, letters: [], manageBack: isGM, fullSearch: false
      };
    }
    // fullSearch: whole visible catalog + curated featured.
    const featuredKeys = new Set(curated.map(r => r.sourceKey));
    const featured = curated.map(r => ({ ...r, featured: true }));
    const rest = this._filterRows(all, { isGM, cfg, search }).filter(it => !featuredKeys.has(it.key));
    const letters = [];
    if (search) { this._greedySort(featured, search); this._greedySort(rest, search); }
    else { featured.sort((a, b) => a.name.localeCompare(b.name)); rest.sort((a, b) => a.name.localeCompare(b.name)); this._assignLetters(rest, true, letters); }
    if (featured.length) featured[0]._featuredDivider = true;
    if (rest.length && featured.length) rest[0]._restDivider = true;
    return {
      showSearch: true, showFilters: true, showJump: true,
      shop: { id: def.id, name: def.name, open: def.open, discountPct: def.discountPct },
      rows: [...featured, ...rest], rowCount: featured.length + rest.length, letters, cats: this._catTree(),
      booksPanel: this._booksPanel(all, { isGM, cfg, canCurate: false }),
      manageBack: isGM, fullSearch: true
    };
  }

  // ── Purchase routing (the buy logic lives in module-level fns so the actor-sheet drop-to-buy can reuse it) ──
  async _directBuy(packId, itemId, opts) {
    if (!this.buyer) { ui.notifications?.warn(game.i18n.localize("CYBERPUNK.ShopBuyerNeeded")); return; }
    return purchaseCatalogItem(this.buyer, packId, itemId, opts);
  }

  /** Buy a curated item from a shop: shop pricing (GM-set clothing style + discount), deplete stock. */
  async _shopBuy(sourceKey, opts) {
    if (!this.buyer) { ui.notifications?.warn(game.i18n.localize("CYBERPUNK.ShopBuyerNeeded")); return; }
    return purchaseShopItem(this.buyer, this.shopId, sourceKey, opts);
  }

  /** Buy ammunition by caliber + load (box pricing). Routes through the shared purchaseAmmo engine. */
  async _buyAmmo(caliber, modifier, boxes) {
    if (!this.buyer) { ui.notifications?.warn(game.i18n.localize("CYBERPUNK.ShopBuyerNeeded")); return; }
    return purchaseAmmo(this.buyer, { caliber, modifier, boxes });
  }

  /** Live re-price ammo rows when the load dropdown changes (box price varies a lot by load). Boxes
   *  multiply at purchase — the displayed price stays PER BOX, matching every other catalog row. */
  _activateAmmoRows(root) {
    if (this.view !== "catalog") return;
    root.querySelectorAll(".cp-catalog-row[data-ammo-caliber]").forEach(row => {
      const sel = row.querySelector(".cp-catalog-ammo-load");
      sel?.addEventListener("change", () => {
        const pe = row.querySelector(".cp-cat-price b");
        if (pe) pe.textContent = getAmmoBoxPrice(row.dataset.ammoCaliber, sel.value);
      });
    });
  }

  async _openItemSheet(rowEl) {
    if (rowEl.dataset.ammoCaliber) return;   // generated ammo rows have no compendium sheet to open
    let { packId, itemId } = rowEl.dataset;
    if ((!packId || !itemId) && rowEl.dataset.sourceKey) [packId, itemId] = splitSourceKey(rowEl.dataset.sourceKey);
    if (!packId || !itemId) return;
    try { (await game.packs.get(packId)?.getDocument(itemId))?.sheet?.render({ force: true }); } catch { /* gone */ }
  }

  /** V2: re-invoke the preserved jQuery `activateListeners` on each render (V2 has no auto-listener
   *  wiring), and keep the window header title in sync with the dynamic, view-based `get title()`. */
  _onRender(context, options) {
    super._onRender?.(context, options);
    const titleEl = this.element?.querySelector?.(".window-title");
    if (titleEl) titleEl.textContent = this.title;
    if (this.element) this.activateListeners(this.element);
  }

  // ── Listeners ────────────────────────────────────────────────────────────────
  activateListeners(html) {
    const root = html instanceof jQuery ? html[0] : html;
    if (!root) return;
    const isGM = game.user.isGM;

    // Navigation.
    root.querySelector(".cp-shop-back")?.addEventListener("click", (e) => { e.preventDefault(); this.navigate("home"); });
    root.querySelector(".cp-home-catalog")?.addEventListener("click", (e) => { e.preventDefault(); this.navigate("catalog"); });
    // Storefront "Manage" → builder. Bound here (not in _activateBuildControls, which only runs in the build
    // view) because the button lives in the STOREFRONT header for the GM.
    root.querySelector(".cp-shop-manage")?.addEventListener("click", (e) => { e.preventDefault(); if (this.shopId) this.navigate("build", this.shopId); });
    root.querySelectorAll(".cp-home-shop").forEach(el => el.addEventListener("click", (e) => {
      e.preventDefault();
      const id = el.dataset.shopId;
      this.navigate(isGM ? "build" : "storefront", id);
    }));
    root.querySelector(".cp-home-create")?.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!isGM) return;
      const name = await promptText(game.i18n.localize("CYBERPUNK.ShopNewTitle"), game.i18n.localize("CYBERPUNK.ShopNewDefault"));
      if (name === null) return;
      const def = await createShop({ name });
      if (def) this.navigate("build", def.id);
    });
    // Home directory context menu (Open/Edit/Publish/Duplicate/Rename/Delete).
    root.querySelectorAll(".cp-home-shop").forEach(el => el.addEventListener("contextmenu", (e) => { e.preventDefault(); if (isGM) this._shopContextMenu(el.dataset.shopId, e); }));

    // Buyer picker (shop AS a chosen owned character).
    root.querySelector(".cp-buyer-pick")?.addEventListener("change", (ev) => {
      const id = ev.currentTarget.value;
      this.buyer = id ? (game.actors?.get(id) ?? null) : null;
      this.render();
    });

    // Search + source toggle. Search filters in place (no re-render) so the box stays responsive even when
    // popped out into a second window; see _applySearch.
    root.querySelector(".cp-catalog-search")?.addEventListener("input", (ev) => { this._search = ev.currentTarget.value; this._applySearch(root); });
    root.querySelector(".cp-catalog-showsource")?.addEventListener("change", async (ev) => { try { await game.settings.set(SCOPE, "shopShowSource", ev.currentTarget.checked); } catch {} this.render(); });

    // Category filters + clear + jump.
    root.querySelectorAll(".cp-cat-chip").forEach(el => el.addEventListener("click", (ev) => { ev.preventDefault(); const k = ev.currentTarget.dataset.cat; this._cats.has(k) ? this._cats.delete(k) : this._cats.add(k); this.render(); }));
    root.querySelector(".cp-cat-clear")?.addEventListener("click", (ev) => { ev.preventDefault(); this._cats.clear(); this.render(); });
    root.querySelectorAll(".cp-jump").forEach(el => el.addEventListener("click", (ev) => { ev.preventDefault(); root.querySelector(`.cp-catalog-row[data-letter="${ev.currentTarget.dataset.letter}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }); }));

    // Book (supplement) filters + clear — same additive behavior as categories.
    root.querySelectorAll(".cp-book-chip").forEach(el => el.addEventListener("click", (ev) => { ev.preventDefault(); const k = ev.currentTarget.dataset.book; this._books.has(k) ? this._books.delete(k) : this._books.add(k); this.render(); }));
    root.querySelector(".cp-book-clear")?.addEventListener("click", (ev) => { ev.preventDefault(); this._books.clear(); this.render(); });

    // GM per-book player-visibility (eye) toggles.
    root.querySelectorAll(".cp-src-toggle").forEach(el => el.addEventListener("change", async (ev) => {
      const name = ev.currentTarget.dataset.source;
      const map = { ...(() => { try { return game.settings.get(SCOPE, "shopEnabledSources") || {}; } catch { return {}; } })() };
      if (ev.currentTarget.checked) map[name] = true; else delete map[name];
      try { await game.settings.set(SCOPE, "shopEnabledSources", map); } catch (e) { console.warn(e); }
      this.render();
    }));

    // Click name/thumb → compendium sheet.
    root.querySelectorAll(".cp-cat-itemname, .cp-cat-thumb").forEach(el => el.addEventListener("click", async (ev) => {
      const rowEl = ev.currentTarget.closest("[data-item-id], [data-source-key]"); if (!rowEl) return;
      ev.preventDefault(); ev.stopPropagation(); await this._openItemSheet(rowEl);
    }));

    const styleOf = (rowEl) => { const s = rowEl.querySelector(".cp-catalog-style"); if (s?.value) { const m = FASHION_STYLES.find(x => x.key === s.value); if (m) return { styleMult: m.mult, styleLabel: shopStyleLabel(m.key) }; } return { styleMult: 1, styleLabel: "" }; };
    const qtyOf = (rowEl) => Math.max(1, parseInt(rowEl.querySelector(".cp-catalog-qty")?.value, 10) || 1);

    // Buy (catalog + storefront).
    root.querySelectorAll(".cp-catalog-buy").forEach(btn => btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      // Disable the clicked button for the whole async buy so a double-click can't fire two purchases
      // (buyItem's per-actor claim is the authoritative backstop; the re-render below also rebuilds a
      // fresh, enabled button). Re-enable in finally in case the flow bails before re-rendering.
      const button = ev.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      try {
        const rowEl = button.closest("[data-ammo-caliber], [data-item-id], [data-source-key]"); if (!rowEl) return;
        const qty = qtyOf(rowEl);
        // Ammo rows: box pricing via the selected load. qty = number of boxes.
        if (rowEl.dataset.ammoCaliber) { await this._buyAmmo(rowEl.dataset.ammoCaliber, rowEl.querySelector(".cp-catalog-ammo-load")?.value ?? "standard", qty); this.render(); return; }
        // Storefront items use the GM-set style (handled in _shopBuy); the open catalog lets the buyer pick.
        if (this.view === "storefront" && rowEl.dataset.curated === "1") await this._shopBuy(rowEl.dataset.sourceKey, { qty });
        else { const { styleMult, styleLabel } = styleOf(rowEl); await this._directBuy(rowEl.dataset.packId, rowEl.dataset.itemId, { qty, styleMult, styleLabel }); }
        this.render();
      } finally {
        button.disabled = false;
      }
    }));

    this._activateBuildControls(root, isGM);
    this._activateCatalogShopAdd(root, isGM);
    this._activatePurchaseDrag(root);
    this._activateAmmoRows(root);

    // A render rebuilt the rows — re-apply any active text search so it composes with filter changes.
    this._applySearch(root);
  }

  /** Catalog + storefront rows are draggable onto a character sheet to BUY (purchaseByDrop). Curated
   *  storefront rows carry the shopId (shop pricing/stock); everything else buys at flat catalog cost. */
  _activatePurchaseDrag(root) {
    if (this.view !== "catalog" && this.view !== "storefront") return;
    root.querySelectorAll(".cp-catalog-list .cp-catalog-row[data-source-key]").forEach(row => {
      const sk = row.dataset.sourceKey;
      if (!sk) return;
      const shopId = (this.view === "storefront" && row.dataset.curated === "1") ? this.shopId : null;
      row.setAttribute("draggable", "true");
      row.classList.add("cp-buy-draggable");
      row.addEventListener("dragstart", (ev) => {
        ev.stopPropagation();
        try {
          ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "cp2020-augmentedPurchase", sourceKey: sk, shopId }));
          ev.dataTransfer.effectAllowed = "copy";
        } catch { /* dnd unsupported */ }
      });
    });
  }

  /** Client-side text search: show/hide already-rendered rows by name with NO re-render (typing stays
   *  instant — a per-keystroke re-render lags + drops input badly when the window is popped out). The
   *  `cp-searching` class hides the A–Z jump bar and letter headers (they're meaningless while filtering). */
  _applySearch(root) {
    const term = (this._search || "").trim().toLowerCase();
    root.querySelector(".cp-catalog-center")?.classList.toggle("cp-searching", !!term);
    const list = root.querySelector(".cp-catalog-list");
    if (!list) return;
    let anyVisible = false;
    for (const row of list.querySelectorAll(".cp-catalog-row")) {
      const name = (row.dataset.name || row.querySelector(".cp-cat-itemname")?.textContent || "").toLowerCase();
      const show = !term || name.includes(term);
      row.style.display = show ? "" : "none";
      // Best-match-first among the visible rows (exact → prefix → substring) via flex `order`, so the
      // natural alphabetical DOM order is restored untouched the moment the search clears. Equal-band rows
      // keep source (alphabetical) order — flexbox is stable for matching `order` values.
      row.style.order = !term ? "" : (name === term ? "0" : name.startsWith(term) ? "1" : "2");
      if (show) anyVisible = true;
    }
    const nomatch = list.querySelector(".cp-catalog-nomatch");
    if (nomatch) nomatch.style.display = (term && !anyVisible) ? "" : "none";
  }

  /** Catalog-view GM "Add to shop": a compact cart icon per row that opens a shop-picker menu
   *  (replaces a per-row <select>, which stamped a wide dropdown on every row and overflowed). */
  _activateCatalogShopAdd(root, isGM) {
    if (this.view !== "catalog" || !isGM) return;
    root.querySelectorAll(".cp-add-to-shop-btn").forEach(btn => btn.addEventListener("click", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const rowEl = ev.currentTarget.closest("[data-source-key]"); if (rowEl) this._catalogAddMenu(rowEl, ev);
    }));
  }

  /**
   * Open a small cursor-positioned popup menu. `items` = [{action, label, handler}]. The structure
   * comes from templates/shop/context-menu.hbs (templates own the HTML); only the cursor x/y is set
   * inline (genuinely dynamic — the box itself lives in the .cp-context-menu CSS class). Mounts in the
   * event's OWN document (PopOut!-safe) and closes on an outside click. Each button's handler is wired
   * by its data-action after render.
   */
  async _openContextMenu(ev, items) {
    const doc = ev.currentTarget?.ownerDocument || ev.target?.ownerDocument || document;
    const render = foundry?.applications?.handlebars?.renderTemplate ?? renderTemplate;
    const html = await render("modules/cp2020-augmented/templates/shop/context-menu.hbs",
      { items: items.map(i => ({ action: i.action, label: i.label })) });
    const tmp = doc.createElement("div");
    tmp.innerHTML = html;
    const menu = tmp.firstElementChild;
    menu.style.left = `${ev.clientX}px`;
    menu.style.top = `${ev.clientY}px`;
    const handlers = new Map(items.map(i => [i.action, i.handler]));
    for (const btn of menu.querySelectorAll("button[data-action]")) {
      btn.addEventListener("click", async () => { menu.remove(); await handlers.get(btn.dataset.action)?.(); });
    }
    doc.body.appendChild(menu);
    const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); doc.removeEventListener("click", close); } };
    setTimeout(() => doc.addEventListener("click", close), 0);
  }

  /** Localized Yes/No confirm whose body comes from the generic confirm-body template (no inline HTML). */
  async _confirm(title, body) {
    return foundry.applications.api.DialogV2.confirm({
      window: { title }, rejectClose: false,
      content: await renderChatCard("confirm-body.hbs", { body }),
    });
  }

  /** Popup menu listing every shop (+ create new) to add a catalog item to. */
  _catalogAddMenu(rowEl, ev) {
    const sk = rowEl.dataset.sourceKey; if (!sk) return;
    const addTo = async (shopId) => {
      if (!shopId) return;
      const added = await addShopItem(shopId, sk);
      ui.notifications?.info(added ? game.i18n.format("CYBERPUNK.ShopAddedTo", { shop: getShop(shopId)?.name ?? "" }) : game.i18n.localize("CYBERPUNK.ShopAlreadyStocked"));
    };
    const items = listShops().map(s => ({ action: `shop:${s.id}`, label: s.name, handler: () => addTo(s.id) }));
    items.push({
      action: "new", label: "＋ " + game.i18n.localize("CYBERPUNK.ShopNew"),
      handler: async () => {
        const name = await promptText(game.i18n.localize("CYBERPUNK.ShopNewTitle"), game.i18n.localize("CYBERPUNK.ShopNewDefault"));
        if (name === null) return;
        const def = await createShop({ name });
        if (def) await addTo(def.id);
      },
    });
    this._openContextMenu(ev, items);
  }

  /** Build-view curation: ＋add / drag-in / bulk add / remove / economics / config. */
  _activateBuildControls(root, isGM) {
    if (this.view !== "build" || !isGM || !this.shopId) return;
    const id = this.shopId;
    const skOf = (el) => el?.closest?.("[data-source-key]")?.dataset?.sourceKey;

    root.querySelectorAll(".cp-shop-add").forEach(btn => btn.addEventListener("click", async (ev) => { ev.preventDefault(); const rowEl = ev.currentTarget.closest("[data-source-key]"); if (rowEl) { await addShopItem(id, rowEl.dataset.sourceKey); this.render(); } }));
    root.querySelectorAll(".cp-shop-remove").forEach(btn => btn.addEventListener("click", async (ev) => { ev.preventDefault(); const sk = skOf(ev.currentTarget); if (sk) { await removeShopItem(id, sk); this.render(); } }));
    root.querySelector(".cp-bulk-add")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const def = getShop(id);
      // Only the items NOT already stocked will be added — confirm before a large bulk add (e.g. the
      // whole catalog when no search/filter is applied) so you can't accidentally dump 900+ items.
      // Skip rows the live text search has hidden (display:none) so "Add all shown" means exactly that.
      const newKeys = [...root.querySelectorAll(".cp-catalog-list .cp-catalog-row[data-source-key]")]
        .filter(r => r.style.display !== "none")
        .map(r => r.dataset.sourceKey).filter(sk => sk && !def?.items?.[sk]);
      if (!newKeys.length) { ui.notifications?.info(game.i18n.localize("CYBERPUNK.ShopBulkNone")); return; }
      if (newKeys.length > BULK_ADD_CONFIRM_OVER &&
          !(await this._confirm(def?.name ?? "", game.i18n.format("CYBERPUNK.ShopBulkAddConfirm", { n: newKeys.length })))) return;
      const n = await addShopItems(id, newKeys.map(sk => ({ sourceKey: sk })));
      ui.notifications?.info(game.i18n.format("CYBERPUNK.ShopBulkAdded", { n }));
      this.render();
    });
    root.querySelector(".cp-vendor-clear")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const def = getShop(id);
      const count = Object.keys(def?.items ?? {}).length;
      if (!count) return;
      if (await this._confirm(def?.name ?? "", game.i18n.format("CYBERPUNK.ShopClearVendorConfirm", { n: count }))) {
        await clearShopItems(id);
        this.render();
      }
    });

    // Inline economics (vendor tray).
    root.querySelectorAll(".cp-shop-price").forEach(el => el.addEventListener("change", async (ev) => { const sk = skOf(ev.currentTarget); if (!sk) return; const raw = ev.currentTarget.value.trim(); await setShopItem(id, sk, { price: raw === "" ? null : Math.max(0, Math.round(Number(raw) || 0)) }); this.render(); }));
    // Stock: the qty field is always editable — typing a number makes the item limited (no need to flip
    // ∞ off first). An empty field is a no-op (use the ∞ button for unlimited).
    root.querySelectorAll(".cp-shop-stock-qty").forEach(el => el.addEventListener("change", async (ev) => {
      const sk = skOf(ev.currentTarget); if (!sk) return;
      const raw = ev.currentTarget.value.trim();
      if (raw === "") { this.render(); return; }
      await setShopItem(id, sk, { qty: Math.max(0, parseInt(raw, 10) || 0), unlimited: false });
      this.render();
    }));
    // ∞ button toggles unlimited; flipping OFF defaults qty to 1 if it was 0 (so it isn't instantly sold out).
    root.querySelectorAll(".cp-shop-inf").forEach(el => el.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const sk = skOf(ev.currentTarget); if (!sk) return;
      const e = normalizeShopItem(getShop(id)?.items?.[sk]);
      await setShopItem(id, sk, e.unlimited ? { unlimited: false, qty: e.qty > 0 ? e.qty : 1 } : { unlimited: true });
      this.render();
    }));
    // "Set all" (vendor header): apply one stock value to every item at once.
    root.querySelector(".cp-stockall-apply")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const n = Math.max(0, parseInt(root.querySelector(".cp-stockall-qty")?.value, 10) || 0);
      await setAllShopStock(id, { unlimited: false, qty: n });
      this.render();
    });
    root.querySelector(".cp-stockall-inf")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await setAllShopStock(id, { unlimited: true });
      this.render();
    });
    // Clothing style tier (sets the style multiplier on the price). "" → null (Generic ×1).
    root.querySelectorAll(".cp-shop-style").forEach(el => el.addEventListener("change", async (ev) => { const sk = skOf(ev.currentTarget); if (sk) { await setShopItem(id, sk, { style: ev.currentTarget.value || null }); this.render(); } }));

    // Config bar.
    root.querySelector(".cp-shop-name")?.addEventListener("change", async (ev) => { const name = ev.currentTarget.value.trim(); if (name) { await updateShop(id, { name }); this.render(); } });
    root.querySelector(".cp-shop-open")?.addEventListener("change", async (ev) => { await updateShop(id, { open: ev.currentTarget.checked }); this.render(); });
    root.querySelector(".cp-shop-fullsearch")?.addEventListener("change", async (ev) => { await updateShop(id, { fullSearch: ev.currentTarget.checked }); });
    root.querySelector(".cp-shop-discount")?.addEventListener("change", async (ev) => { await updateShop(id, { discountPct: Math.min(100, Math.max(0, parseInt(ev.currentTarget.value, 10) || 0)) }); this.render(); });
    root.querySelector(".cp-shop-notes")?.addEventListener("change", async (ev) => { await updateShop(id, { notes: ev.currentTarget.value }); });
    root.querySelector(".cp-shop-publish")?.addEventListener("click", async (ev) => { ev.preventDefault(); await publishShop(id); this.render(); });
    root.querySelector(".cp-shop-preview")?.addEventListener("click", (ev) => { ev.preventDefault(); this.navigate("storefront", id); });
    root.querySelector(".cp-shop-delete")?.addEventListener("click", async (ev) => { ev.preventDefault(); if (await this._confirm(getShop(id)?.name ?? "", game.i18n.localize("CYBERPUNK.ShopDeleteConfirm"))) { await deleteShop(id); this.navigate("home"); } });
    // NOTE: the storefront "Manage" button is bound in activateListeners (this method early-returns outside build view).

    // Drag a catalog row into the vendor tray (in addition to ＋Add).
    root.querySelectorAll(".cp-catalog-list .cp-catalog-row[data-source-key]").forEach(row => {
      row.setAttribute("draggable", "true");
      row.addEventListener("dragstart", (ev) => { ev.dataTransfer?.setData("text/cp-sourcekey", row.dataset.sourceKey); });
    });
    const tray = root.querySelector(".cp-vendor-tray");
    if (tray) {
      tray.addEventListener("dragover", (ev) => { ev.preventDefault(); tray.classList.add("cp-drop-hot"); });
      tray.addEventListener("dragleave", () => tray.classList.remove("cp-drop-hot"));
      tray.addEventListener("drop", async (ev) => { ev.preventDefault(); tray.classList.remove("cp-drop-hot"); const sk = ev.dataTransfer?.getData("text/cp-sourcekey"); if (sk) { await addShopItem(id, sk); this.render(); } });
    }
  }

  /** Right-click directory context menu for a shop. */
  _shopContextMenu(shopId, ev) {
    const def = getShop(shopId); if (!def) return;
    this._openContextMenu(ev, [
      { action: "edit", label: game.i18n.localize("CYBERPUNK.ShopCtxEdit"), handler: () => this.navigate("build", shopId) },
      { action: "preview", label: game.i18n.localize("CYBERPUNK.ShopCtxPreview"), handler: () => this.navigate("storefront", shopId) },
      { action: "toggle", label: def.open ? game.i18n.localize("CYBERPUNK.ShopClose") : game.i18n.localize("CYBERPUNK.ShopShowToPlayers"), handler: async () => { await updateShop(shopId, { open: !def.open }); this.render(); } },
      { action: "duplicate", label: game.i18n.localize("CYBERPUNK.ShopCtxDuplicate"), handler: async () => { await duplicateShop(shopId); this.render(); } },
      { action: "rename", label: game.i18n.localize("CYBERPUNK.ShopCtxRename"), handler: async () => { const name = await promptText(game.i18n.localize("CYBERPUNK.ShopName"), def.name); if (name) { await updateShop(shopId, { name }); this.render(); } } },
      { action: "delete", label: game.i18n.localize("CYBERPUNK.ShopCtxDelete"), handler: async () => { if (await this._confirm(def.name, game.i18n.localize("CYBERPUNK.ShopDeleteConfirm"))) { await deleteShop(shopId); this.render(); } } },
    ]);
  }
}

// ── Purchase engine (shared by the Buy button AND the actor-sheet drag-to-buy) ────────────────────────

/** Buy a catalog item at flat Core cost for `buyer`. Routes cyberware → install, services → pay/subscribe. */
export async function purchaseCatalogItem(buyer, packId, itemId, { qty = 1, styleMult = 1, styleLabel = "" } = {}) {
  if (!buyer) return;
  const doc = await game.packs.get(packId)?.getDocument(itemId);
  if (!doc) return;
  // Price precedence: compendium cost → GM override → unpurchasable. An item the base leaves unpriced
  // is NEVER free — route it (for ANYONE, GM included) through the price-request flow so the GM sets a
  // price first; that price is saved as a self-disengaging override (re-runs here once set). For a
  // variable-price item (data-corrections priceRange) the GM override wins over the compendium cost.
  const corr = correctionFor(packId, itemId);
  const pr = resolveCatalogPrice(correctedCost(packId, itemId, doc.system?.cost), itemId, undefined, { preferOverride: !!corr?.priceRange });
  if (!pr.purchasable) {
    await requestPurchase(buyer, { packId, itemId, name: doc.name, qty, styleMult, styleLabel, needsPrice: true });
    return;
  }
  const unitPrice = Math.max(0, Math.round(pr.price * (Number(styleMult) || 1)));
  const label = styleLabel && styleMult !== 1 ? `${styleLabel} ×${styleMult}` : "";
  // Published-shops-only: a player may BROWSE the full catalog but needs GM permission to buy from it
  // directly — route the buy through a GM purchase request instead. (Published-shop buys go through
  // purchaseShopItem and are unaffected; a GM buying here is unaffected.) A variable-price item's
  // request carries the book range so the GM can set the final price right on the card.
  if (!game.user.isGM && shopBuySource() === "shops") {
    await requestPurchase(buyer, { packId, itemId, name: doc.name, qty, unitPrice, styleMult, styleLabel, priceRange: corr?.priceRange ?? null });
    return;
  }
  if (doc.type === "cyberware") { await buyAndInstallCyberware(buyer, doc, { partPrice: unitPrice }); return; }
  const svc = classifyService(doc, game.packs.get(packId)?.metadata?.name ?? "");
  if (svc === "oneoff") await payOneOffService(buyer, doc, { unitPrice, priceLabel: label });
  else if (svc === "recurring") await buyItem(buyer, doc, { qty: 1, unitPrice, priceLabel: label, flagPatch: { serviceMode: "recurring" } });
  else await buyItem(buyer, doc, { qty, unitPrice, priceLabel: label });
}

/** Buy a curated shop item for `buyer`: shop pricing (override × style × discount), then deplete stock. */
export async function purchaseShopItem(buyer, shopId, sourceKey, { qty } = {}) {
  if (!buyer) return;
  const def = getShop(shopId);
  if (!def) return;
  if (def.open === false && !game.user.isGM) { ui.notifications?.warn(game.i18n.localize("CYBERPUNK.ShopClosed")); return; }
  const e = normalizeShopItem(def.items[sourceKey]);
  const n = Math.max(1, Math.floor(Number(qty) || 1));
  if (!e.unlimited && e.qty < n) { ui.notifications?.warn(game.i18n.format("CYBERPUNK.ShopOutOfStock", { name: sourceKey, qty: e.qty })); return; }
  // Limited stock can only be depleted GM-side (the GM owns the setting) — directly if we ARE the GM,
  // else via the shopBuyRelay socket to an ACTIVE GM. With neither, the charge would land but stock
  // would never move (silent oversell). Refuse the buy BEFORE charging — mirror the unpriced-buy refusal.
  // Unlimited-stock items have no decrement to drop and stay buyable.
  if (!e.unlimited && !game.user.isGM && !game.users.activeGM) { ui.notifications?.warn(game.i18n.localize("CYBERPUNK.ShopNoGmForStock")); return; }
  const [packId, itemId] = splitSourceKey(sourceKey);
  const doc = await game.packs.get(packId)?.getDocument(itemId);
  if (!doc) { ui.notifications?.warn(game.i18n.localize("CYBERPUNK.ShopItemUnavailable")); return; }
  const { category, sub } = categoryOfPack(game.packs.get(packId)?.metadata?.name ?? "");
  const isClothing = category === "Gear" && sub === "Fashion";
  const styleMult = isClothing ? styleMultOf(e.style) : 1;
  const unitPrice = effectivePrice(def, sourceKey, Number(correctedCost(packId, itemId, doc.system?.cost)) || 0, styleMult);
  const bits = [];
  if (isClothing && e.style && e.style !== "generic") bits.push(`${shopStyleLabel(e.style)} ×${styleMult}`);
  if (def.discountPct) bits.push(`-${def.discountPct}%`);
  const label = bits.join(", ");

  let ok = false;
  if (doc.type === "cyberware") ok = await buyAndInstallCyberware(buyer, doc, { partPrice: unitPrice });
  else {
    const svc = classifyService(doc, game.packs.get(packId)?.metadata?.name ?? "");
    if (svc === "oneoff") ok = await payOneOffService(buyer, doc, { unitPrice, priceLabel: label });
    else if (svc === "recurring") ok = await buyItem(buyer, doc, { qty: 1, unitPrice, priceLabel: label, flagPatch: { serviceMode: "recurring" } });
    else ok = await buyItem(buyer, doc, { qty: n, unitPrice, priceLabel: label });
  }
  if (ok !== false && !e.unlimited) {
    if (game.user.isGM) await decrementShopStock(def.id, sourceKey, n, { buyerName: buyer?.name ?? "" });
    else if (game.users.activeGM) game.socket.emit("module.cp2020-augmented", { type: "shopBuyRelay", shopId: def.id, sourceKey, qty: n, buyerName: buyer?.name ?? "" });
  }
}

/* ── Published-shops-only: GM purchase-request flow ───────────────────────────────────────────────────
 * When "Player buy source" = published shops only, a player can browse the full catalog but cannot buy
 * from it directly. Instead we whisper the GMs a request card (Approve / Deny). Approve runs the exact
 * same purchaseCatalogItem AS the GM (the gate above is GM-exempt), so the buyer is charged + stocked
 * through the normal path; Deny whispers the requester. Buttons are bound per-viewer for GMs in
 * registerShopHooks (the card itself is viewer-neutral, like the apply-damage card). */

/** Post a GM-whispered purchase request for a full-catalog item; notify the requesting player.
 *  `needsPrice` = the item has no catalog price; the card shows the GM a price input to set first.
 *  `priceRange` = a variable-price item (data-corrections): the card shows the book's range and an
 *  OPTIONAL price input — the GM may set the final price or approve at the listed one. */
async function requestPurchase(buyer, { packId, itemId, name, qty = 1, unitPrice = 0, styleMult = 1, styleLabel = "", needsPrice = false, priceRange = null } = {}) {
  const n = Math.max(1, Math.floor(Number(qty) || 1));
  const total = Math.max(0, Math.round((Number(unitPrice) || 0) * n));
  const label = styleLabel && styleMult !== 1 ? `${styleLabel} ×${styleMult}` : "";
  const content = await renderChatCard("shop/purchase-request.hbs", {
    requester: game.user.name, buyer: buyer?.name ?? "", name, qty: n, total, label, pending: true, needsPrice, priceRange,
  });
  const gms = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({
    content, whisper: gms, speaker: ChatMessage.getSpeaker({ actor: buyer }),
    flags: { "cp2020-augmented": { purchaseRequest: {
      buyerId: buyer?.id ?? "", packId, itemId, qty: n, styleMult, styleLabel,
      name, total, needsPrice, priceRange, requesterId: game.user.id, status: "pending",
    } } },
  });
  ui.notifications?.info(game.i18n.localize("CYBERPUNK.ShopRequestSent"));
}

// Purchase requests already being resolved on THIS client — a synchronous claim (add before the first
// await) makes a double-click / a re-fire a no-op; the shared pending flag (flipped early below) guards a
// concurrent second GM. Mirrors the area-confirm claim idiom (combat/damage-hooks.js).
const _resolvingPurchaseRequests = new Set();

/** GM resolves a pending purchase request: Approve runs the buy as GM; Deny whispers the requester.
 *  For a price-request (needsPrice), `price` is the GM-entered value: it's saved as a self-disengaging
 *  override (never written to the compendium) BEFORE the buy, so purchaseCatalogItem resolves to it.
 *  For a variable-price request (priceRange) the input is OPTIONAL: a GM-entered price is saved as the
 *  item's override (which WINS for range items — see resolveCatalogPrice preferOverride); left blank,
 *  the buy runs at the listed price.
 *  @returns {Promise<boolean>} false only when the GM should be able to retry (e.g. a price is still
 *    needed); true once claimed/resolved (or already gone) so the caller can keep the buttons disabled. */
async function resolvePurchaseRequest(message, approve, price) {
  if (!game.user.isGM) return true;
  const req = message?.getFlag?.("cp2020-augmented", "purchaseRequest");
  if (!req || req.status !== "pending") return true;   // already resolved / claimed elsewhere
  const buyer = game.actors.get(req.buyerId);
  // Pre-claim validation (non-destructive, retriable): a missing buyer or an unset price mustn't burn the
  // request — warn and let the GM fix it and click again.
  if (approve) {
    if (!buyer) { ui.notifications?.warn(game.i18n.localize("CYBERPUNK.ShopNoActor")); return false; }
    if (req.needsPrice && !isValidPrice(price)) { ui.notifications?.warn(game.i18n.localize("CYBERPUNK.ShopPriceNeeded")); return false; }
  }
  // Claim synchronously (before any await) so a double-click / a second click on this client can't
  // double-charge; a concurrent second GM is caught by the early status flip below.
  if (_resolvingPurchaseRequests.has(message.id)) return true;
  _resolvingPurchaseRequests.add(message.id);
  try {
    // Flip the shared pending flag as early as possible — before the awaited buy — so another client's
    // `status !== "pending"` guard fails and only one resolution charges + stocks.
    await message.update({ "flags.cp2020-augmented.purchaseRequest.status": approve ? "approved" : "denied" });
    if (approve) {
      if (req.needsPrice) await setShopPriceOverride(req.itemId, price);   // self-disengaging: compendium cost always wins later
      else if (req.priceRange && isValidPrice(price)) await setShopPriceOverride(req.itemId, price);   // range item: the GM's price becomes the standing final price
      await purchaseCatalogItem(buyer, req.packId, req.itemId, { qty: req.qty, styleMult: req.styleMult, styleLabel: req.styleLabel });
    } else {
      const player = game.users.get(req.requesterId);
      if (player) ChatMessage.create({
        whisper: [player.id],
        content: game.i18n.format("CYBERPUNK.ShopRequestDeniedWhisper", { name: foundry.utils.escapeHTML(req.name ?? "") }),
      });
    }
    const label = req.styleLabel && req.styleMult !== 1 ? `${req.styleLabel} ×${req.styleMult}` : "";
    // After a price-request approval the total is now known (price × qty); a range request the GM
    // repriced recomputes the same way; otherwise keep the original.
    const gmPriced = approve && (req.needsPrice || (req.priceRange && isValidPrice(price)));
    const total = gmPriced ? Math.max(0, Math.round((Number(price) || 0) * req.qty)) : req.total;
    const content = await renderChatCard("shop/purchase-request.hbs", {
      requester: game.users.get(req.requesterId)?.name ?? "", buyer: buyer?.name ?? req.buyerId,
      name: req.name, qty: req.qty, total, label,
      pending: false, approved: approve, resolvedBy: game.user.name,
    });
    await message.update({ content });
  } finally {
    _resolvingPurchaseRequests.delete(message.id);
  }
  return true;
}

/** A small Buy/Cancel confirm for drag-to-buy. Resolves to the chosen qty, or null on cancel. */
async function confirmPurchaseDialog({ name, unitPrice, buyerName, isService, allowQty }) {
  const msg = game.i18n.format(isService ? "CYBERPUNK.ShopDropConfirmService" : "CYBERPUNK.ShopDropConfirmItem",
    { name: foundry.utils.escapeHTML(name), price: unitPrice, buyer: foundry.utils.escapeHTML(buyerName) });
  const content = await renderChatCard("shop/purchase-confirm.hbs", { msg, allowQty });
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("CYBERPUNK.ShopBuy") },
    content,
    buttons: [
      { action: "buy", icon: "fa-solid fa-cart-shopping", label: game.i18n.localize("CYBERPUNK.ShopBuy"), default: true,
        callback: (ev, btn, dlg) => allowQty ? Math.max(1, parseInt(dlg.element.querySelector('[name="qty"]')?.value, 10) || 1) : 1 },
      { action: "cancel", label: game.i18n.localize("CYBERPUNK.Cancel"), callback: () => null },
    ],
    rejectClose: false,
  });
  // DialogV2.wait resolves to the chosen button callback's return value; a null/undefined return
  // (Cancel) falls back to the button's action id ("cancel"), and X-close (rejectClose:false)
  // resolves null. So only a numeric result means a real purchase quantity.
  return typeof result === "number" ? result : null;
}

/**
 * Drag-to-buy: a shop row dropped on a character sheet purchases it for that actor. `shopId` set = curated
 * shop pricing/stock; null = flat catalog cost. Cyberware skips the generic confirm (its install flow has its
 * own surgery/Humanity confirm); items + services get a quick Buy/Cancel confirm with a quantity field.
 */
export async function purchaseByDrop(buyer, { sourceKey, shopId = null } = {}) {
  if (!shoppingEnabled() || !buyer || !sourceKey) return;
  const [packId, itemId] = splitSourceKey(sourceKey);
  const doc = await game.packs.get(packId)?.getDocument(itemId);
  if (!doc) { ui.notifications?.warn(game.i18n.localize("CYBERPUNK.ShopItemUnavailable")); return; }
  const packName = game.packs.get(packId)?.metadata?.name ?? "";
  const { category, sub } = categoryOfPack(packName);
  const isClothing = category === "Gear" && sub === "Fashion";
  const svc = classifyService(doc, packName);

  // Unit price for the confirm display (matches what the purchase fn will charge).
  let unitPrice, styleMult = 1, styleLabel = "";
  if (shopId) {
    const def = getShop(shopId);
    if (!def) return;
    if (def.open === false && !game.user.isGM) { ui.notifications?.warn(game.i18n.localize("CYBERPUNK.ShopClosed")); return; }
    const e = normalizeShopItem(def.items[sourceKey]);
    styleMult = isClothing ? styleMultOf(e.style) : 1;
    unitPrice = effectivePrice(def, sourceKey, Number(correctedCost(packId, itemId, doc.system?.cost)) || 0, styleMult);
    styleLabel = (isClothing && e.style && e.style !== "generic") ? shopStyleLabel(e.style) : "";
  } else {
    const corr = correctionFor(packId, itemId);
    const pr = resolveCatalogPrice(correctedCost(packId, itemId, doc.system?.cost), itemId, undefined, { preferOverride: !!corr?.priceRange });
    if (!pr.purchasable) {
      // Unpriced catalog item: skip the misleading 0eb confirm — purchaseCatalogItem routes the drop
      // through the GM price-request flow (no free buy). Qty defaults to 1 until a price is set.
      await purchaseCatalogItem(buyer, packId, itemId, { qty: 1, styleMult, styleLabel });
      return;
    }
    unitPrice = pr.price;
  }

  // Cyberware: straight through (buyAndInstallCyberware shows its own surgery/Humanity confirm).
  if (doc.type === "cyberware") {
    if (shopId) await purchaseShopItem(buyer, shopId, sourceKey, { qty: 1 });
    else await purchaseCatalogItem(buyer, packId, itemId, { qty: 1, styleMult, styleLabel });
    return;
  }
  const isService = svc === "oneoff" || svc === "recurring";
  const qty = await confirmPurchaseDialog({ name: doc.name, unitPrice, buyerName: buyer.name, isService, allowQty: !isService });
  if (qty == null) return;
  if (shopId) await purchaseShopItem(buyer, shopId, sourceKey, { qty });
  else await purchaseCatalogItem(buyer, packId, itemId, { qty, styleMult, styleLabel });
}

/** Modal text prompt; resolves to the entered string, or null on cancel. */
async function promptText(title, initial = "") {
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title },
    content: await renderChatCard("shop/prompt-text.hbs", { initial }),
    buttons: [
      { action: "ok", label: game.i18n.localize("CYBERPUNK.ShopCreate"), default: true,
        callback: (ev, btn, dlg) => ({ ok: true, text: (dlg.element.querySelector('[name="t"]')?.value ?? "").trim() }) },
      { action: "cancel", label: game.i18n.localize("CYBERPUNK.Cancel"), callback: () => null },
    ],
    rejectClose: false,
  });
  // Only the OK button returns an object; Cancel falls back to its action id and X-close to null
  // (see confirmPurchaseDialog). This distinguishes "OK with (possibly empty) text" from cancel.
  return (result && typeof result === "object" && result.ok) ? result.text : null;
}

// ── Window + entry points ─────────────────────────────────────────────────────
function resolveSidebarBuyer() {
  const tok = canvas?.tokens?.controlled?.find(t => t.actor?.type === "character");
  if (tok?.actor) return tok.actor;
  if (game.user.character?.type === "character") return game.user.character;
  return null;
}

/** Open (or focus) the single Shop window at the given view. */
export function openShopWindow(buyer, { view = "home", shopId = null } = {}) {
  if (!shoppingEnabled()) { ui.notifications?.warn(game.i18n.localize("CYBERPUNK.ShopDisabled")); return; }
  let win = [...foundry.applications.instances.values()].find(w => w instanceof CatalogBrowser) ?? null;
  if (!win) { win = new CatalogBrowser(buyer ?? resolveSidebarBuyer(), { view, shopId }); win.render({ force: true }); return win; }
  win.buyer = buyer ?? win.buyer;
  win.navigate(view, shopId, false);
  if (win.rendered && win.element) { win.render(); try { win.bringToFront?.(); } catch { /* not ready */ } shimmerWindow(win); }
  else win.render({ force: true });
  return win;
}

/** Back-compat alias (character-sheet button, chat links). */
export function openShopForPlayer(buyer) { openShopWindow(buyer, { view: "home" }); }
export function openCatalogBrowser(buyer) { openShopWindow(buyer, { view: "catalog" }); }

function openShopFromSidebar() { openShopWindow(resolveSidebarBuyer(), { view: "home" }); }

function injectSidebarShopButton(html) {
  try {
    if (!shoppingEnabled()) return;
    const root = html instanceof jQuery ? html[0] : html;
    const menu = root?.querySelector?.("nav.tabs menu") ?? root?.querySelector?.(".tabs menu");
    if (!menu || menu.querySelector(".cp-shop-tab")) return;
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ui-control plain icon fa-solid fa-cart-shopping cp-shop-tab";
    btn.setAttribute("aria-label", game.i18n.localize("CYBERPUNK.ShopTitle"));
    btn.dataset.tooltip = game.i18n.localize("CYBERPUNK.ShopTitle");
    btn.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); openShopFromSidebar(); });
    li.appendChild(btn);
    const actorsLi = menu.querySelector('[data-tab="actors"]')?.closest("li");
    const collapseLi = menu.querySelector('[data-action="toggleState"]')?.closest("li");
    if (actorsLi) actorsLi.after(li);
    else if (collapseLi) menu.insertBefore(li, collapseLi);
    else menu.appendChild(li);
  } catch (e) { console.warn("cp2020-augmented | shop sidebar button failed", e); }
}

/** GM "Show to Players": open the shop + post a clickable chat link. */
export async function publishShop(shopId) {
  const def = getShop(shopId); if (!def) return;
  await updateShop(shopId, { open: true });
  const content = await renderChatCard("shop-published.hbs", { shopName: foundry.utils.escapeHTML(def.name), shopId });
  ChatMessage.create({ content });
}

/** Ready-time hooks: sidebar button + chat links + live buyer sync + the GM stock-decrement relay. */
export function registerShopHooks() {
  Hooks.on("renderSidebar", (app, html) => injectSidebarShopButton(html));
  if (ui.sidebar?.element) injectSidebarShopButton(ui.sidebar.element);
  if (shoppingEnabled()) getCatalogIndex().catch(() => {});

  let _ctrlTimer = null;
  Hooks.on("controlToken", () => {
    clearTimeout(_ctrlTimer);
    _ctrlTimer = setTimeout(() => {
      const buyer = resolveSidebarBuyer();
      for (const w of foundry.applications.instances.values()) {
        if (!(w instanceof CatalogBrowser) || w.view === "build") continue;
        if (w.buyer?.id === buyer?.id) continue;   // unchanged → don't disturb an open window
        w.buyer = buyer;
        w.render();                                 // scroll preserved by the PART's `scrollable`
      }
    }, 50);
  });

  Hooks.on("renderChatMessageHTML", (message, html) => {
    const root = html instanceof jQuery ? html[0] : html;
    root?.querySelectorAll?.(".cp-shop-open-link").forEach(btn => {
      if (btn.dataset.cpBound === "1") return;
      btn.dataset.cpBound = "1";
      btn.addEventListener("click", (ev) => { ev.preventDefault(); openShopWindow(resolveSidebarBuyer(), { view: "storefront", shopId: btn.dataset.shopId }); });
    });
    // GM Approve/Deny on a pending purchase request (the card is whispered to GMs, so only GMs see it).
    // On a price-request, Approve reads the GM's entered price from the card's price input.
    if (game.user.isGM) root?.querySelectorAll?.(".cp-shop-request-btn").forEach(btn => {
      if (btn.dataset.cpBound === "1") return;
      btn.dataset.cpBound = "1";
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        // Disable both buttons synchronously on click so a double-click can't fire a second resolution
        // (the async race is guarded by the in-memory claim + status flip in resolvePurchaseRequest).
        const card = btn.closest(".cp-shop-request");
        const btns = card ? [...card.querySelectorAll(".cp-shop-request-btn")] : [btn];
        btns.forEach(b => b.disabled = true);
        const price = card?.querySelector(".cp-shop-request-price")?.value;
        const resolved = await resolvePurchaseRequest(message, btn.dataset.action === "approve", price);
        if (resolved === false) btns.forEach(b => b.disabled = false);   // retriable bail (e.g. a price is still needed)
      });
    });
  });

  game.socket.on("module.cp2020-augmented", async (data) => {
    if (data?.type !== "shopBuyRelay") return;
    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
    try { await decrementShopStock(data.shopId, data.sourceKey, data.qty, { buyerName: data.buyerName ?? "" }); }
    catch (e) { console.warn("cp2020-augmented | shopBuyRelay failed", e); }
  });

  // Drag-to-buy: dropping a catalog/storefront row onto a character sheet purchases it for that actor.
  // The core `dropActorSheetData` hook fires for BOTH the v1 and v2 actor sheets BEFORE the sheet
  // processes the drop, so this works without overriding the system's sheet class or coupling to its
  // (v1-vs-v2) DOM. Returning false cancels the default drop so the purchase payload isn't mistaken
  // for an item drop. (The catalog rows emit this payload via _activatePurchaseDrag.)
  Hooks.on("dropActorSheetData", (actor, sheet, data) => {
    if (data?.type !== "cp2020-augmentedPurchase") return true;
    if (actor?.isOwner) purchaseByDrop(actor, data);
    return false;
  });
}
