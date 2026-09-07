'use strict';

const VARIABLE_COLUMNS = ['ID','Parent','Type','SKU','Name','Images','Description','Regular Price','Attribute 1 name','Attribute 1 value(s)','Attribute 2 name','Attribute 2 value(s)','Attribute 1 visible','Attribute 1 global','Color Code','Rey Swatches'];
const SIMPLE_COLUMNS = ['SKU','Name','Description','Regular Price','Images'];

let currentRows = [];
let currentType = 'variable';
let COLUMNS = VARIABLE_COLUMNS;
let editingStoreId = null;
let selectedIds = new Set();

// ── New scraper workflow state ────────────────────────────────────────────────
let currentDomain = '';       // domain of the active tab
let currentHasSimple = false; // whether a simple scraper exists for it
let currentHasVariable = false; // whether a variable scraper exists for it
let pendingType = '';         // 'simple' | 'variable' for the AI scraper being built
let pendingBody = '';         // the generated (unsaved) scraper code
let pendingUrl = '';          // URL used for generation
let pendingAttr = { count: null, attr1: '', attr2: '' }; // attribute hints for variable scrapers
let chatHistory = [];         // [{role:'user'|'agent', content}] for the fix chat

const $ = id => document.getElementById(id);
const escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// I── Tabs (Products / Stores / Websites) I───────────────────────────
document.querySelectorAll('.sp-tab').forEach(btn => btn.addEventListener('click', () => {
  const tab = btn.dataset.tab;
  document.querySelectorAll('.sp-tab').forEach(b => b.classList.toggle('active', b === btn));
  $('panel-products').classList.toggle('hidden', tab !== 'products');
  $('panel-stores').classList.toggle('hidden', tab !== 'stores');
  $('panel-websites').classList.toggle('hidden', tab !== 'websites');
  if (tab === 'stores') renderStores();
  if (tab === 'websites') renderBrands();
}));

// ═══ Product type (auto-detected from the scrape result) ══════════════════════
function setType(t) {
  currentType = t;
  COLUMNS = t === 'simple' ? SIMPLE_COLUMNS : VARIABLE_COLUMNS;
}

// ═══ Active-tab detection ═════════════════════════════════════════════════════
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

// ═══ Scraper status detection (does this website already have a scraper?) ═══
function domainOfUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

async function refreshScraperStatus() {
  const tab = await activeTab();
  if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return;
  const domain = domainOfUrl(tab.url);
  if (!domain) return;
  currentDomain = domain;
  let hasSimple = false, hasVariable = false;
  try {
    const rows = self.Supabase ? await self.Supabase.listScrapersForDomain(domain) : [];
    if (Array.isArray(rows)) {
      hasSimple = rows.some(r => r.type === 'simple');
      hasVariable = rows.some(r => r.type === 'variable');
    }
  } catch (e) {}
  currentHasSimple = hasSimple;
  currentHasVariable = hasVariable;
  updateHeroButtons();
}

function updateHeroButtons() {
  const scrapeVariable = $('scrape-variable-btn');
  const scrapeSimple = $('scrape-simple-btn');
  const addVariable = $('add-variable-btn');
  const addSimple = $('add-simple-btn');
  const addGeneric = $('add-scraper-btn');

  // A site with a scraper for BOTH types shows two "Scrape" buttons.
  // A site with only ONE type shows that "Scrape" button + an "Add the other" button.
  // A site with NO scraper shows the generic "Add Scrapper" button.
  if (currentHasVariable && currentHasSimple) {
    scrapeVariable.classList.remove('hidden');
    scrapeSimple.classList.remove('hidden');
    addVariable.classList.add('hidden');
    addSimple.classList.add('hidden');
    addGeneric.classList.add('hidden');
  } else if (currentHasVariable) {
    scrapeVariable.classList.remove('hidden');
    scrapeSimple.classList.add('hidden');
    addVariable.classList.add('hidden');
    addSimple.classList.remove('hidden'); // add the missing simple scraper
    addGeneric.classList.add('hidden');
  } else if (currentHasSimple) {
    scrapeVariable.classList.add('hidden');
    scrapeSimple.classList.remove('hidden');
    addVariable.classList.remove('hidden'); // add the missing variable scraper
    addSimple.classList.add('hidden');
    addGeneric.classList.add('hidden');
  } else {
    scrapeVariable.classList.add('hidden');
    scrapeSimple.classList.add('hidden');
    addVariable.classList.add('hidden');
    addSimple.classList.add('hidden');
    addGeneric.classList.remove('hidden');
  }
}

