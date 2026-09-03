# Universal Scrapper — Chrome Extension

Scrapes cosmetics product pages into WooCommerce‑ready rows (variable + simple,
with color/image swatches), and exports via **Copy / CSV** or imports to one or
more saved **WooCommerce stores**.

This extension scrapes in‑browser. Scraper code and the shared brand registry are
served from **Supabase** (see `../supabase/`); the AI "Add new Scrapper" feature
uses a Supabase Edge Function that proxies DeepSeek (the API key is stored only
in the function secret, never in the extension).

## Install (load unpacked)
1. Open Chrome → go to `chrome://extensions`
2. Turn on **Developer mode** (top‑right)
3. Click **Load unpacked** and select this `extension` folder (the one with `manifest.json`)
4. Pin the extension and click its icon to open the **side panel**

> Keep this folder on disk. The unpacked extension loads from it every time Chrome
> starts, so don't delete or move it (or re‑load it if you do).

## Use
- **Scrape:** open a product page → **Scrape this page**. Toggle **Variable / Simple** first.
- **Stores:** add your WooCommerce store(s) (name, URL, auth key for CSV import). Saved in the browser.

## Files
- `manifest.json` — extension config (Manifest V3)
- `background.js` — orchestrates scraping + WooCommerce calls
- `supabase.js` — Supabase client (scraper registry + DeepSeek proxy)
- `brands.js` — lightweight brand catalog for the Websites tab
- `sidepanel.html` / `sidepanel.css` / `sidepanel.js` — the UI

## Maintenance note
Websites occasionally change their HTML, which can break a scraper. Predefined
scraper code lives in `../supabase/predefined/scrapers.js` and is uploaded to
Supabase via `../upload-module.mjs`; the extension fetches and caches it.

