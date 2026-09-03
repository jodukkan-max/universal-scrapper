/* MV3 service worker — orchestrates active-tab scraping + WooCommerce calls.
 * Kept intentionally tiny: no heavy modules are loaded at startup, so the
 * worker cold-starts fast and the side panel opens without waiting on it. */

importScripts('supabase.js');

console.log('[Universal Scrapper] service worker v1.0.3 started');

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// One-time migration: older builds stored custom scrapers as an array; reset it.
chrome.storage.local.get('customScrapers').then(({ customScrapers }) => {
  if (Array.isArray(customScrapers) || (customScrapers && typeof customScrapers !== 'object')) {
    chrome.storage.local.set({ customScrapers: {} });
  }
});

// Cancellation of an in-flight AI generation/chat-fix (the user taps "Cancel"
// while the agent is working). The AbortController threads through to the
// DeepSeek fetch so the long request aborts immediately.
let cancelRequested = false;
let currentGenAbort = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[Universal Scrapper] message received:', msg && msg.type);
  (async () => {
    try {
      if (msg.type === 'scrape') sendResponse(await handleScrape(msg));
      else if (msg.type === 'generateScraper') sendResponse(await generateScraper(msg));
      else if (msg.type === 'chatFixScraper') sendResponse(await chatFixScraper(msg));
      else if (msg.type === 'saveScraper') sendResponse(await saveScraper(msg));
      else if (msg.type === 'cancelGenerate') { cancelRequested = true; if (currentGenAbort) currentGenAbort.abort(); sendResponse({ ok: true }); }
      else if (msg.type === 'wcTest') sendResponse(await wcTest(msg));
      else if (msg.type === 'wcImport') sendResponse(await wcImport(msg));
      else if (msg.type === 'fetchSwatchDataUrl') sendResponse({ dataUrl: await fetchSwatchAsDataUrl(msg.swatchUrl) });
      else sendResponse({ ok: false, error: 'Unknown message: ' + (msg && msg.type ? msg.type : JSON.stringify(msg)) });
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // keep the channel open for async response
});

// ── Scrape (active tab) ──────────────────────────────────────────────────────
async function handleScrape({ productType, tabId, url }) {
  if (!tabId) return { ok: false, error: 'No active tab.' };
  const customBody = url ? await scraperBodyFor(url, productType || 'auto') : '';
  if (customBody) {
    const html = await getTabHtml(tabId);
    const r = await runScraperInPage(tabId, customBody, productType || 'auto', html);
    if (r.ok) return { ok: true, rows: r.rows, title: r.title, site: 'custom', brand: '' };
    return r;
  }
  // No site-specific scraper: run the shared predefined module (served from
  // Supabase), which detects the site and falls back to the universal
  // WooCommerce scraper.
  const html = await getTabHtml(tabId);
  const body = await predefinedBody();
  if (!body) return { ok: false, error: 'Could not load the scraper engine. Check your connection and try again.' };
  const r = await runScraperInPage(tabId, body, productType || 'auto', html);
  if (r.ok) return { ok: true, rows: r.rows, title: r.title, site: r.site || '', brand: r.brand || '' };
  return r;
}

// ── Swatch image relay — downloads CORS-free in SW, returns base64 data URL ──
async function fetchSwatchAsDataUrl(swatchUrl) {
  try {
    const resp = await fetch(swatchUrl);
    if (!resp.ok) return '';
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const mime = resp.headers.get('content-type') || 'image/jpeg';
    return 'data:' + mime + ';base64,' + btoa(binary);
  } catch (e) { return ''; }
}

// ── Connection test (Rey Swatches Import plugin endpoint) ──────────────
async function wcTest({ store, authKey }) {
  try {
    const base = store.replace(/\/+$/, '') + '/wp-json/scraper/v1/import-csv';
    const r = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Scraper-Key': authKey || '',
      },
      body: JSON.stringify({ csv: 'SKU,Name,Regular Price\nTEST,Test Product,0' }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 403) throw new Error('Invalid auth key. Check the key from the plugin dashboard.');
    if (r.status === 404) throw new Error('Rey Swatches Import plugin not found. Install and activate it first.');
    return { ok: true, message: 'Connected — import endpoint reachable.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── CSV import via the plugin endpoint ──────────────────────────────────
async function wcImport({ store, authKey, csv, skipResize }) {
  try {
    const url = store.replace(/\/+$/, '') + '/wp-json/scraper/v1/import-csv';
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Scraper-Key': authKey || '',
      },
      body: JSON.stringify({ csv, skip_resize: !!skipResize }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 403) throw new Error('Invalid auth key. Check the key from the plugin dashboard.');
    if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
    // The plugin returns HTTP 200 even when every product was skipped (it reports
    // per-product failures in `messages` + a `skipped` count). Surface that as a
    // real error so "successfully imported" is never shown when nothing landed.
    const created = (data.created_variable || 0) + (data.created_simple || 0);
    const updated = (data.updated_variable || 0) + (data.updated_simple || 0);
    const skipped = data.skipped || 0;
    if (created + updated === 0 && skipped > 0) {
      const msgs = Array.isArray(data.messages) ? data.messages.filter(Boolean) : [];
      throw new Error(msgs.length ? msgs.join(' | ') : 'No products were imported.');
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── "Add new Scrapper" (AI) ──────────────────────────────────────────────
// DeepSeek is reached through the Supabase Edge Function (the API key lives only
// in the function secret, never in the extension).
const DS_FLASH = 'deepseek-v4-flash';

async function callDeepSeek(messages, { json, onReasoning, signal } = {}) {
  const res = await self.Supabase.deepseek(messages, { json, signal });
  if (res.cancelled) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
  if (!res.ok) throw new Error(res.error || ('DeepSeek HTTP ' + res.status));
  const data = res.data || {};
  const content = data.content || '';
  if (!content) throw new Error('Empty AI response.');
  if (onReasoning && data.reasoning) onReasoning(data.reasoning);
  return content;
}

function stripFences(s) {
  return String(s || '')
    .replace(/^```(?:json|javascript|js)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

async function getTabHtml(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.documentElement.outerHTML,
  });
  return result || '';
}

// Live "agent thinking" line — shown while the AI works (generation + chat fixes).
function sendThinking(text) {
  try { chrome.runtime.sendMessage({ type: 'agentThinking', text: String(text || '') }).catch(() => {}); }
  catch (e) {}
}

function trimThinking(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > 240 ? t.slice(0, 240) + '…' : t;
}

// ── Generic scraper generation ──────────────────────────────────────────────
// Preamble of shared helpers available to every AI-generated scraper. The model
// writes only `async function run(ctx) {...}`; we prepend this and append
// `return run(ctx);` to build a self-contained, materializable function body.
const GENERIC_HELPERS = `
function decodeEntities(s){ return String(s==null?'':s)
  .replace(/&#x([0-9a-fA-F]+);/g,(_,n)=>String.fromCodePoint(parseInt(n,16)))
  .replace(/&#(\\d+);/g,(_,n)=>String.fromCodePoint(parseInt(n,10)))
  .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'")
  .replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
  .replace(/&bull;/g,'\\u2022').replace(/&hellip;/g,'\\u2026')
  .replace(/&mdash;/g,'\\u2014').replace(/&ndash;/g,'\\u2013').replace(/&reg;/g,'\\u00ae').replace(/&trade;/g,'\\u2122'); }
function normalizeShopUrl(src){ if(!src) return ''; const s=String(src).trim(); if(s.indexOf('$')>=0||s.indexOf('{')>=0||s.indexOf('}')>=0) return ''; const abs=s.startsWith('//')?'https:'+s:s; return abs.split('?')[0]; }
function ldBlocks(html){ return [...String(html||'').matchAll(/<script[^>]*application\\/ld\\+json[^>]*>([\\s\\S]*?)<\\/script>/g)].map(m=>m[1]); }
const fmtPrice = p => { const n = parseFloat(p); return isFinite(n) ? n.toFixed(2) : ''; };
function simpleRow(o){ return [{ SKU: o.sku||'', Name: o.name||'', Description: o.description||'', 'Short Description': o.shortDesc||'', 'Regular Price': o.regularPrice||o.price||'', Categories: o.categories||'', Images: o.images||[] }]; }
function variableRows(title, parentImages, description, shortDesc, categories, optionName, variants, optionName2){
  optionName2=optionName2||''; const rows=[]; let rowId=1;
  const a1=[...new Set((variants||[]).map(v=>v.name).filter(Boolean))].join(',');
  const a2=[...new Set((variants||[]).map(v=>v.name2).filter(Boolean))].join(',');
  rows.push({ ID:rowId++, Parent:'', Type:'variable', SKU:'', Name:title, Images:(parentImages||[]).slice(0,4), 'Rey Variations extra images':'', Description:description||'', 'Short Description':shortDesc||'', Categories:categories||'', 'Regular Price':'', 'Attribute 1 name':optionName, 'Attribute 1 value(s)':a1, 'Attribute 1 visible':'1', 'Attribute 1 global':'1', 'Attribute 2 name':optionName2, 'Attribute 2 value(s)':a2, 'Attribute 2 visible':optionName2?'1':'', 'Attribute 2 global':optionName2?'1':'', 'Color Code':'' });
  const parentId=rowId-1;
  for(const v of variants){ rows.push({ ID:rowId++, Parent:'id:'+parentId, Type:'variation', SKU:v.sku||'', Name:title, Images:(v.images&&v.images.length)?[v.images[0]]:[], 'Rey Variations extra images':(v.extras&&v.extras.length)?v.extras:[], Description:'', 'Short Description':'', Categories:'', 'Regular Price':v.regularPrice||'', 'Attribute 1 name':optionName, 'Attribute 1 value(s)':v.name||'', 'Attribute 1 visible':'', 'Attribute 1 global':'1', 'Attribute 2 name':optionName2, 'Attribute 2 value(s)':v.name2||'', 'Attribute 2 visible':'', 'Attribute 2 global':optionName2?'1':'', 'Color Code':v.colorCode||'' }); }
  return rows;
}
`;

function buildScraperBody(runBody) {
  return GENERIC_HELPERS + '\n' + runBody + '\nreturn run(ctx);';
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function brandFromDomain(domain) {
  if (!domain) return '';
  return domain.split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Returns the materializable body for a scraper of this URL, if one exists in
// the Supabase registry. `type` is 'simple' | 'variable' | 'auto' (auto prefers
// variable, then simple).
async function scraperBodyFor(url, type) {
  const domain = domainOf(url);
  if (!domain) return '';
  const rows = await self.Supabase.listScrapersForDomain(domain);
  const simple = rows.find(r => r.type === 'simple' && r.code);
  const variable = rows.find(r => r.type === 'variable' && r.code);
  if (type === 'simple') return simple ? simple.code : '';
  if (type === 'variable') return variable ? variable.code : '';
  return variable ? variable.code : (simple ? simple.code : '');
}

async function getScraperEntry(domain, type) {
  const rows = await self.Supabase.listScrapersForDomain(domain);
  return rows.find(r => r.type === type) || null;
}

async function saveScraperEntry(domain, type, fields) {
  await self.Supabase.upsertScraper(Object.assign({ domain, type }, fields));
}

// ── Predefined module (shared scraper engine, served from Supabase) ──────────
const PRE_MODULE_KEY = 'predefinedModule';
const PRE_VERSION_KEY = 'predefinedModuleVersion';

// Returns the materializable body for the predefined module (module source +
// scrapeProduct dispatch). Cached in chrome.storage.local and refreshed when the
// server version changes, so repeated scrapes stay instant and offline-capable.
async function predefinedBody() {
  const cached = await chrome.storage.local.get([PRE_MODULE_KEY, PRE_VERSION_KEY]);
  const cachedBody = cached[PRE_MODULE_KEY];
  const cachedVersion = cached[PRE_VERSION_KEY] || 0;

  if (cachedBody) {
    // Fast path: a lightweight version check avoids re-downloading ~290 KB.
    const serverVersion = await self.Supabase.getPredefinedVersion();
    if (serverVersion != null && serverVersion === cachedVersion) return cachedBody;
  }

  const mod = await self.Supabase.getPredefinedModule();
  if (!mod || !mod.code) return cachedBody || '';
  const body = mod.code + '\nreturn self.ProductScraper.scrapeProduct(ctx);';
  await chrome.storage.local.set({ [PRE_MODULE_KEY]: body, [PRE_VERSION_KEY]: mod.version });
  return body;
}

// Compact but structured page sample for the generator: title + og meta +
// JSON-LD + tag-preserving HTML (scripts/styles stripped).
function scraperHtmlSample(html) {
  const h = String(html || '');
  const lds = [...h.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n---\n');
  const title = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const og = [...h.matchAll(/<meta[^>]*property="og:([^"]+)"[^>]*content="([^"]*)"[^>]*>/gi)].map(m => 'og:' + m[1] + '=' + m[2]).join('\n');
  const ogTitle = (h.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"[^>]*>/i) || [])[1] || '';
  const stripped = h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Locate the product region so the model sees the actual price/SKU/description
  // instead of only the page header (which can be tens of KB away). Prefer the
  // product heading, then the add-to-cart control, then the product title text.
  let anchor = -1;
  const h1 = stripped.search(/<h1\b/i);
  if (h1 >= 0) anchor = h1;
  else {
    const atc = stripped.search(/add[\s-]*to[\s-]*(cart|bag|basket)|addtocart|buy[\s-]*now/i);
    if (atc >= 0) anchor = atc;
    else {
      const needle = (ogTitle || title).replace(/[|–—].*$/, '').trim().slice(0, 60);
      if (needle) { const ti = stripped.indexOf(needle); if (ti >= 0) anchor = ti; }
    }
  }

  const windowed = anchor >= 0
    ? stripped.slice(Math.max(0, anchor - 1500), anchor + 22000)
    : stripped.slice(0, 16000);

  return 'TITLE: ' + title + '\n\nMETA:\n' + og + '\n\nJSON-LD BLOCKS:\n' + lds.slice(0, 8000) + '\n\nPRODUCT HTML (around the product area):\n' + windowed;
}

const GENERATE_SYSTEM = (type) => `You are an expert web-scraper engineer. Write a single JavaScript function for a Chrome extension that extracts product data from a product page's HTML.

Write ONLY the function definition (no markdown fences, no explanation):

async function run(ctx) { ... }

Inputs available on ctx:
- ctx.mainHtml (string) — the full page HTML (already downloaded for you).
- ctx.url (string) — the page URL.
- ctx.fetchText(url, opts) / ctx.fetchJson(url, opts) — optional fetch helpers (return string/object). Use only if the data is not already in mainHtml.

Helpers already defined in scope (DO NOT redefine them): decodeEntities(s), ldBlocks(html), normalizeShopUrl(src), fmtPrice(p), simpleRow(obj), variableRows(title, parentImages, description, shortDesc, categories, optionName, variants, optionName2).

ldBlocks(html) returns an array of RAW JSON **strings** (the text inside each <script type="application/ld+json"> tag). Each must be JSON.parse()'d (try/catch) before reading fields:
const blocks = ldBlocks(ctx.mainHtml).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);

──────────────────────────────────────────────────────────────
OUTPUT CONTRACT (NON-NEGOTIABLE):

The ONLY correct return value is { rows, title }. You MUST build "rows" by calling the helper — do NOT hand-construct row objects and do NOT invent your own field names, because the downstream table columns are fixed and only these helpers produce them:

- simple product:   return { rows: simpleRow({ sku, name, description, shortDesc, regularPrice, categories, images }), title };
- variable product: return { rows: variableRows(title, parentImages, description, shortDesc, categories, optionName, variants, optionName2), title };

"title" is the product name (string). Never return rows as a plain object or with your own key names — always exactly simpleRow([...]) / variableRows(...) output.

──────────────────────────────────────────────────────────────
HOW TO WORK — READ THIS CAREFULLY:

Every website has a UNIQUE HTML structure. You MUST NOT assume specific class names, meta tags, attribute names, or platforms (WooCommerce, Shopify, JSON-LD, etc.). Your job is to INSPECT ctx.mainHtml for THIS specific page and discover, from its actual content, where each output field lives. There is no standard selector list to follow — derive the mapping from the page itself.

Think in this order:
1. Read ctx.mainHtml. Identify the product's main content area (near the product name/title, price, and "add to cart" button).
2. Look for structured data embedded in the page — JSON-LD blocks, inline JSON in <script> tags (e.g. "var product = {...}", "__NEXT_DATA__", "ShopifyAnalytics", "data-*" attributes). If present, read the fields DIRECTLY from it. Structured data is self-describing: use whatever keys it actually contains.
3. For every field that is NOT available as structured data, locate it in the visible HTML by looking at what is actually near the product content:
   - name/title: the page title, an <h1>, or a product-name heading.
   - price: a number with a currency symbol/code near the title or add-to-cart button.
   - sku/id: an identifier label ("SKU", "barcode", "product code", "MPN", "UPC", "EAN", "Code") with a value near it, or the numeric id in the URL.
   - images: the large <img> src(s) in the product gallery area.
   - description: a longer block of prose text describing the product.
   - categories: breadcrumb links or "Category" labels.
4. Do NOT hardcode anything you saw on a previous page. Match THIS page's structure.

NEVER return an empty field just because there is "no JSON-LD" — that is a failure. If a field's data exists anywhere in mainHtml, find it.

──────────────────────────────────────────────────────────────

${type === 'variable'
  ? `This is a VARIABLE product: it has selectable options (size, colour, shade, etc.) and EACH option usually has its own price and its own photo.

Build rows with: variableRows(title, parentImages, description, shortDesc, categories, optionName, variants, optionName2)

The variants array is the core of a variable product. Discover each option's data from THIS page's structure:
- Find the source of the option list — it may be embedded JSON (JSON-LD hasVariant/offers arrays, a "data-product_variations" attribute, inline "product.variants", "__NEXT_DATA__", etc.), or HTML elements (swatches, <option>, radio inputs) with their own data attributes. Use whichever this page actually provides.
- INCLUDE EVERY OPTION: scrape ALL options/variants the page offers — including out-of-stock, unavailable, sold-out, or disabled ones. NEVER filter variants by stock or availability. If an option is marked out of stock, still emit its variant (name, its own price if present, and its own photo if present).
- For EVERY option, produce one variant object with its OWN data (this is the whole point):
  * name         — the option value (e.g. "Black", "Size M", "42").
  * name2        — the SECOND attribute's value for this option, ONLY when the product has more than one attribute (e.g. a product varying by colour AND size: name="Black", name2="M"; or material AND size: name="Cotton", name2="L"). If the product has a single attribute, set name2 to ''.
  * sku          — that option's own SKU/id, if the page provides one per option; else ''.
  * regularPrice — that option's OWN normal price (numeric string like "15.00", via fmtPrice).
  * images       — array of image URLs for THIS SPECIFIC option (its own photo). The FIRST image is the main photo. If a specific option has no distinct photo, set images to [] (never reuse another option's photo as if it were its own).
  * extras       — extra gallery images for this option (may be []).
  * colorCode    — hex colour or swatch image URL for this option, if the page provides it; else ''.
- "parentImages" = photos shown before any option is selected (the shared gallery). If the page only has per-option images, pass [].
- "optionName" = the attribute name (e.g. "Color", "Size", "Shade") — read it from the page; default to "Option" if absent.
- "optionName2" = the SECOND attribute name, ONLY when the product has more than one selectable attribute (e.g. "Size" when the first is "Color", or "Material" when the first is "Size"). This applies to ANY multi-attribute product, not just clothing. When there is only one attribute, pass '' (empty string) and leave every variant's name2 as ''.

CRITICAL: do NOT copy one price or one image across all options. If the page stores per-option data in a JSON structure whose keys differ from the examples above, read THOSE keys — the structure is whatever the page actually uses.`
  : `This is a SIMPLE product (single product, one price, no options). Build rows with: simpleRow({ sku, name, description, shortDesc, regularPrice, categories, images }) and return { rows, title }. images is an array of image URL strings (normalizeShopUrl() each). regularPrice is a numeric string like "20.76" (via fmtPrice). Use structured data if present; otherwise locate each field in the visible HTML as described above.`}

RULES:
- Never use document, window, location, self, or any DOM API. Only pure JS + regex + JSON + the provided helpers.
- ALWAYS build rows via simpleRow(...) (simple) or variableRows(...) (variable) and return { rows, title }. Do NOT hand-build row objects or invent your own key names.
- Inspect ctx.mainHtml and derive the mapping from THIS page. Do not assume any specific framework, class, or meta tag.
- Use fmtPrice() to normalise every price, and strip query strings from image URLs (normalizeShopUrl()).
- Images: match ONLY real <img> src values (or srcset/data URLs) that look like actual URLs. Inline script blocks often contain JS template placeholders (a dollar sign followed by braces, e.g. "$img") that look like image markup — NEVER emit those as an image URL, and never emit any value containing "$" or "{". Strip script blocks (except JSON-LD) before matching images, or filter matches to those starting with http/https.
- For variable products, include ALL variants/options regardless of stock or availability. Never skip out-of-stock or unavailable variants.
- Robustness: optional chaining and fall back to '' for missing fields.`;

// Drop obviously-broken image URLs a scraper may have produced (e.g. a template
// placeholder like "$img" or "${img}" matched from inline <script> markup). A
// single bad URL otherwise makes WooCommerce reject the ENTIRE product.
function cleanImageList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(u => String(u == null ? '' : u).trim())
    .filter(u => u !== '' && u.indexOf('$') < 0 && u.indexOf('{') < 0 && u.indexOf('}') < 0 &&
      (u.startsWith('http://') || u.startsWith('https://') || u.startsWith('//') || u.startsWith('data:')));
}

// Sanitize scraped rows: clean every image-bearing field so one bad URL can't
// block an import. Applied to every scraper (custom AI, predefined, generated).
function sanitizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(r => {
    if (!r || typeof r !== 'object') return r;
    const c = Object.assign({}, r);
    for (const k of ['Images', 'Rey Variations extra images']) {
      if (Array.isArray(c[k])) c[k] = cleanImageList(c[k]);
    }
    return c;
  });
}

// Runs a generated scraper body in the page's MAIN world. `new Function` (eval)
// is forbidden in MV3 extension pages/service workers (no 'unsafe-eval'), but is
// allowed in the page's own JS context. The page HTML is passed in as an argument
// (already downloaded in the service worker), so the scraper never reads the DOM
// and never depends on the page's own CSP for content.
function evalScraperInMain(code, productType, html) {
  return (async () => {
    try {
      const fetchText = async (u, opts) => {
        const r = await fetch(u, Object.assign({ credentials: 'include' }, opts));
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + u);
        return r.text();
      };
      const fetchJson = async (u, opts) => {
        const r = await fetch(u, Object.assign({ credentials: 'include' }, opts));
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + u);
        return r.json();
      };
      const fn = new Function('ctx', code);
      const out = await fn({
        productType,
        url: location.href,
        mainHtml: html || document.documentElement.outerHTML,
        fetchText, fetchJson,
      });
      return { ok: true, rows: sanitizeRows((out && out.rows) || []), title: (out && out.title) || '', site: (out && out.site) || '', brand: (out && out.brand) || '' };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  })();
}

// Execute a generated scraper body against a given HTML string (page MAIN world).
async function runScraperInPage(tabId, code, productType, html) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: evalScraperInMain,
      args: [code, productType || 'auto', html || ''],
    });
    return result || { ok: false, error: 'No result from page' };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// Verdict for a scraper run. Returns { ok, problem } where `problem` is a
// human-readable explanation of what still needs fixing ('' when ok).
function evaluateResult(res, type) {
  if (!res || !Array.isArray(res.rows) || !res.rows.length) {
    return { ok: false, problem: 'no rows were produced.' };
  }
  if (type === 'variable') {
    const hasParent = res.rows.some(r => r && r.Type === 'variable');
    if (!hasParent) {
      return { ok: false, problem: 'there is no "variable" parent row — you must call variableRows(...) and return its rows (a variable row followed by variation rows).' };
    }
    const vars = res.rows.filter(r => r && r.Type === 'variation');
    if (!vars.length) {
      return { ok: false, problem: 'no "variation" rows were produced — this product has options, so build a variants array and pass it to variableRows(...).' };
    }
    const withPrice = vars.filter(r => r['Regular Price'] && r['Regular Price'] !== '').length;
    const withImg = vars.filter(r => Array.isArray(r.Images) && r.Images.length).length;
    if (withPrice === 0 || withImg === 0) {
      const missing = [];
      if (withPrice === 0) missing.push('no variant has its own price');
      if (withImg === 0) missing.push('no variant has its own photo');
      return { ok: false, problem: missing.join(' and ') + ' — locate each variant\'s own price and photo in the HTML and map them.' };
    }
    return { ok: true, problem: '' };
  }
  // simple
  const row = res.rows[0] || {};
  if (typeof row.Name !== 'string') {
    return { ok: false, problem: 'the row is not in the required schema (missing "Name") — call simpleRow({...}) and return { rows, title }.' };
  }
  const hasPrice = !!row['Regular Price'];
  const hasImg = Array.isArray(row.Images) && row.Images.length > 0;
  if (!hasPrice || !hasImg) {
    const missing = [];
    if (!hasPrice) missing.push('price');
    if (!hasImg) missing.push('image');
    return { ok: false, problem: 'no ' + missing.join(' or ') + ' was extracted — locate it in the page HTML.' };
  }
  return { ok: true, problem: '' };
}

// Compact dump of the rows a scraper produced, so the agent can SEE its actual
// output and self-correct the mapping.
function describeRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return 'NO ROWS (empty).';
  const out = rows.slice(0, 30).map((r, i) => {
    if (!r) return '[' + i + '] null';
    const t = r.Type || 'row';
    if (t === 'variation') {
      return '[' + i + '] variation | name=' + JSON.stringify(r['Attribute 1 value(s)'])
        + ' | sku=' + JSON.stringify(r.SKU)
        + ' | regular=' + JSON.stringify(r['Regular Price'])
        + ' | images=' + (Array.isArray(r.Images) ? r.Images.length : 0);
    }
    return '[' + i + '] ' + t
      + ' | name=' + JSON.stringify(r.Name)
      + ' | sku=' + JSON.stringify(r.SKU)
      + ' | regular=' + JSON.stringify(r['Regular Price'])
      + ' | categories=' + JSON.stringify(r.Categories)
      + ' | images=' + (Array.isArray(r.Images) ? r.Images.length : 0)
      + ' | desc=' + JSON.stringify((r.Description || '').slice(0, 80));
  }).join('\n');
  return out + (rows.length > 30 ? '\n... and ' + (rows.length - 30) + ' more rows' : '');
}

async function generateScraper({ tabId, url, productType }) {
  const effectiveType = productType === 'variable' ? 'variable' : 'simple';
  cancelRequested = false;
  const ctrl = new AbortController();
  currentGenAbort = ctrl;
  try {
    const html = await getTabHtml(tabId);
    const sample = scraperHtmlSample(html);
    const MAX_TURNS = 6;

    // Agentic loop: the model writes a scraper, we RUN it against the real HTML,
    // then feed the ACTUAL output back so it can see its own result and correct
    // the per-site mapping — instead of a single blind prompt with retries.
    const messages = [
      { role: 'system', content: GENERATE_SYSTEM(effectiveType) },
      { role: 'user', content: 'Product page URL: ' + url + '\n\n' + sample },
    ];

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      if (cancelRequested) return { cancelled: true };
      sendThinking(turn === 1
        ? 'Reading the page and designing a scraper for this site…'
        : 'Reviewing the previous attempt and correcting it…');

      let raw;
      try {
        raw = await callDeepSeek(messages, {
          onReasoning: (r) => sendThinking(trimThinking(r)),
          signal: ctrl.signal,
        });
      } catch (e) {
        if (e && e.cancelled) return { cancelled: true };
        throw e;
      }
      const runBody = stripFences(raw);

      if (!/async\s+function\s+run\s*\(/.test(runBody)) {
        sendThinking('The agent replied without a run() function — asking it to retry…');
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: 'You did not return an "async function run(ctx) { ... }". Reply with ONLY the function definition.' });
        continue;
      }

      sendThinking('Running the generated scraper against the page…');
      const body = buildScraperBody(runBody);
      const res = await runScraperInPage(tabId, body, effectiveType, html);
      if (cancelRequested) return { cancelled: true };

      if (!res.ok) {
        sendThinking('The scraper threw an error — the agent is fixing the code…');
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: 'Your code threw an error:\n' + (res.error || 'unknown error') + '\n\nFix the code and return a corrected run() function.' });
        continue;
      }

      const verdict = evaluateResult(res, effectiveType);
      if (verdict.ok) {
        sendThinking('Scraper works — extracted ' + res.rows.length + ' row' + (res.rows.length === 1 ? '' : 's') + '.');
        return { ok: true, rows: res.rows, title: res.title, body, type: effectiveType };
      }

      // Feed back the real output so the agent sees exactly what it got wrong.
      sendThinking('Scraper ran but the mapping is off: ' + verdict.problem);
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: 'Your scraper ran and returned these rows:\n' + describeRows(res.rows)
          + '\n\nProblem: ' + verdict.problem + '\n\nFix the mapping and return a corrected run() function.',
      });
    }

    throw new Error('Could not generate a working scraper after ' + MAX_TURNS + ' agent turns.');
  } finally {
    if (currentGenAbort === ctrl) currentGenAbort = null;
  }
}

// ── Conversational scraper fixing (chat) ─────────────────────────────────────
// The user talks to the same AI agent in natural language about what's wrong
// with the scraped data. We regenerate the run() function, keeping the page
// sample + the current code + the whole chat history as context, then re-run.
async function chatFixScraper({ tabId, url, productType, feedback, history, body }) {
  const effectiveType = productType === 'variable' ? 'variable' : 'simple';
  cancelRequested = false;
  const ctrl = new AbortController();
  currentGenAbort = ctrl;
  try {
    const html = await getTabHtml(tabId);
    const sample = scraperHtmlSample(html);

    const prior = (history || [])
      .filter(m => m && m.role && m.content)
      .map(m => (m.role === 'assistant' ? 'Agent: ' : 'User: ') + String(m.content))
      .join('\n');

    const messages = [
      { role: 'system', content: GENERATE_SYSTEM(effectiveType) },
      { role: 'user', content: 'Product page URL: ' + url + '\n\n' + sample
        + (body ? '\n\nCurrent scraper code (for reference):\n' + body : '')
        + (prior ? '\n\nConversation so far (for context):\n' + prior : '')
        + '\n\nThe user reports this issue with the scraped data:\n' + feedback
        + '\n\nReturn ONLY a corrected "async function run(ctx) { ... }" (no fences, no explanation). Keep everything that is already correct and fix only what the user reported.'
      },
    ];

    let lastError = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (cancelRequested) return { cancelled: true };
      sendThinking('Updating the scraper based on your message…');
      let raw;
      try {
        raw = await callDeepSeek(messages, { onReasoning: r => sendThinking(trimThinking(r)), signal: ctrl.signal });
      } catch (e) {
        if (e && e.cancelled) return { cancelled: true };
        throw e;
      }
      const runBody = stripFences(raw);
      if (!/async\s+function\s+run\s*\(/.test(runBody)) {
        lastError = 'the model did not return a run() function';
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: 'You did not return an "async function run(ctx) { ... }". Reply with ONLY the function definition.' });
        continue;
      }
      sendThinking('Running the updated scraper against the page…');
      const newBody = buildScraperBody(runBody);
      const res = await runScraperInPage(tabId, newBody, effectiveType, html);
      if (cancelRequested) return { cancelled: true };
      if (res.ok) {
        sendThinking('Updated scraper works.');
        return { ok: true, rows: res.rows, title: res.title, body: newBody };
      }
      lastError = res.error || 'unknown error';
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: 'Your code threw an error:\n' + lastError + '\n\nFix the code and return a corrected run() function.' });
    }
    return { ok: false, error: 'Could not update the scraper: ' + lastError };
  } finally {
    if (currentGenAbort === ctrl) currentGenAbort = null;
  }
}

// ── Save (or update) an AI-generated scraper for a site + product type ───────
// Called when the user taps "Add to scrappers" after the chat. It upserts the
// code under the chosen type (simple/variable), leaving the other type intact.
async function saveScraper({ url, productType, body, example }) {
  const domain = domainOf(url);
  if (!domain) return { ok: false, error: 'Invalid URL.' };
  const effType = productType === 'variable' ? 'variable' : 'simple';
  const existing = await getScraperEntry(domain, effType);
  await saveScraperEntry(domain, effType, {
    brand: (existing && existing.brand) || brandFromDomain(domain),
    example: example || url,
    code: body,
    is_predefined: false,
    verified: true,
  });
  return { ok: true };
}