// Reset transient state before starting a fresh scrape / generation.
function resetForNewScrape() {
  hideSaveRow();
  hideTypeSelector();
  hideAttrConfig();
  hideChat();
  hideAgentWorking();
  pendingBody = '';
  pendingType = '';
  pendingUrl = '';
  pendingAttr = { count: null, attr1: '', attr2: '' };
  chatHistory = [];
}

// ═══ Scrape (existing scraper) ═══════════════════════════════════════════════
async function scrapeWithType(productType) {
  const tab = await activeTab();
  if (!tab) return status('error', 'No active tab.');
  resetForNewScrape();
  $('hero-title').classList.add('hidden');
  $('panel-products').classList.add('has-results');
  $('hero').classList.remove('hero-error');
  runScrape({ mode: 'active', productType, tabId: tab.id, url: tab.url });
}

$('scrape-variable-btn').addEventListener('click', () => scrapeWithType('variable'));
$('scrape-simple-btn').addEventListener('click', () => scrapeWithType('simple'));

// ═══ Add Scrapper (AI) ═══════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'agentThinking') setAgentThought(msg.text || '');
});

function setAgentThought(text) {
  const el = $('agent-thought');
  if (!el) return;
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = text;
  el.classList.remove('hidden');
}

function showAgentWorking() { $('agent-working').classList.remove('hidden'); setAgentThought(''); }
function hideAgentWorking() { $('agent-working').classList.add('hidden'); setAgentThought(''); }

// Cancel while the agent is working (generation).
$('agent-cancel-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'cancelGenerate' });
  status('warn', 'Cancelling…');
});

// Clicking "Add Scrapper" (no scraper exists) asks whether the product is simple or variable.
$('add-scraper-btn').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return status('error', 'No active tab.');
  resetForNewScrape();
  $('hero-title').classList.add('hidden');
  $('panel-products').classList.add('has-results');
  $('hero').classList.remove('hero-error');
  showTypeSelector();
});

// Clicking "Add variable Scrapper" / "Add simple Scrapper" (the OTHER type is
// missing) skips the selector and goes straight to generation of that type.
$('add-variable-btn').addEventListener('click', () => beginAddScraper('variable'));
$('add-simple-btn').addEventListener('click', () => beginAddScraper('simple'));

function beginAddScraper(type) {
  resetForNewScrape();
  $('hero-title').classList.add('hidden');
  $('panel-products').classList.add('has-results');
  $('hero').classList.remove('hero-error');
  startAddScraper(type);
}

function showTypeSelector() {
  $('type-selector').classList.remove('hidden');
  $('add-scraper-btn').classList.add('hidden');
}
function hideTypeSelector() { $('type-selector').classList.add('hidden'); }

$('type-simple-btn').addEventListener('click', () => startAddScraper('simple'));
$('type-variable-btn').addEventListener('click', () => showAttrConfig());

// ═══ Attribute config (variable products) — optional step ═════════════════════
function showAttrConfig() {
  $('type-selector').classList.add('hidden');
  $('attr-config').classList.remove('hidden');
  $('attr-name-1').classList.add('hidden');
  $('attr-name-2').classList.add('hidden');
  $('attr-done-btn').classList.add('hidden');
  $('attr-count-1-btn').classList.remove('selected');
  $('attr-count-2-btn').classList.remove('selected');
  $('attr-name-1-input').value = '';
  $('attr-name-2-input').value = '';
  clearChips(1);
  clearChips(2);
}
function hideAttrConfig() { $('attr-config').classList.add('hidden'); }

function clearChips(n) {
  document.querySelectorAll('.chip[data-attr="' + n + '"]').forEach(c => c.classList.remove('selected'));
}

function setAttrCount(n) {
  pendingAttr.count = n;
  $('attr-name-1').classList.toggle('hidden', n < 1);
  $('attr-name-2').classList.toggle('hidden', n < 2);
  $('attr-done-btn').classList.remove('hidden');
  $('attr-count-1-btn').classList.toggle('selected', n === 1);
  $('attr-count-2-btn').classList.toggle('selected', n === 2);
}

document.querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => {
  const n = Number(chip.dataset.attr);
  clearChips(n);
  chip.classList.add('selected');
  $('attr-name-' + n + '-input').value = chip.dataset.name;
}));

