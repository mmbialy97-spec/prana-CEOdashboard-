import { getCache, waitUntil } from '@vercel/functions';

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyXKb1IAu8YGfmP86Z8eL4B3YEvKE5cLh6k1MgGOAM2BQ_FRd9zIHbFco631fIFxq07/exec';
const ALLOWED_ACTIONS = new Set(['read_latest', 'read_weeks', 'read_week']);
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
const FRESH_FOR_MS = 5 * 60 * 1000;
const cache = getCache({ namespace: 'prana-retention-v1' });

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const action = String(req.query?.action || 'read_latest');
  if (!ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ ok: false, error: 'Unsupported action' });
  }
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  res.setHeader('CDN-Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');

  const weekOf = cleanDate(req.query?.week_of);
  if (action === 'read_week' && !/^\d{4}-\d{2}-\d{2}$/.test(weekOf || '')) {
    return res.status(400).json({ ok: false, error: 'A valid week is required' });
  }

  const cacheKey = action === 'read_weeks' ? 'weeks' : `week:${weekOf || 'latest'}`;
  const startedAt = Date.now();
  let cached;

  try {
    cached = await cache.get(cacheKey);
  } catch (error) {
    console.warn('[retention] cache read failed', { action, error: errorMessage(error) });
  }

  if (cached?.payload) {
    const ageMs = Math.max(Date.now() - Number(cached.fetched_at || 0), 0);
    if (ageMs >= FRESH_FOR_MS) {
      waitUntil(refreshCache(cacheKey, action, weekOf).catch(error => {
        console.error('[retention] background refresh failed', { action, duration_ms: Date.now() - startedAt, error: errorMessage(error) });
      }));
    }

    console.log('[retention] served cached data', { action, age_ms: ageMs, refreshing: ageMs >= FRESH_FOR_MS });
    res.setHeader('X-Retention-Source', ageMs >= FRESH_FOR_MS ? 'stale-cache' : 'cache');
    return res.status(200).json(cached.payload);
  }

  try {
    const payload = await readFromSource(action, weekOf);
    await writeCache(cacheKey, payload);
    console.log('[retention] served upstream data', { action, duration_ms: Date.now() - startedAt });
    res.setHeader('X-Retention-Source', 'upstream');
    return res.status(200).json(payload);
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'The retention data took too long to respond. Please try again.'
      : 'The retention data is temporarily unavailable.';
    console.error('[retention] upstream read failed', { action, duration_ms: Date.now() - startedAt, error: errorMessage(error) });
    return res.status(502).json({ ok: false, error: message });
  }
}

async function refreshCache(cacheKey, action, weekOf) {
  const payload = await readFromSource(action, weekOf);
  await writeCache(cacheKey, payload);
}

async function writeCache(cacheKey, payload) {
  await cache.set(cacheKey, { payload, fetched_at: Date.now() }, {
    ttl: CACHE_TTL_SECONDS,
    tags: ['retention'],
    name: 'prana-retention-read'
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sourcePayload(action, source) {
  if (action === 'read_weeks') {
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

  if (!source.current) throw new Error('No retention data found');
  return { ok: true, current: retentionOnly(source.current) };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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

function retentionOnly(current) {
  const dorian = current.dorian || {};
  return {
    week_of: cleanDate(current.week_of),
    uploaded_at: current.uploaded_at || '',
    health_summary: sanitiseHealth(current.health_summary),
    dorian: {
      watch: sanitiseMembers(dorian.watch),
      never_visited: sanitiseMembers(dorian.never_visited),
      critical: sanitiseMembers(dorian.critical),
      lost: sanitiseMembers(dorian.lost)
    },
    new_founder_members: sanitiseMembers(current.new_founder_members)
  };
}

function sanitiseHealth(value) {
  const health = value || {};
  return {
    green: numberOrZero(health.green),
    amber: numberOrZero(health.amber),
    red: numberOrZero(health.red),
    frozen: numberOrZero(health.frozen)
  };
}

function sanitiseMembers(rows) {
  return (Array.isArray(rows) ? rows : []).map(member => ({
    name: text(member?.name),
    membership: text(member?.membership),
    email: text(member?.email),
    phone: text(member?.phone),
    member_since: text(member?.member_since),
    last_visit: text(member?.last_visit),
    days_absent: numberOrBlank(member?.days_absent),
    lifetime_visits: numberOrBlank(member?.lifetime_visits),
    visits_so_far: numberOrBlank(member?.visits_so_far)
  }));
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function numberOrBlank(value) {
  if (value === '' || value == null) return '';
  const number = Number(value);
  return Number.isFinite(number) ? number : '';
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
