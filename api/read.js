import { getCache, waitUntil } from '@vercel/functions';

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyXKb1IAu8YGfmP86Z8eL4B3YEvKE5cLh6k1MgGOAM2BQ_FRd9zIHbFco631fIFxq07/exec';
const ALLOWED_ACTIONS = new Set(['read_latest', 'read_weeks', 'read_week']);
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
const FRESH_FOR_MS = 5 * 60 * 1000;
const cache = getCache({ namespace: 'prana-dashboard-read-v1' });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const action = String(req.query?.action || 'read_latest');
  if (!ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ ok: false, error: 'Unsupported action' });
  }

  const weekOf = cleanDate(req.query?.week_of);
  if (action === 'read_week' && !/^\d{4}-\d{2}-\d{2}$/.test(weekOf || '')) {
    return res.status(400).json({ ok: false, error: 'A valid week is required' });
  }

  const cacheKey = cacheKeyFor(action, weekOf);
  const startedAt = Date.now();
  let cached;

  try {
    cached = await cache.get(cacheKey);
  } catch (error) {
    console.warn('[dashboard-read] cache read failed', { action, error: errorMessage(error) });
  }

  if (cached?.payload) {
    const ageMs = Math.max(Date.now() - Number(cached.fetched_at || 0), 0);
    if (ageMs >= FRESH_FOR_MS) {
      waitUntil(refreshCache(cacheKey, action, weekOf).catch(error => {
        console.error('[dashboard-read] background refresh failed', { action, error: errorMessage(error) });
      }));
    }
    res.setHeader('X-Dashboard-Source', ageMs >= FRESH_FOR_MS ? 'stale-cache' : 'cache');
    console.log('[dashboard-read] served cached data', { action, age_ms: ageMs });
    return res.status(200).json(cached.payload);
  }

  try {
    const payload = await readFromSource(action, weekOf);
    await writeCache(cacheKey, payload);
    res.setHeader('X-Dashboard-Source', 'upstream');
    console.log('[dashboard-read] served upstream data', { action, duration_ms: Date.now() - startedAt });
    return res.status(200).json(payload);
  } catch (error) {
    console.error('[dashboard-read] upstream read failed', { action, duration_ms: Date.now() - startedAt, error: errorMessage(error) });
    return res.status(200).json({ ok: false, error: 'Dashboard data is temporarily unavailable' });
  }
}

function cacheKeyFor(action, weekOf) {
  if (action === 'read_weeks') return 'weeks';
  if (action === 'read_week') return `week:${weekOf}`;
  return 'latest';
}

async function refreshCache(cacheKey, action, weekOf) {
  const payload = await readFromSource(action, weekOf);
  await writeCache(cacheKey, payload);
}

async function writeCache(cacheKey, payload) {
  await cache.set(cacheKey, { payload, fetched_at: Date.now() }, {
    ttl: CACHE_TTL_SECONDS,
    tags: ['dashboard-data'],
    name: 'prana-dashboard-read'
  });
}

async function readFromSource(action, weekOf) {
  const url = new URL(APPS_SCRIPT_URL);
  url.searchParams.set('action', action);
  if (weekOf) url.searchParams.set('week_of', weekOf);

  const controllers = [new AbortController(), new AbortController()];
  const timeout = setTimeout(() => controllers.forEach(controller => controller.abort()), 55000);

  try {
    return await Promise.any([
      readSourceAttempt(url, action, controllers[0].signal),
      delay(750).then(() => readSourceAttempt(url, action, controllers[1].signal))
    ]);
  } finally {
    clearTimeout(timeout);
    controllers.forEach(controller => controller.abort());
  }
}

async function readSourceAttempt(url, action, signal) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal,
    headers: { Accept: 'application/json, text/plain, */*' }
  });
  if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`);
  const source = parseResponse(await response.text());
  return sourcePayload(action, source);
}

function sourcePayload(action, source) {
  if (!source || source.ok === false || source.error) {
    throw new Error(source?.error || 'Upstream returned an invalid response');
  }

  if (action === 'read_weeks') {
    if (!Array.isArray(source.weeks)) throw new Error('Upstream returned no week history');
    const latestByWeek = new Map();
    (source.weeks || []).forEach(item => {
      const week = cleanDate(item?.week_of);
      if (!week) return;
      const current = latestByWeek.get(week);
      if (!current || String(item.uploaded_at || '') > String(current.uploaded_at || '')) {
        latestByWeek.set(week, { week_of: week, uploaded_at: item.uploaded_at || '' });
      }
    });
    return {
      ok: true,
      weeks: [...latestByWeek.values()].sort((a, b) => a.week_of.localeCompare(b.week_of))
    };
  }

  if (!source.current) throw new Error('No dashboard data found');
  return {
    ok: true,
    current: normalise(source.current),
    ...(source.previous ? { previous: normalise(source.previous) } : {})
  };
}

function parseResponse(text) {
  const trimmed = String(text || '').trim();
  const jsonp = trimmed.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(([\s\S]*)\)\s*;?\s*$/);
  return JSON.parse(jsonp ? jsonp[1].trim() : trimmed);
}

function cleanDate(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '';
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function normalise(current) {
  if (!current) return current;
  const raw = current.raw || {};
  if (current.week_of) current.week_of = cleanDate(current.week_of);
  if (!current.health_summary && raw.health_summary) current.health_summary = raw.health_summary;
  if (!current.member_product_counts && raw.member_product_counts) current.member_product_counts = raw.member_product_counts;
  if (!current.avg_founder_visits && raw.avg_founder_visits) current.avg_founder_visits = raw.avg_founder_visits;
  if (!current.class_data && raw.class_data) current.class_data = raw.class_data;
  if (!current.founder_classes && raw.founder_classes) current.founder_classes = raw.founder_classes;
  if (!current.first_time_visitors && raw.first_visit_count) current.first_time_visitors = raw.first_visit_count;
  if (!current.peak_times && raw.founder_times) current.peak_times = raw.founder_times.map(item => ({ time: item.time, visits: item.count }));
  if (!current.peak_days && raw.founder_days) current.peak_days = raw.founder_days.map(item => ({ day: item.day, visits: item.count }));
  if (!current.instructor_data && raw.top_instructors) {
    current.instructor_data = raw.top_instructors.map(item => ({ name: item.name, visits: item.visits, classes_taught: 0, avg_per_class: 0 }));
  }
  if (current.dorian) {
    if (!current.dorian.never_visited) current.dorian.never_visited = [];
    if (!current.dorian.critical) current.dorian.critical = [];
    if (!current.dorian.watch) current.dorian.watch = [];
    if (!current.dorian.lost) current.dorian.lost = [];
    if (!current.dorian.win_back) current.dorian.win_back = [];
  }
  return current;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