document.querySelectorAll('.attr-name-input').forEach(inp => inp.addEventListener('input', () => {
  // Manual typing overrides the chip selection.
  const n = inp.id === 'attr-name-1-input' ? 1 : 2;
  clearChips(n);
}));

$('attr-count-1-btn').addEventListener('click', () => setAttrCount(1));
$('attr-count-2-btn').addEventListener('click', () => setAttrCount(2));

$('attr-skip-btn').addEventListener('click', () => {
  pendingAttr = { count: null, attr1: '', attr2: '' };
  startAddScraper('variable', pendingAttr);
});

$('attr-done-btn').addEventListener('click', () => {
  pendingAttr.attr1 = $('attr-name-1-input').value.trim();
  pendingAttr.attr2 = $('attr-name-2-input').value.trim();
  startAddScraper('variable', pendingAttr);
});

async function startAddScraper(type, attr) {
  const tab = await activeTab();
  if (!tab) return status('error', 'No active tab.');
  hideTypeSelector();
  hideAttrConfig();
  pendingType = type;
  pendingUrl = tab.url;
  hideSaveRow();
  showAgentWorking();
  status('loading', 'The AI is building a ' + (type === 'variable' ? 'variable' : 'simple') + ' scraper for this site…');
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'generateScraper',
      tabId: tab.id,
      url: tab.url,
      productType: type,
      attrCount: attr && attr.count != null ? attr.count : null,
      attr1: attr && attr.attr1 ? attr.attr1 : '',
      attr2: attr && attr.attr2 ? attr.attr2 : '',
    });
    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
    if (res && res.cancelled) { hideAgentWorking(); status('warn', 'Cancelled.'); return; }
    if (!res || !res.ok) throw new Error((res && res.error) || 'Generation failed');
    pendingBody = res.body || '';
    currentRows = res.rows || [];
    // Trust the user's explicit choice (not row sniffing) for the table type.
    setType(pendingType === 'variable' ? 'variable' : 'simple');
    hideAgentWorking();
    $('status').classList.add('hidden');
    renderResults(res.title || '');
    showSaveRow();
    openChat();
  } catch (e) {
    hideAgentWorking();
    status('error', e.message);
  }
}

function status(type, msg) { const el = $('status'); el.className = `status ${type}`; el.textContent = msg; el.classList.remove('hidden'); }

// ═══ Conversational chat to fix the scraped data ══════════════════════════════
function openChat() {
  if (!pendingBody) return;
  $('chat-panel').classList.remove('hidden');
  $('chat-panel').classList.remove('collapsed');
  $('chat-messages').innerHTML = '';
  chatHistory = [];
  addChatMessage('agent', 'I scraped this ' + (pendingType === 'variable' ? 'variable' : 'simple') + ' product — the table shows what I found. Tell me what you need and I\'ll fix it.');
  $('chat-status').className = 'status hidden';
  $('chat-input').focus();
}

function hideChat() {
  $('chat-panel').classList.add('hidden');
}

// Fold / unfold the chat panel via its header (and the toggle button).
$('chat-toggle').addEventListener('click', () => {
  $('chat-panel').classList.toggle('collapsed');
});
$('chat-toggle-btn').addEventListener('click', (e) => {
  e.stopPropagation(); // the header click already toggles; avoid double-toggle
  $('chat-panel').classList.toggle('collapsed');
});

