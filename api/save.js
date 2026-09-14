import { getCache } from '@vercel/functions';

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyyqmSW4DM178V3C9W1H4Isnhh_t8bhwo1V1yLVjpAzvdSeoXaHIhkpcqfHjQjbfe-K/exec';
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
const cache = getCache({ namespace: 'prana-dashboard-read-v1' });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { week_of: weekOf, data } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekOf || '')) || !data) {
      return res.status(400).json({ ok: false, error: 'Missing or invalid week_of or data' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);
    let response;
    let responseText;

    try {
      response = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', week_of: weekOf, data })
      });
      responseText = await response.text();
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw new Error(`Storage returned HTTP ${response.status}`);

    let result = { ok: true };
    try {
      const clean = responseText.trim().replace(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(/, '').replace(/\)\s*;?\s*$/, '');
      result = JSON.parse(clean);
    } catch {
      // A completed Apps Script POST may return an HTML wrapper after saving.
    }

    if (result?.ok === false) throw new Error(result.error || result.message || 'Storage rejected the upload');

    try {
      await updateReadCache(weekOf, data);
    } catch (cacheError) {
      console.warn('[dashboard-save] saved, but cache refresh failed', {
        week_of: weekOf,
        error: errorMessage(cacheError)
      });
    }
    console.log('[dashboard-save] saved weekly upload', { week_of: weekOf });
    return res.status(200).json({ ok: true, result });
  } catch (error) {
    console.error('[dashboard-save] save failed', { error: errorMessage(error) });
    return res.status(500).json({ ok: false, error: 'The weekly upload could not be saved. Please try again.' });
  }
}

async function updateReadCache(weekOf, data) {
  const now = Date.now();
  const options = { ttl: CACHE_TTL_SECONDS, tags: ['dashboard-data'], name: 'prana-dashboard-read' };
  const envelope = payload => ({ payload, fetched_at: now });

  await cache.set(`week:${weekOf}`, envelope({ ok: true, current: data }), options);

  const latest = await cache.get('latest');
  const latestCurrent = latest?.payload?.current;
  if (!latestCurrent || String(weekOf) >= String(latestCurrent.week_of || '')) {
    const previous = latestCurrent && latestCurrent.week_of !== weekOf
      ? latestCurrent
      : latest?.payload?.previous;
    await cache.set('latest', envelope({ ok: true, current: data, ...(previous ? { previous } : {}) }), options);
  }

  const weeksCache = await cache.get('weeks');
  if (Array.isArray(weeksCache?.payload?.weeks)) {
    const latestByWeek = new Map(weeksCache.payload.weeks.map(item => [item.week_of, item]));
    latestByWeek.set(weekOf, { week_of: weekOf, uploaded_at: data.uploaded_at || new Date(now).toISOString() });
    const weeks = [...latestByWeek.values()].sort((a, b) => a.week_of.localeCompare(b.week_of));
    await cache.set('weeks', envelope({ ok: true, weeks }), options);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
