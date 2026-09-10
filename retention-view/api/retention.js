const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyXKb1IAu8YGfmP86Z8eL4B3YEvKE5cLh6k1MgGOAM2BQ_FRd9zIHbFco631fIFxq07/exec';

const ALLOWED_ACTIONS = new Set(['read_latest', 'read_weeks', 'read_week']);

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
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');

  const weekOf = cleanDate(req.query?.week_of);
  if (action === 'read_week' && !/^\d{4}-\d{2}-\d{2}$/.test(weekOf || '')) {
    return res.status(400).json({ ok: false, error: 'A valid week is required' });
  }

  const url = new URL(APPS_SCRIPT_URL);
  url.searchParams.set('action', action);
  if (weekOf) url.searchParams.set('week_of', weekOf);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: 'application/json, text/plain, */*' }
    });
    const body = await response.text();
    const source = parseResponse(body);

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
      return res.status(200).json({
        ok: true,
        weeks: [...latestByWeek.values()].sort((a, b) => a.week_of.localeCompare(b.week_of))
      });
    }

    if (!source.current) {
      return res.status(404).json({ ok: false, error: 'No retention data found' });
    }

    return res.status(200).json({ ok: true, current: retentionOnly(source.current) });
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'The retention data took too long to respond. Please try again.'
      : 'The retention data is temporarily unavailable.';
    return res.status(502).json({ ok: false, error: message });
  } finally {
    clearTimeout(timeout);
  }
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