function addChatMessage(role, content) {
  const wrap = $('chat-messages');
  if (!wrap) return;
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.textContent = content;
  div.appendChild(bubble);
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function chatStatus(type, msg) {
  const el = $('chat-status');
  if (type === 'hidden') { el.className = 'status hidden'; el.textContent = ''; return; }
  el.className = `status ${type}`;
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function sendChat() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (!pendingBody) return;
  input.value = '';
  addChatMessage('user', text);
  chatHistory.push({ role: 'user', content: text });
  chatStatus('loading', 'The agent is thinking…');
  $('chat-send-btn').disabled = true;
  try {
    const tab = await activeTab();
    if (!tab) throw new Error('No active tab.');
    const res = await chrome.runtime.sendMessage({
      type: 'chatFixScraper',
      tabId: tab.id,
      url: pendingUrl || tab.url,
      productType: pendingType,
      body: pendingBody,
      rows: currentRows,
      history: chatHistory.slice(0, -1),
      message: text,
    });
    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
    if (res && res.cancelled) { chatStatus('warn', 'Cancelled.'); return; }
    if (!res || !res.ok) throw new Error((res && res.error) || 'The agent could not reply');

    if (res.changed) {
      pendingBody = res.body || pendingBody;
      currentRows = res.rows || [];
      setType(pendingType === 'variable' ? 'variable' : 'simple');
      renderResults(res.title || '');
    }

    const reply = res.reply || 'Done.';
    chatHistory.push({ role: 'agent', content: reply });
    addChatMessage('agent', reply);
    chatStatus('hidden');
  } catch (e) {
    chatStatus('error', e.message);
  } finally {
    $('chat-send-btn').disabled = false;
  }
}

$('chat-send-btn').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

// ═══ Save row (shown after the AI scraper is generated) ══════════════════════
function showSaveRow() { $('save-row').classList.remove('hidden'); }
function hideSaveRow() { $('save-row').classList.add('hidden'); }

// ═══ Add to scrappers (save) ══════════════════════════════════════════════════
$('add-to-scrapers-btn').addEventListener('click', async () => {
  if (!pendingBody || !pendingType) return status('error', 'Nothing to save.');
  status('loading', 'Saving scraper…');
  try {
    const tab = await activeTab();
    const url = pendingUrl || (tab && tab.url) || '';
    const res = await chrome.runtime.sendMessage({
      type: 'saveScraper',
      url,
      productType: pendingType,
      body: pendingBody,
      example: url,
    });
    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
    if (!res || !res.ok) throw new Error((res && res.error) || 'Save failed');
    hideSaveRow();
    status('success', 'Scraper added for this website (' + pendingType + ').');
    brandsRendered = false;
    await refreshScraperStatus();
  } catch (e) {
    status('error', e.message);
  }
});

// "Cancel" beside "Add to scrappers" — abandons the AI scraper and returns to
// the initial hero state.
$('cancel-scraper-btn').addEventListener('click', resetToHero);

function resetToHero() {
  hideSaveRow();
  hideTypeSelector();
  hideAttrConfig();
  hideChat();
  hideAgentWorking();
  pendingBody = '';
  pendingType = '';
  pendingUrl = '';
  currentRows = [];
  chatHistory = [];
  $('results').classList.add('hidden');
  $('type-badge').classList.add('hidden');
  $('status').classList.add('hidden');
  $('hero-title').classList.remove('hidden');
  $('panel-products').classList.remove('has-results');
  $('hero').classList.remove('hero-error');
  refreshScraperStatus();
}

function brandFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const brands = (self.BrandCatalog && self.BrandCatalog.brands) || [];
    const hit = brands.find(b => host === b.domain || host.endsWith('.' + b.domain));
    if (hit) return hit.name;
  } catch (e) {}
  return '';
}

async function runScrape(req) {
  $('results').classList.add('hidden');
  $('type-badge').classList.add('hidden');
  status('loading', 'Scraping…');
  try {
    const res = await chrome.runtime.sendMessage(Object.assign({ type: 'scrape' }, req));
    if (!res || !res.ok) throw new Error((res && res.error) || 'Scrape failed');
    currentRows = res.rows || [];
    // Auto-detect product type: rows with a Type field are variable, otherwise simple
    if (currentRows.length > 0) {
      setType(currentRows[0].hasOwnProperty('Type') ? 'variable' : 'simple');
    }
    const brand = res.brand || brandFromUrl(req.url || '');
    // Show the detected type only for known/listed sites.
    if (brand && currentRows.length > 0) {
      const badge = $('type-badge');
      badge.textContent = currentType === 'simple' ? 'Simple product' : 'Variable product';
      badge.classList.remove('hidden');
    }
    $('status').classList.add('hidden');
    renderResults(res.title || '');
    return true;
  } catch (e) {
    if (/cannot access/i.test(e.message || '')) {
      $('hero-title').classList.remove('hidden');
      $('panel-products').classList.remove('has-results');
      $('hero').classList.add('hero-error');
    }
    status('error', e.message);
    return false;
  }
}

