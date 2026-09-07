/* MV3 service worker — orchestrates active-tab scraping + WooCommerce calls.
 * Kept intentionally tiny: no heavy modules are loaded at startup, so the
 * worker cold-starts fast and the side panel opens without waiting on it. */

importScripts('supabase.js');

console.log('[Universal Scrapper] service worker v' + (chrome.runtime.getManifest().version || '?') + ' started');

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// One-time migration: older builds stored custom scrapers as an array; reset it.
chrome.storage.local.get('customScrapers').then(({ customScrapers }) => {
  if (Array.isArray(customScrapers) || (customScrapers && typeof customScrapers !== 'object')) {
    chrome.storage.local.set({ customScrapers: {} });
  }
});

// Cancellation of an in-flight AI generation (the user taps "Cancel"
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
      else if (msg.type === 'deepReanalyze') sendResponse(await deepReanalyze(msg));
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

async function callDeepSeek(messages, { json, onReasoning, signal, thinking, timeoutMs, model, reasoningEffort } = {}) {
  const res = await self.Supabase.deepseek(messages, { json, signal, thinking, timeoutMs, model, reasoning_effort: reasoningEffort });
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

// Live "agent thinking" line — shown while the AI works (generation).
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
function simpleRow(o){ return [{ SKU: o.sku||'', Name: o.name||'', Description: o.description||'', 'Short Description': '', 'Regular Price': o.regularPrice||o.price||'', Categories: o.categories||'', Images: o.images||[] }]; }
function variableRows(title, parentImages, description, categories, optionName, variants, optionName2){
  optionName2=optionName2||''; const rows=[]; let rowId=1;
  const a1=[...new Set((variants||[]).map(v=>v.name).filter(Boolean))].join(',');
  const a2=[...new Set((variants||[]).map(v=>v.name2).filter(Boolean))].join(',');
  rows.push({ ID:rowId++, Parent:'', Type:'variable', SKU:'', Name:title, Images:(parentImages||[]).slice(0,4), 'Rey Variations extra images':'', Description:description||'', 'Short Description':'', Categories:categories||'', 'Regular Price':'', 'Attribute 1 name':optionName, 'Attribute 1 value(s)':a1, 'Attribute 1 visible':'1', 'Attribute 1 global':'1', 'Attribute 2 name':optionName2, 'Attribute 2 value(s)':a2, 'Attribute 2 visible':optionName2?'1':'', 'Attribute 2 global':optionName2?'1':'', 'Color Code':'' });
  const parentId=rowId-1;
  for(const v of variants){ rows.push({ ID:rowId++, Parent:'id:'+parentId, Type:'variation', SKU:v.sku||'', Name:title, Images:(v.images&&v.images.length)?[v.images[0]]:[], 'Rey Variations extra images':(v.extras&&v.extras.length)?v.extras:[], Description:'', 'Short Description':'', Categories:'', 'Regular Price':v.regularPrice||'', 'Attribute 1 name':optionName, 'Attribute 1 value(s)':v.name||'', 'Attribute 1 visible':'', 'Attribute 1 global':'1', 'Attribute 2 name':optionName2, 'Attribute 2 value(s)':v.name2||'', 'Attribute 2 visible':'', 'Attribute 2 global':optionName2?'1':'', 'Color Code':v.colorCode||'' }); }
  return rows;
}
// Deterministic JSON-LD reader. JSON-LD is on nearly every e-commerce page, so
// this is a reliable, instant core-extractor that the generator runs FIRST (the
// AI only fills in what JSON-LD doesn't provide, e.g. variants/swatches). It
// walks the JSON-LD graph to find the Product node (including @graph nesting).
function jsonLdCore(ctx, type){
  const html = ctx.mainHtml || '';
  const blocks = ldBlocks(html).map(function(s){ try { return JSON.parse(s); } catch(e){ return null; } }).filter(Boolean);
  let product = null;
  const find = function(node){
    if (!node || typeof node !== 'object' || product) return;
    const t = node['@type'];
    if (t === 'Product' || (Array.isArray(t) && t.indexOf('Product') >= 0)) { product = node; return; }
    const g = node['@graph'];
    if (Array.isArray(g)) { for (let i = 0; i < g.length && !product; i++) find(g[i]); }
  };
  for (let i = 0; i < blocks.length && !product; i++) find(blocks[i]);
  if (!product) return { rows: [], title: '' };
  const name = product.name || '';
  const desc = String(product.description || '').replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim();
  const rawImgs = Array.isArray(product.image) ? product.image : (product.image ? [product.image] : []);
  const imgs = rawImgs.map(normalizeShopUrl).filter(Boolean).slice(0, 4);
  const sku = product.sku || product.mpn || '';
  const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
  const price = (offer && (offer.price || offer.lowPrice)) ? String(offer.price || offer.lowPrice) : '';
  const cats = Array.isArray(product.category) ? product.category.join(', ') : (product.category || '');
  if (type === 'simple') {
    return { rows: simpleRow({ sku: sku, name: name, description: desc, regularPrice: price ? fmtPrice(price) : '', categories: cats, images: imgs }), title: name };
  }
  return { rows: variableRows(name, imgs, desc, cats, 'Option', [], ''), title: name };
}
// Defensive sanitization shims. Some older AI-generated scrapers (or scrapers
// saved by earlier builds) reference sanitizeRows(...) / cleanImageList(...)
// directly. These are defined here so such code still runs instead of throwing
// "sanitizeRows is not defined".
function cleanImageList(arr){ if(!Array.isArray(arr)) return []; return arr.map(function(u){ return String(u==null?'':u).trim(); }).filter(function(u){ return u!=='' && u.indexOf('$')<0 && u.indexOf('{')<0 && u.indexOf('}')<0 && (u.indexOf('http://')===0 || u.indexOf('https://')===0 || u.indexOf('//')===0 || u.indexOf('data:')===0); }); }
function sanitizeRows(rows){ if(!Array.isArray(rows)) return []; if(rows.some(function(r){ return Array.isArray(r); })){ var f=[]; for(var i=0;i<rows.length;i++){ if(Array.isArray(rows[i])) f=f.concat(rows[i]); else f.push(rows[i]); } rows=f; } return rows.map(function(r){ if(!r || typeof r!=='object') return r; var c=Object.assign({},r); if(Array.isArray(c.Images)) c.Images=cleanImageList(c.Images); if(Array.isArray(c['Rey Variations extra images'])) c['Rey Variations extra images']=cleanImageList(c['Rey Variations extra images']); return c; }); }
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
// JSON-LD + INLINE JSON (Next.js __NEXT_DATA__, ShopifyAnalytics, window state,
// "var product = {...}", "data-product_variations", etc.) + a window of visible
// HTML. The inline JSON is where modern stores actually keep product data, so it
// is CRITICAL that we do NOT strip it — the old code removed every <script> and
// starved the model of the very data it was told to read.
function scraperHtmlSample(html) {
  const h = String(html || '');
  const lds = [...h.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n---\n');
  const title = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const og = [...h.matchAll(/<meta[^>]*property="og:([^"]+)"[^>]*content="([^"]*)"[^>]*>/gi)].map(m => 'og:' + m[1] + '=' + m[2]).join('\n');
  const ogTitle = (h.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"[^>]*>/i) || [])[1] || '';

  // Preserve data-bearing inline <script> bodies (NOT JSON-LD — those are above).
  // Heuristic: keep scripts whose content looks like JSON / a product-state
  // assignment; skip trackers, bundles, and empty scripts.
  const inlineJson = [];
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let sm, budget = 24000;
  while ((sm = scriptRe.exec(h)) && budget > 0) {
    const openTag = sm[0].slice(0, 200);
    if (/application\/ld\+json/i.test(openTag)) continue;
    const inner = sm[1].trim();
    if (!inner || inner.length < 8) continue;
    if (/^[{\[]|"product"|"variants"|"offers"|__NEXT_DATA__|__INITIAL_STATE__|ShopifyAnalytics|product_variations|var\s+product|window\.__|dataLayer/i.test(inner)) {
      const chunk = inner.slice(0, Math.min(inner.length, budget, 12000));
      inlineJson.push(chunk);
      budget -= chunk.length;
    }
  }

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

  return 'TITLE: ' + title
    + '\n\nMETA:\n' + og
    + '\n\nJSON-LD BLOCKS:\n' + lds.slice(0, 16000)
    + '\n\nINLINE JSON BLOCKS (product data often lives here — read these first):\n' + (inlineJson.join('\n---\n') || '(none)')
    + '\n\nPRODUCT HTML (around the product area):\n' + windowed;
}

// Larger page sample for "deep thinking" re-analysis. Same structure as
// scraperHtmlSample but with much bigger budgets (more JSON-LD, more inline
// JSON, a wider HTML window) so the reasoning model sees far more of the page.
function deepHtmlSample(html) {
  const h = String(html || '');
  const lds = [...h.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n---\n');
  const title = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const og = [...h.matchAll(/<meta[^>]*property="og:([^"]+)"[^>]*content="([^"]*)"[^>]*>/gi)].map(m => 'og:' + m[1] + '=' + m[2]).join('\n');
  const ogTitle = (h.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"[^>]*>/i) || [])[1] || '';

  const inlineJson = [];
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let sm, budget = 100000;
  while ((sm = scriptRe.exec(h)) && budget > 0) {
    const openTag = sm[0].slice(0, 200);
    if (/application\/ld\+json/i.test(openTag)) continue;
    const inner = sm[1].trim();
    if (!inner || inner.length < 8) continue;
    if (/^[{\[]|"product"|"variants"|"offers"|__NEXT_DATA__|__INITIAL_STATE__|ShopifyAnalytics|product_variations|var\s+product|window\.__|dataLayer/i.test(inner)) {
      const chunk = inner.slice(0, Math.min(inner.length, budget, 40000));
      inlineJson.push(chunk);
      budget -= chunk.length;
    }
  }

  const stripped = h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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
    ? stripped.slice(Math.max(0, anchor - 4000), anchor + 60000)
    : stripped.slice(0, 60000);

  return 'TITLE: ' + title
    + '\n\nMETA:\n' + og
    + '\n\nJSON-LD BLOCKS:\n' + lds.slice(0, 60000)
    + '\n\nINLINE JSON BLOCKS (product data often lives here — read these first):\n' + (inlineJson.join('\n---\n') || '(none)')
    + '\n\nPRODUCT HTML (a large window around the product area):\n' + windowed;
}

// ── Three-phase direct-extraction prompts ─────────────────────────────────────
// The agent is given the page HTML and returns DATA directly (not code) in three
// small, focused calls, so no single call is large enough to time out. Thinking
// stays OFF for speed. Phase 1 = core fields; Phase 2 = variants; Phase 3 = the
// reusable scraper code (saved for future instant scrapes). Each phase is a
// SINGLE call — there is no retry/attempt loop. Short description is NOT
// collected; regular price IS.

const CORE_SYSTEM = `You are an expert product-data extractor. You are given the HTML of a product page. Extract ONLY the core product fields and return them as ONE JSON object.

Return exactly one JSON object (no markdown, no explanation, no code fences) with this shape:
{ "name": "", "description": "", "images": [""], "categories": "", "sku": "", "regularPrice": "" }

- name: the product name.
- description: the main product description text (strip any HTML tags).
- images: up to 4 gallery image URLs, the FIRST being the main photo. Real http(s) URLs only — never a value containing "$" or "{".
- categories: breadcrumb / category labels joined with " > ", or "" if absent.
- sku: the product identifier if present, else "".
- regularPrice: the price as a numeric string (e.g. "220.00"), else "".

HOW TO WORK: read the JSON-LD BLOCKS and INLINE JSON BLOCKS first — on modern stores the name, price, images and description live there. Only if a field is missing there, read the PRODUCT HTML near the title / "add to cart" area. Never return an empty field when the data exists anywhere in the HTML. Decode HTML entities in text.`;

const VARIANTS_SYSTEM = (constraint) => `You are an expert product-data extractor. You are given the HTML of a VARIABLE product page (a product that comes in multiple variants). Extract the attributes and every variant, and return them as ONE JSON object.

Return exactly one JSON object (no markdown, no explanation, no code fences) with this shape:
{ "optionName": "", "optionName2": "", "variants": [ { "name": "", "name2": "", "sku": "", "regularPrice": "", "images": [""], "colorCode": "" } ] }

- optionName: the attribute name (e.g. "Color", "Size"); default "Option".
- optionName2: the SECOND attribute name ONLY if the product varies by more than one attribute (e.g. colour AND size); else "".
- variants: one object per option — INCLUDE out-of-stock / sold-out / disabled options:
  * name: the option value ("Black", "M", "42").
  * name2: the second attribute's value for this option (only for multi-attribute products), else "".
  * sku: that option's own id if present, else "".
  * regularPrice: that option's OWN price as a numeric string; if the page shows one price for all variants, put that price on EACH variant.
  * images: that option's own photos (first = main); [] if it has no distinct photo.
  * colorCode: the colour swatch for this option — a hex colour (e.g. "#000000") if the page gives one, OR the swatch image URL if the option uses an image swatch; else "". CRITICAL: when the product varies by colour, ALWAYS fill colorCode — look for the swatch element's background colour (inline style "background:#hex" or "background-color:#hex") or its background-image URL. This drives colour swatches on import, so do not leave it empty when the page provides it.

HOW TO WORK: read the JSON-LD BLOCKS (offers / hasVariant) and INLINE JSON BLOCKS (e.g. product.variants, data-product_variations) first; otherwise read the swatch buttons / <option> / radio elements in the PRODUCT HTML — swatch colour codes usually live in the swatch element's inline style or a data attribute (e.g. data-color, data-swatch, style="background:#hex"). Real http(s) URLs only. Don't copy one variant's price or photo across all variants.

${constraint ? 'STRICT CONSTRAINT FROM THE USER — this OVERRIDES anything you see in the HTML:\n' + constraint : ''}`;

const CODE_SYSTEM = (type) => `You are an expert web scraper. Write ONE reusable JavaScript function for a Chrome extension that extracts a ${type === 'variable' ? 'variable' : 'simple'} product's data from a product page's HTML.

Return ONLY the function definition (no markdown fences, no explanation):

async function run(ctx) { ... }

ctx.mainHtml is the full page HTML string. Helpers in scope — use them, DO NOT redefine: decodeEntities(s), ldBlocks(html), normalizeShopUrl(src), fmtPrice(p), simpleRow(obj), variableRows(title, parentImages, description, categories, optionName, variants, optionName2).

The correct extracted data for THIS page is shown in the user message below. Write the function so that when it runs against ctx.mainHtml it reproduces that data. Read JSON-LD / inline JSON first, then semantic HTML.

${type === 'simple'
  ? 'Return { rows: simpleRow({ sku, name, description, regularPrice, categories, images }), title }. simpleRow(...) already returns an array — assign it directly, do NOT wrap it in another [ ].'
  : 'Return { rows: variableRows(title, parentImages, description, categories, optionName, variants, optionName2), title }. variableRows(...) already returns an array — assign it directly, do NOT wrap it in another [ ]. Each variant object: { name, name2, sku, regularPrice, images, extras, colorCode }. Include all variants regardless of stock.'}

RULES: pure JS + regex + JSON + the helpers only (no document/window/DOM). fmtPrice() every price. Real http(s) image URLs only.`;

// Runs a generated scraper body in the page's MAIN world. `new Function` (eval)
// is forbidden in MV3 extension pages/service workers (no 'unsafe-eval'), but is
// allowed in the page's own JS context. The page HTML is passed in as an argument
// (already downloaded in the service worker), so the scraper never reads the DOM
// and never depends on the page's own CSP for content.
// NOTE: this function is serialized by chrome.scripting.executeScript and run in
// the page's MAIN world — it can ONLY reference itself (no outer scope), so the
// sanitization helpers are INLINED below as `sanitize` / `cleanImages`.
function evalScraperInMain(code, productType, html) {
  return (async () => {
    // Inlined (self-contained) sanitization: drop placeholder image URLs and
    // flatten an accidental double-wrap, so one bad URL can't block the import.
    const cleanImages = (arr) => {
      if (!Array.isArray(arr)) return [];
      return arr.map((u) => String(u == null ? '' : u).trim()).filter((u) =>
        u !== '' && u.indexOf('$') < 0 && u.indexOf('{') < 0 && u.indexOf('}') < 0 &&
        (u.startsWith('http://') || u.startsWith('https://') || u.startsWith('//') || u.startsWith('data:')));
    };
    const sanitize = (rows) => {
      if (!Array.isArray(rows)) return [];
      if (rows.some((r) => Array.isArray(r))) {
        const flat = [];
        for (const r of rows) { if (Array.isArray(r)) flat.push(...r); else flat.push(r); }
        rows = flat;
      }
      return rows.map((r) => {
        if (!r || typeof r !== 'object') return r;
        const c = Object.assign({}, r);
        for (const k of ['Images', 'Rey Variations extra images']) {
          if (Array.isArray(c[k])) c[k] = cleanImages(c[k]);
        }
        return c;
      });
    };
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
      // When the model returns the wrong shape (no rows array), surface what it
      // actually returned so the agent loop can tell it exactly what went wrong
      // instead of looping on a bare "no rows were produced".
      let debug = '';
      if (!out || !Array.isArray(out.rows) || !out.rows.length) {
        try { debug = JSON.stringify(out).slice(0, 600); } catch (e) { debug = String(out).slice(0, 600); }
      }
      return { ok: true, rows: sanitize((out && out.rows) || []), title: (out && out.title) || '', site: (out && out.site) || '', brand: (out && out.brand) || '', debug };
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

// Parse a JSON object out of an AI reply (it may be wrapped in code fences or
// have stray surrounding prose). Returns the object or null.
function extractJson(raw) {
  const s = stripFences(raw);
  try { return JSON.parse(s); } catch (e) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

// Build a deterministic run body that reconstructs rows from the extracted
// core/variants data. We reuse the existing simpleRow/variableRows helpers so
// the output is normalized exactly like an AI-written scraper, and the rows
// still pass through the inlined `sanitize()` in the injected runner.
function buildDataBody(type, core, variants) {
  const c = JSON.stringify(core || {});
  if (type === 'simple') {
    return 'async function run(ctx){ const d = ' + c + '; return { rows: simpleRow({ sku: d.sku || \'\', name: d.name || \'\', description: d.description || \'\', regularPrice: d.regularPrice || \'\', categories: d.categories || \'\', images: Array.isArray(d.images) ? d.images : [] }), title: d.name || \'\' }; }';
  }
  const v = JSON.stringify(variants || {});
  return 'async function run(ctx){ const d = ' + c + '; const v = ' + v + '; const vars = (Array.isArray(v.variants) ? v.variants : []).map(function(x){ return { name: x.name || \'\', name2: x.name2 || \'\', sku: x.sku || \'\', regularPrice: x.regularPrice || \'\', images: Array.isArray(x.images) ? x.images : [], extras: Array.isArray(x.extras) ? x.extras : [], colorCode: x.colorCode || \'\' }; }); return { rows: variableRows(d.name || \'\', Array.isArray(d.images) ? d.images : [], d.description || \'\', d.categories || \'\', v.optionName || \'Option\', vars, v.optionName2 || \'\'), title: d.name || \'\' }; }';
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

// ── Three-step generation (no retry loop) ─────────────────────────────────────
// The AI reads the HTML and returns data directly, in three small single-shot
// calls (each far under the timeout), with thinking disabled for speed:
//   Step 1 — core fields (name, description, images, price, categories, sku)
//   Step 2 — variants (variable products only)
//   Step 3 — a reusable run() scraper, written from the data above, for saving.

// Build a STRICT constraint from the user's attribute-config answers (how many
// attributes, and their names). Injected into the variants system prompt AND
// enforced deterministically after extraction, so the user's choice always wins.
function buildAttrConstraint(count, attr1, attr2) {
  const lines = [];
  if (count === 1) {
    lines.push('This product has EXACTLY ONE attribute. Do NOT return a second attribute.');
    if (attr1) lines.push('That single attribute is named "' + attr1 + '" — set optionName to exactly "' + attr1 + '", leave optionName2 EMPTY, and leave every variant\'s name2 EMPTY.');
  } else if (count === 2) {
    lines.push('This product has EXACTLY TWO attributes.');
    if (attr1) lines.push('Attribute 1 is "' + attr1 + '" — set optionName to exactly "' + attr1 + '".');
    if (attr2) lines.push('Attribute 2 is "' + attr2 + '" — set optionName2 to exactly "' + attr2 + '".');
  }
  if (!lines.length) return '';
  return lines.join('\n');
}

// Deterministic safety net: force the extracted variants to match the user's
// attribute count/names, so even if the model ignores the prompt the result is
// still correct. "1 attribute" blanks the second attribute entirely.
function enforceAttrConstraint(variants, count, attr1, attr2) {
  if (!variants || typeof variants !== 'object') return variants;
  const v = Object.assign({}, variants);
  if (count === 1) {
    if (attr1) v.optionName = attr1;
    v.optionName2 = '';
    if (Array.isArray(v.variants)) {
      v.variants = v.variants.map((x) => Object.assign({}, x, { name2: '' }));
    }
  } else if (count === 2) {
    if (attr1) v.optionName = attr1;
    if (attr2) v.optionName2 = attr2;
  }
  return v;
}

async function generateScraper({ tabId, url, productType, attrCount, attr1, attr2 }) {
  const effectiveType = productType === 'variable' ? 'variable' : 'simple';
  cancelRequested = false;
  const ctrl = new AbortController();
  currentGenAbort = ctrl;
  try {
    const html = await getTabHtml(tabId);
    const sample = scraperHtmlSample(html);
    const ctxUser = 'Product page URL: ' + url + '\n\n' + sample;

    // STEP 1 — core fields (single call).
    sendThinking('Step 1/3: reading name, description, images and price…');
    const coreRaw = await callDeepSeek([
      { role: 'system', content: CORE_SYSTEM },
      { role: 'user', content: ctxUser },
    ], { signal: ctrl.signal });
    if (cancelRequested) return { cancelled: true };
    const core = extractJson(coreRaw);
    if (!core) throw new Error('The AI did not return valid core fields. Please try again.');

    // STEP 2 — variants (variable only; single call).
    let variants = null;
    if (effectiveType === 'variable') {
      sendThinking('Step 2/3: reading variants and attributes…');
      const constraint = buildAttrConstraint(attrCount, attr1, attr2);
      const varRaw = await callDeepSeek([
        { role: 'system', content: VARIANTS_SYSTEM(constraint) },
        { role: 'user', content: ctxUser },
      ], { signal: ctrl.signal });
      if (cancelRequested) return { cancelled: true };
      variants = extractJson(varRaw);
      if (!variants || !Array.isArray(variants.variants) || !variants.variants.length) {
        throw new Error('The AI could not find variants for this product. It may actually be a simple product.');
      }
      variants = enforceAttrConstraint(variants, attrCount, attr1, attr2);
    }

    // Reconstruct normalized rows from the extracted data (deterministic, and
    // still passes through the inlined `sanitize()` in the injected runner).
    sendThinking('Building the product table…');
    const dataBody = buildDataBody(effectiveType, core, variants);
    const dataRun = buildScraperBody(dataBody);
    const dataRes = await runScraperInPage(tabId, dataRun, effectiveType, html);
    if (cancelRequested) return { cancelled: true };
    if (!dataRes.ok) throw new Error(dataRes.error || 'Could not build the product rows.');
    const rows = dataRes.rows || [];
    if (!rows.length) throw new Error('No product data was produced.');

    // STEP 3 — reusable scraper code (single call), written from the data.
    sendThinking('Step 3/3: writing the reusable scraper…');
    const codeRaw = await callDeepSeek([
      { role: 'system', content: CODE_SYSTEM(effectiveType) },
      { role: 'user', content: ctxUser + '\n\nCorrect extracted data:\n' + JSON.stringify(rows) },
    ], { signal: ctrl.signal });
    if (cancelRequested) return { cancelled: true };
    const runBody = stripFences(codeRaw);
    const body = /async\s+function\s+run\s*\(/.test(runBody) ? buildScraperBody(runBody) : dataBody;

    return { ok: true, rows, title: dataRes.title || core.name || '', body, type: effectiveType };
  } finally {
    if (currentGenAbort === ctrl) currentGenAbort = null;
  }
}

// ── Conversational scraper chat ──────────────────────────────────────────────
// A real, multi-turn assistant the user talks to in natural language. It can
// answer questions AND, when the user asks for a data change, rewrite the
// scraper and re-run it to update the table. Reasoning ("thinking") is ON and
// the FULL conversation is threaded into every call, so it remembers context
// like a real colleague — no rigid prompt or fixed format from the user.
const CHAT_SYSTEM = (type) => `You are a friendly, expert scraper engineer chatting live with a user who just scraped a ${type === 'variable' ? 'variable' : 'simple'} product and wants to discuss or fix the results.

You receive each turn: the product page HTML, the current scraper code, the current scraped data (what the table shows), and the full conversation so far. You remember everything already said.

Behave like a real, natural colleague:
- Read what the user actually said and respond in plain, conversational prose. Never give a canned or scripted reply.
- You can answer questions, explain what you found in the data, or ask ONE short clarifying question when their report is ambiguous.
- You only need to change the scraper when the user wants the DATA changed. When you are confident a change is needed, write the FULL corrected run() function in a single fenced javascript code block, and briefly say what you fixed and why.
- Reason carefully over the page and the current data before deciding.

The corrected scraper must return { rows, title }, building rows ONLY via simpleRow(...) (simple) or variableRows(...) (variable). Use only pure JS + regex + JSON + the helpers (no document/window/DOM). Real http(s) image URLs only — never a value containing "$", "{" or "}" as an image URL. Short descriptions are NOT collected.

Helpers in scope (do NOT redefine them): decodeEntities(s), ldBlocks(html), normalizeShopUrl(src), fmtPrice(p), simpleRow(obj), variableRows(title, parentImages, description, categories, optionName, variants, optionName2).

When you change the scraper, wrap the full function like:
\`\`\`javascript
async function run(ctx) { ... }
\`\`\``;

// Parse the agent's natural reply into { reply, code }. We extract a corrected
// run() function IF the model wrote one (inside a fenced code block or as a
// bare function), and treat everything else as the conversational reply.
function parseChatReply(text) {
  const s = String(text || '').trim();
  let code = '';
  let reply = s;

  const fence = s.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
  if (fence && /async\s+function\s+run\s*\(/.test(fence[1])) {
    code = fence[1];
    reply = (s.slice(0, fence.index) + ' ' + s.slice(fence.index + fence[0].length)).trim();
  } else if (/async\s+function\s+run\s*\(/.test(s)) {
    code = s;
    reply = '';
  }

  code = code.replace(/^\s*```[\w]*\s*/i, '').replace(/\s*```\s*$/, '').trim();
  if (/^NONE$/i.test(code)) code = '';
  return { reply: reply || '', code };
}

async function chatFixScraper({ tabId, url, productType, body, rows, history, message }) {
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

    const currentDump = (Array.isArray(rows) && rows.length) ? describeRows(rows) : '(no data yet)';

    const messages = [
      { role: 'system', content: CHAT_SYSTEM(effectiveType) },
      { role: 'user', content: 'Product page URL: ' + url + '\n\n' + sample
        + (body ? '\n\nCurrent scraper code (for reference):\n' + body : '')
        + '\n\nCurrent scraped data (what the table shows):\n' + currentDump
        + (prior ? '\n\nConversation so far (for memory):\n' + prior : '')
        + '\n\nThe user just said:\n' + (message || '')
      },
    ];

    if (cancelRequested) return { cancelled: true };
    sendThinking('The agent is thinking…');

    // Reasoning ON with the frontier model (deepseek-v4-pro) so the agent truly
    // thinks and analyses the table, not just replies fast. Bounded timeout, live
    // "thinking" feed. On timeout we re-issue the SAME message once (full history
    // + context is already in it), so the agent resumes where it stopped.
    const deepCall = () => callDeepSeek(messages, {
      signal: ctrl.signal,
      thinking: true,
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
      timeoutMs: 90000,
      onReasoning: (r) => sendThinking(trimThinking(r)),
    });
    let raw;
    try {
      raw = await deepCall();
    } catch (e) {
      if (e && e.cancelled) return { cancelled: true };
      if (/timed out/i.test(e.message || '')) {
        sendThinking('Thinking stalled — resuming from where it stopped…');
        raw = await deepCall();
      } else {
        throw e;
      }
    }
    if (cancelRequested) return { cancelled: true };

    const { reply, code } = parseChatReply(raw);

    // No corrected code → it was just answering / asking / explaining.
    if (!code) {
      return { ok: true, reply: reply || 'Understood.', changed: false };
    }

    const runBody = stripFences(code);
    if (!/async\s+function\s+run\s*\(/.test(runBody)) {
      return { ok: false, error: 'The agent produced invalid scraper code — please ask it again.' };
    }

    sendThinking('Running the updated scraper against the page…');
    const newBody = buildScraperBody(runBody);
    const res = await runScraperInPage(tabId, newBody, effectiveType, html);
    if (cancelRequested) return { cancelled: true };
    if (!res.ok) {
      const note = reply
        ? reply + '\n\nHeads-up: I tried to apply that change, but the scraper threw an error — ' + (res.error || 'unknown') + '. Tell me to fix it and I will.'
        : 'I tried to update the scraper, but it threw an error: ' + (res.error || 'unknown') + '.';
      return { ok: true, reply: note, changed: false };
    }

    return { ok: true, reply: reply || 'Done.', changed: true, rows: res.rows, title: res.title, body: newBody };
  } finally {
    if (currentGenAbort === ctrl) currentGenAbort = null;
  }
}

// ── Deep re-analysis (reasoning enabled) ─────────────────────────────────────
// Re-runs extraction with chain-of-thought ON and a much larger page sample, so
// the model reasons over the whole page and corrects what the fast pass missed.
//
// TIMEOUT / "keep him warm" strategy — DeepSeek is stateless, so "keeping the
// agent warm" is done by (a) splitting the work into small checkpointed calls
// that each finish far under the wall-clock limit, and (b) threading the full
// context + prior findings into every call so a fresh call "remembers" exactly
// where the last one stopped. If a step times out we re-issue ONLY that step
// with the same accumulated context — nothing already extracted is lost, and
// the model never restarts from scratch.
async function deepReanalyze({ tabId, url, productType }) {
  const effectiveType = productType === 'variable' ? 'variable' : 'simple';
  cancelRequested = false;
  const ctrl = new AbortController();
  currentGenAbort = ctrl;
  try {
    const html = await getTabHtml(tabId);
    const ctxUser = 'Product page URL: ' + url + '\n\n' + deepHtmlSample(html);

    // Deep call: reasoning on, bounded 60s timeout, live "thinking" feed.
    const deep = (system, user) => callDeepSeek([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { signal: ctrl.signal, thinking: true, timeoutMs: 60000, onReasoning: (r) => sendThinking(trimThinking(r)) });

    // A step that may time out: on timeout, resume once with the same context.
    const withResume = async (system, user) => {
      try { return await deep(system, user); }
      catch (e) {
        if (e && e.cancelled) throw e;
        sendThinking('Deep thinking stalled — resuming from where it stopped…');
        return await deep(system, user);
      }
    };

    // STEP 1 — core fields (checkpoint 1).
    sendThinking('Deep 1/3: analyzing name, description, images and price…');
    const core = extractJson(await withResume(CORE_SYSTEM, ctxUser));
    if (cancelRequested) return { cancelled: true };
    if (!core) throw new Error('Deep thinking could not read the core fields.');

    // STEP 2 — variants (checkpoint 2, threaded with core so it stays "warm").
    let variants = null;
    if (effectiveType === 'variable') {
      sendThinking('Deep 2/3: analyzing variants and attributes…');
      variants = extractJson(await withResume(VARIANTS_SYSTEM(''), ctxUser + '\n\nCore data already found (keep it, only add/fix variants):\n' + JSON.stringify(core)));
      if (cancelRequested) return { cancelled: true };
      if (!variants || !Array.isArray(variants.variants) || !variants.variants.length) {
        throw new Error('Deep thinking could not find variants. It may be a simple product.');
      }
    }

    // Rebuild the table from the corrected data.
    sendThinking('Deep thinking: rebuilding the corrected table…');
    const dataBody = buildDataBody(effectiveType, core, variants);
    const dataRun = buildScraperBody(dataBody);
    const dataRes = await runScraperInPage(tabId, dataRun, effectiveType, html);
    if (cancelRequested) return { cancelled: true };
    if (!dataRes.ok) throw new Error(dataRes.error || 'Could not build the product rows.');

    // STEP 3 — regenerate the reusable scraper code from the corrected data.
    sendThinking('Deep 3/3: writing the corrected scraper…');
    const codeRaw = await callDeepSeek([
      { role: 'system', content: CODE_SYSTEM(effectiveType) },
      { role: 'user', content: ctxUser + '\n\nCorrect extracted data:\n' + JSON.stringify(dataRes.rows) },
    ], { signal: ctrl.signal });
    if (cancelRequested) return { cancelled: true };
    const runBody = stripFences(codeRaw);
    const body = /async\s+function\s+run\s*\(/.test(runBody) ? buildScraperBody(runBody) : dataBody;

    return { ok: true, rows: dataRes.rows, title: dataRes.title || core.name || '', body, type: effectiveType };
  } finally {
    if (currentGenAbort === ctrl) currentGenAbort = null;
  }
}

// ── Save (or update) an AI-generated scraper for a site + product type ───────
// Called when the user taps "Add to scrappers". It upserts the
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
