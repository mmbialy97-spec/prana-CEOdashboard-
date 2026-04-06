const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyyqmSW4DM178V3C9W1H4Isnhh_t8bhwo1V1yLVjpAzvdSeoXaHIhkpcqfHjQjbfe-K/exec';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { action, week_of } = req.query;

    let url = APPS_SCRIPT_URL + '?action=' + (action || 'read_latest');
    if (week_of) url += '&week_of=' + encodeURIComponent(week_of);

    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'Accept': 'application/json, text/plain, */*' }
    });

    if (!response.ok) {
      return res.status(200).json({ ok: false, error: 'Apps Script returned ' + response.status });
    }

    const text = await response.text();
    let json = text.trim();

    // Strip JSONP wrapper if present
    const jsonpMatch = json.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(([\s\S]*)\)\s*;?\s*$/);
    if (jsonpMatch) json = jsonpMatch[1].trim();

    let data;
    try {
      data = JSON.parse(json);
    } catch {
      return res.status(200).json({ ok: false, message: 'No data yet' });
    }

    // Normalise current and previous
    if (data.current) data.current = normalise(data.current);
    if (data.previous) data.previous = normalise(data.previous);

    // Normalise arrays of weeks (for read_weeks action)
    if (data.weeks) {
      data.weeks = data.weeks.map(w => ({
        ...w,
        week_of: cleanDate(w.week_of)
      }));
    }

    return res.status(200).json(data);

  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// Clean any timestamp back to YYYY-MM-DD
function cleanDate(dateStr) {
  if (!dateStr) return dateStr;
  const s = String(dateStr);
  // Already clean
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // ISO timestamp — extract date part in UTC
  if (s.includes('T')) {
    const d = new Date(s);
    if (!isNaN(d)) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth()+1).padStart(2,'0');
      const day = String(d.getUTCDate()).padStart(2,'0');
      return y+'-'+m+'-'+day;
    }
  }
  return s;
}

function normalise(c) {
  if (!c) return c;
  const raw = c.raw || {};

  // Clean week_of date
  if (c.week_of) c.week_of = cleanDate(c.week_of);

  // Promote enriched fields from raw if missing at top level (old save format)
  if (!c.health_summary      && raw.health_summary)     c.health_summary      = raw.health_summary;
  if (!c.avg_founder_visits  && raw.avg_founder_visits) c.avg_founder_visits  = raw.avg_founder_visits;
  if (!c.class_data          && raw.class_data)         c.class_data          = raw.class_data;
  if (!c.founder_classes     && raw.founder_classes)    c.founder_classes     = raw.founder_classes;
  if (!c.first_time_visitors && raw.first_visit_count)  c.first_time_visitors = raw.first_visit_count;

  // Peak times — old format used founder_times
  if (!c.peak_times && raw.founder_times) {
    c.peak_times = raw.founder_times.map(t => ({ time: t.time, visits: t.count }));
  }
  // Peak days — old format used founder_days
  if (!c.peak_days && raw.founder_days) {
    c.peak_days = raw.founder_days.map(d => ({ day: d.day, visits: d.count }));
  }
  // Instructor data — old format used top_instructors
  if (!c.instructor_data && raw.top_instructors) {
    c.instructor_data = raw.top_instructors.map(i => ({
      name: i.name, visits: i.visits,
      classes_taught: 0, avg_per_class: 0,
    }));
  }

  // Ensure dorian has all tiers including never_visited
  if (c.dorian) {
    if (!c.dorian.never_visited) c.dorian.never_visited = [];
    if (!c.dorian.critical)      c.dorian.critical = [];
    if (!c.dorian.watch)         c.dorian.watch = [];
    if (!c.dorian.lost)          c.dorian.lost = [];
    if (!c.dorian.win_back)      c.dorian.win_back = [];
  }

  return c;
}