// ═══ Rey Swatches ═════════════════════════════════════════════════════════════
function buildReySwatches(parentRow, rows) {
  rows = rows || currentRows;
  if (!parentRow) return '';
  const attrName = (parentRow['Attribute 1 name'] || 'Color').toLowerCase();
  const parentRef = `id:${parentRow.ID}`;
  const variations = rows.filter(r => r.Type === 'variation' && r.Parent === parentRef);
  // Swatches are driven by the DATA, not the attribute name: if any variant
  // carries a hex code or a swatch image URL, this is a swatched attribute.
  const hasImage = variations.some(v => (v['Color Code'] || '').trim().startsWith('http'));
  const hasHex = variations.some(v => (v['Color Code'] || '').trim().startsWith('#'));
  if (!hasImage && !hasHex) return '';
  const terms = {};
  for (const v of variations) {
    const colorName = v['Attribute 1 value(s)'];
    const cc = (v['Color Code'] || '').trim();
    if (!colorName) continue;
    terms[colorName] = hasImage
      ? { name: colorName, rey_attribute_image: cc }
      : { name: colorName, rey_attribute_color: cc || '#000000' };
  }
  if (hasImage) return JSON.stringify({ Image: { name: 'Image', type: 'rey_image', terms } });
  // Hex swatches: use the attribute name when it's meaningful, else fall back
  // to "color" (so generic names like "option" still produce color swatches).
  const key = (attrName && attrName !== 'option') ? attrName : 'color';
  return JSON.stringify({ [key]: { name: key, type: 'rey_color', terms } });
}

// ═══ Render results table ═════════════════════════════════════════════════════
function cellValue(col, row, rows) {
  if (col === 'Images' || col === 'Rey Variations extra images') {
    const v = row[col]; const a = Array.isArray(v) ? v : (v ? [v] : []);
    return a.join(', ');
  }
  if (col === 'Rey Swatches') return row.Type === 'variable' ? buildReySwatches(row, rows || currentRows) : '';
  return String(row[col] == null ? '' : row[col]);
}

function tsvOf(columns, rows) {
  const clean = v => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
  return [columns.join('\t'), ...rows.map(r => columns.map(c => clean(cellValue(c, r, rows))).join('\t'))].join('\n');
}
function csvOf(columns, rows) {
  const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.map(esc).join(','), ...rows.map(r => columns.map(c => {
    if (c === 'Images' || c === 'Rey Variations extra images') {
      const v = r[c]; const a = Array.isArray(v) ? v : (v ? [v] : []);
      return esc(a.join('|'));
    }
    return esc(cellValue(c, r, rows));
  }).join(','))].join('\n');
}
function downloadCsvFile(csv, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name || `products-${Date.now()}.csv`;
  a.click();
}
function variationIdList() { return currentRows.filter(r => r.Type === 'variation').map(r => String(r.ID)); }
function exportRows() {
  if (currentType !== 'variable') return currentRows;
  const kept = currentRows.filter(r => r.Type !== 'variation' || selectedIds.has(String(r.ID)));
  return kept.map(r => {
    if (r.Type !== 'variable') return r;
    const ref = `id:${r.ID}`;
    const variations = kept.filter(x => x.Type === 'variation' && x.Parent === ref);
    const names = [...new Set(variations.map(x => x['Attribute 1 value(s)']).filter(Boolean))];
    const names2 = [...new Set(variations.map(x => x['Attribute 2 value(s)']).filter(Boolean))];
    return Object.assign({}, r, { 'Attribute 1 value(s)': names.join(','), 'Attribute 2 value(s)': names2.join(',') });
  });
}
function updateResultCount() {
  const total = variationIdList().length;
  $('result-count').textContent = (currentType === 'variable' && total)
    ? `${selectedIds.size} of ${total} variants`
    : `${currentRows.length} row${currentRows.length !== 1 ? 's' : ''}`;
}
function applySelectionUI() {
  $('tbody').querySelectorAll('tr.var-row').forEach(tr => tr.classList.toggle('row-unselected', !selectedIds.has(tr.dataset.rowid)));
  const ids = variationIdList();
  const master = $('master-check');
  if (master) master.checked = ids.length > 0 && ids.every(id => selectedIds.has(id));
  updateResultCount();
}
function setAllChecks(on) {
  selectedIds = new Set(on ? variationIdList() : []);
  $('tbody').querySelectorAll('.row-check').forEach(cb => { cb.checked = on; });
  applySelectionUI();
}
function flashCopied(btn) { btn.classList.add('copied'); const t = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => { btn.classList.remove('copied'); btn.textContent = t; }, 1500); }

