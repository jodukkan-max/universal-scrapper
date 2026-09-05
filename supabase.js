/* Shared Supabase client for the extension — anonymous (no auth).
 * Lightweight fetch-based client (no bundler / npm needed). Loaded by both the
 * service worker (importScripts) and the side panel (<script>).
 *
 * Exposes `self.Supabase` with scraper CRUD + the DeepSeek Edge Function proxy.
 */
(function (root) {
  'use strict';

  const SUPABASE_URL = 'https://hnscofvpziluahspyjqk.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhuc2NvZnZwemlsdWFoc3B5anFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0Njc5MjEsImV4cCI6MjEwMzA0MzkyMX0.tqVD8zrRo-vRF3SPLVKflWMsmfkznDra6NLU0UzQXgg';

  // Low-level request (PostgREST + Edge Functions).
  async function rest(path, { method = 'GET', body, prefer, timeoutMs, signal } = {}) {
    const headers = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers['Prefer'] = prefer;

    const ctrl = new AbortController();
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onExtAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onExtAbort, { once: true });
    }

    let r;
    try {
      r = await fetch(SUPABASE_URL + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (signal && signal.aborted) {
        return { ok: false, status: 0, data: null, error: 'cancelled', cancelled: true };
      }
      if (ctrl.signal.aborted) {
        return { ok: false, status: 0, data: null, error: 'The AI request timed out — try again.' };
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExtAbort);
    }
    const text = await r.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    return {
      ok: r.ok,
      status: r.status,
      data,
      error: !r.ok ? ((data && (data.message || data.error_description || data.msg)) || text) : null,
    };
  }

  // ── Scrapers ────────────────────────────────────────────────────────────────
  async function listScrapers() {
    // Metadata only (exclude `code` to keep the Websites tab fast).
    const res = await rest('/rest/v1/scrapers?select=domain,type,brand,example,is_predefined,verified,updated_at&order=domain.asc');
    return res.ok ? (res.data || []) : [];
  }

  async function listScrapersForDomain(domain) {
    const res = await rest(`/rest/v1/scrapers?domain=eq.${encodeURIComponent(domain)}&select=*`);
    return res.ok ? (res.data || []) : [];
  }

  async function upsertScraper(entry) {
    // `on_conflict=domain,type` is required: the table has both a primary key and
    // a unique(domain, type), so merge-duplicates alone cannot infer the target.
    return rest('/rest/v1/scrapers?on_conflict=domain,type', {
      method: 'POST',
      body: entry,
      prefer: 'resolution=merge-duplicates',
    });
  }

  async function deleteScraperByDomain(domain) {
    return rest(`/rest/v1/scrapers?domain=eq.${encodeURIComponent(domain)}`, { method: 'DELETE' });
  }

  async function setVerified(domain, type, verified) {
    return rest(`/rest/v1/scrapers?domain=eq.${encodeURIComponent(domain)}&type=eq.${encodeURIComponent(type)}`, {
      method: 'PATCH',
      body: { verified },
    });
  }

  // ── Predefined module (single shared scraper module) ────────────────────────
  async function getPredefinedModule() {
    const res = await rest('/rest/v1/scraper_modules?name=eq.predefined&select=code,version');
    if (!res.ok || !res.data || !res.data.length || !res.data[0].code) return null;
    return { code: res.data[0].code, version: res.data[0].version };
  }

  async function getPredefinedVersion() {
    const res = await rest('/rest/v1/scraper_modules?name=eq.predefined&select=version');
    if (!res.ok || !res.data || !res.data.length) return null;
    return res.data[0].version;
  }

  // ── DeepSeek via Edge Function ──────────────────────────────────────────────
  async function deepseek(messages, opts = {}) {
    return rest('/functions/v1/deepseek', {
      method: 'POST',
      body: { messages, json: !!opts.json, thinking: !!opts.thinking },
      // Under Supabase's 150s wall-clock limit; abort a bit early so the user
      // sees a clear timeout instead of an opaque 546/504.
      timeoutMs: opts.timeoutMs || 120000,
      signal: opts.signal,
    });
  }

  root.Supabase = {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    listScrapers, listScrapersForDomain, upsertScraper, deleteScraperByDomain, setVerified,
    getPredefinedModule, getPredefinedVersion,
    deepseek,
  };
})(typeof self !== 'undefined' ? self : this);