function renderResults(title) {
  const variationIds = variationIdList();
  selectedIds = new Set(variationIds);
  const showSel = currentType === 'variable' && variationIds.length > 0;
  updateResultCount();

  const headSel = showSel ? '<th class="sel-col"><input type="checkbox" id="master-check"></th>' : '';
  $('thead').innerHTML = `<tr>${headSel}${COLUMNS.map(c => `<th>${escHtml(c)}</th>`).join('')}</tr>`;

  $('tbody').innerHTML = currentRows.map(row => {
    const isVar = row.Type === 'variation';
    let selCell = '';
    if (showSel) selCell = isVar
      ? `<td class="sel-col"><input type="checkbox" class="row-check" data-id="${escHtml(String(row.ID))}" ${selectedIds.has(String(row.ID)) ? 'checked' : ''}></td>`
      : '<td class="sel-col"></td>';
    const cells = COLUMNS.map(col => {
      if (col === 'Images' || col === 'Rey Variations extra images') {
        const v = row[col]; const a = Array.isArray(v) ? v : (v ? [v] : []);
        return `<td>${a.map(u => `<img src="${escHtml(u)}" onerror="this.style.display='none'">`).join('')}</td>`;
      }
      if (col === 'Color Code' && row.Type === 'variation') {
        const cc = row['Color Code'] || '';
        const rowId = row.ID;
        if (cc.startsWith('#')) return `<td class="color-code-cell"><span class="swatch-dot" style="background:${escHtml(cc)}"></span> <input class="color-code-input" value="${escHtml(cc)}" data-rowid="${rowId}"></td>`;
        if (cc.startsWith('http')) return `<td class="color-code-cell"><img src="${escHtml(cc)}" onerror="this.style.display='none'"> <input class="color-code-input" value="${escHtml(cc)}" data-rowid="${rowId}"></td>`;
        return `<td class="color-code-cell"><input class="color-code-input" value="${escHtml(cc)}" data-rowid="${rowId}" placeholder="#RRGGBB"></td>`;
      }
      const val = cellValue(col, row);
      if (col === 'Rey Swatches' && row.Type === 'variable')
        return `<td data-col="Rey Swatches" data-rowid="${escHtml(String(row.ID))}" title="${escHtml(val)}">${escHtml(val.length > 80 ? val.slice(0, 80) + '…' : val)}</td>`;
      return `<td title="${escHtml(val)}">${escHtml(val.length > 80 ? val.slice(0, 80) + '…' : val)}</td>`;
    }).join('');
    return `<tr data-rowid="${escHtml(String(row.ID))}"${isVar ? ' class="var-row"' : ''}>${selCell}${cells}</tr>`;
  }).join('');

  // Color Code input change handlers
  $('tbody').querySelectorAll('.color-code-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const rowId = Number(inp.dataset.rowid);
      const row = currentRows.find(r => Number(r.ID) === rowId);
      if (row) row['Color Code'] = inp.value;
      // Update adjacent swatch dot if present
      const dot = inp.parentElement.querySelector('.swatch-dot');
      if (dot && /^#[0-9A-Fa-f]{6}$/.test(inp.value)) dot.style.background = inp.value;
      // Update Rey Swatches cell for the parent row
      if (row && row.Parent) {
        const parentId = row.Parent.replace(/^id:/, '');
        const parentRow = currentRows.find(r => String(r.ID) === parentId);
        if (parentRow) {
          const swatchesJson = buildReySwatches(parentRow, currentRows);
          const reyCell = document.querySelector(`td[data-col="Rey Swatches"][data-rowid="${escHtml(parentId)}"]`);
          if (reyCell) {
            const display = swatchesJson.length > 80 ? swatchesJson.slice(0, 80) + '…' : swatchesJson;
            reyCell.textContent = display;
            reyCell.title = swatchesJson;
          }
        }
      }
    });
  });

  if (showSel) {
    $('master-check').addEventListener('change', e => setAllChecks(e.target.checked));
    $('tbody').querySelectorAll('.row-check').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) selectedIds.add(cb.dataset.id); else selectedIds.delete(cb.dataset.id);
      applySelectionUI();
    }));
    applySelectionUI();
  }
  $('import-box').classList.add('hidden');
  $('results').classList.remove('hidden');
}

// ═══ Copy / CSV / Import ══════════════════════════════════════════════════════
$('copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(tsvOf(COLUMNS, exportRows())).then(() => flashCopied($('copy-btn')));
});
$('csv-btn').addEventListener('click', () => downloadCsvFile(csvOf(COLUMNS, exportRows())));

// ═══ Stores ══════════════════════════════════════════════════════════════════
async function getStores() { return (await chrome.storage.local.get('stores')).stores || []; }
async function setStores(s) { await chrome.storage.local.set({ stores: s }); }

$('store-save-btn').addEventListener('click', async () => {
  const name = $('store-name').value.trim();
  const url  = $('store-url').value.trim();
  if (!name || !url) return storeFormStatus('error', 'Name and URL are required.');
  const s = { name, url, authKey: $('store-authkey').value.trim() };
  const stores = await getStores();
  if (editingStoreId) { const e = stores.find(x => x.id === editingStoreId); if (e) Object.assign(e, s); editingStoreId = null; $('store-cancel-btn').classList.add('hidden'); }
  else { s.id = Date.now().toString(36); stores.push(s); }
  await setStores(stores);
  ['store-name','store-url','store-authkey'].forEach(id => $(id).value = '');
  storeFormStatus('success', 'Saved.');
  renderStores();
});
$('store-cancel-btn').addEventListener('click', () => {
  editingStoreId = null; $('store-cancel-btn').classList.add('hidden');
  ['store-name','store-url','store-authkey'].forEach(id => $(id).value = '');
});
function storeFormStatus(type, msg) { const el = $('store-form-status'); el.className = `status ${type}`; el.textContent = msg; el.classList.remove('hidden'); }

async function renderStores() {
  const stores = await getStores();
  const list = $('store-list');
  if (!stores.length) { list.innerHTML = '<li class="store-empty">No stores configured yet. Add one above.</li>'; return; }
  list.innerHTML = stores.map(s => `
    <li class="store-item" data-id="${s.id}">
      <div class="store-item-name">${escHtml(s.name)}</div>
      <div class="store-item-url">${escHtml(s.url)}</div>
      <div class="store-item-actions">
        <button data-act="test">Test</button>
        <button data-act="edit">Edit</button>
        <button data-act="del" class="del">Delete</button>
      </div>
      <div class="store-test hidden"></div>
    </li>`).join('');
  list.querySelectorAll('.store-item').forEach(li => {
    const id = li.dataset.id;
    li.querySelector('[data-act="test"]').addEventListener('click', () => testStore(id, li));
    li.querySelector('[data-act="edit"]').addEventListener('click', () => editStore(id));
    li.querySelector('[data-act="del"]').addEventListener('click', () => deleteStore(id));
  });
}
async function editStore(id) {
  const s = (await getStores()).find(x => x.id === id); if (!s) return;
  editingStoreId = id;
  $('store-name').value = s.name || '';
  $('store-url').value = s.url;
  $('store-authkey').value = s.authKey || '';
  $('store-cancel-btn').classList.remove('hidden');
}
async function deleteStore(id) { await setStores((await getStores()).filter(x => x.id !== id)); renderStores(); }

// Global WP username -- shared across all stores.
async function testStore(id, li) {
  const s = (await getStores()).find(x => x.id === id); if (!s) return;
  const badge = li.querySelector('.store-test'); badge.className = 'store-test'; badge.textContent = 'Testing...'; badge.classList.remove('hidden');
  if (!s.authKey) { badge.className = 'store-test error'; badge.textContent = '✗ Auth key is empty. Paste the key from the plugin dashboard.'; return; }
  const res = await chrome.runtime.sendMessage({ type: 'wcTest', store: s.url, authKey: s.authKey });
  badge.className = 'store-test ' + (res.ok ? 'success' : 'error');
  badge.textContent = res.ok ? '✓ ' + res.message : '✗ ' + res.error;
}

async function fillStoreSelect(selEl) {
  const stores = await getStores();
  selEl.innerHTML = stores.length
    ? stores.map(s => `<label><input type="checkbox" value="${s.id}"> ${escHtml(s.name)}</label>`).join('')
    : '<span class="none">No stores. Add one in the Stores tab.</span>';
}
async function importToStores(csv, selEl, statusFn, skipResize = false) {
  const stores = await getStores();
  const ids = [...selEl.querySelectorAll('input:checked')].map(c => c.value);
  if (!ids.length) return statusFn('error', 'Select at least one store.');
  const selected = stores.filter(s => ids.includes(s.id));
  const report = [];
  for (const s of selected) {
    statusFn('loading', `Importing into ${s.name}...`);
    if (!s.authKey) { report.push(`${s.name}: missing auth key`); continue; }
    const res = await chrome.runtime.sendMessage({ type: 'wcImport', store: s.url, authKey: s.authKey, csv, skipResize });
    if (res.ok) {
      const d = res.data || {};
      const created = (d.created_variable || 0) + (d.created_simple || 0);
      const updated = (d.updated_variable || 0) + (d.updated_simple || 0);
      const skipped = d.skipped || 0;
      const parts = [];
      if (created) parts.push(created + ' created');
      if (updated) parts.push(updated + ' updated');
      if (skipped) parts.push(skipped + ' skipped');
      report.push(`✓ ${s.name}${parts.length ? ' (' + parts.join(', ') + ')' : ''}`);
    } else {
      report.push(`✗ ${s.name}: ${res.error}`);
    }
  }
  statusFn('success', report.join(' | '));
}

$('import-btn').addEventListener('click', async () => {
  const box = $('import-box'); box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) await fillStoreSelect($('store-select'));
});
$('do-import-btn').addEventListener('click', () =>
  importToStores(csvOf(COLUMNS, exportRows()), $('store-select'),
    (t, m) => { const el = $('import-status'); el.className = `status ${t}`; el.textContent = m; el.classList.remove('hidden'); },
    !$('resize-cb').checked));

// ═══ Brands list ════════════════════════════════════
let brandsRendered = false;
function brandNameFromDomain(domain) {
  if (!domain) return '';
  return domain.split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
async function renderBrands() {
  if (brandsRendered) return;
  const brands = (self.BrandCatalog && self.BrandCatalog.brands) || [];

  // Scrapers from Supabase (custom + predefined), grouped by domain. Each domain
  // can hold both a `simple` and a `variable` scraper; show one row with a tag
  // per type that exists.
  let scrapers = [];
  try { scrapers = self.Supabase ? await self.Supabase.listScrapers() : []; } catch (e) { scrapers = []; }
  const byDomain = {};
  for (const s of scrapers) {
    if (!s || !s.domain) continue;
    (byDomain[s.domain] = byDomain[s.domain] || []).push(s);
  }
  const custom = Object.entries(byDomain).map(([domain, rows]) => {
    const types = rows.map(r => r.type).filter(Boolean);
    const first = rows[0] || {};
    const predefined = rows.every(r => r.is_predefined);
    return {
      name: (first.brand && String(first.brand) !== '0' && String(first.brand) !== '')
        ? first.brand : brandNameFromDomain(domain),
      types,
      example: first.example || '',
      domain,
      custom: true,
      predefined,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  // Bundled catalog entries that aren't already in the Supabase registry.
  const customDomains = new Set(custom.map(c => c.domain));
  const ready = brands.filter(b => b.ready && !customDomains.has(b.domain));
  const soon = brands.filter(b => !b.ready);

  const li = b => {
    const exampleBtn = b.example
      ? `<a class="brand-example" href="${escHtml(b.example)}" target="_blank" rel="noopener">Example</a>`
      : '';
    const tags = (b.types || []).map(t => `<span class="type-tag type-${t}">${escHtml(t)}</span>`).join('');
    const delBtn = (b.custom && !b.predefined)
      ? `<button class="brand-del" data-domain="${escHtml(b.domain)}" title="Delete this scraper">✕</button>`
      : '';
    return `<li>
      <div class="brand-info">
        <span class="brand-name">${escHtml(b.name)}</span>
        ${tags}
      </div>
      <div class="brand-actions">${exampleBtn}${delBtn}</div>
    </li>`;
  };

  let html = custom.map(li).join('') + ready.map(li).join('');
  if (soon.length) html += `<li class="brands-soon">Coming soon: ${soon.map(b => escHtml(b.name)).join(', ')}</li>`;
  $('brands-list').innerHTML = html;

  // Delete handler for user-created (non-predefined) scrapers.
  $('brands-list').querySelectorAll('.brand-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const domain = btn.dataset.domain;
      try { if (self.Supabase) await self.Supabase.deleteScraperByDomain(domain); } catch (e) {}
      brandsRendered = false;
      renderBrands();
    });
  });

  brandsRendered = true;
}

// ═══ Keep the hero button in sync with the active tab ════════════════════════
chrome.tabs.onActivated.addListener(() => { refreshScraperStatus(); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' || info.url) refreshScraperStatus();
});
refreshScraperStatus();

// Show the real loaded version so you can tell at a glance which build this is.
try {
  $('version-badge').textContent = 'v' + chrome.runtime.getManifest().version;
} catch (e) {
  $('version-badge').textContent = '';
}
