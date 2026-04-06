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

    // Normalise: promote fields from current.raw up to current if missing
    // This handles data saved by older versions of save.js
    if (data.current) {
      data.current = normalise(data.current);
    }
    if (data.previous) {
      data.previous = normalise(data.previous);
    }

    return res.status(200).json(data);

  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}

function normalise(c) {
  if (!c) return c;
  const raw = c.raw || {};

  // Promote enriched fields from raw if not already at top level
  if (!c.health_summary     && raw.health_summary)     c.health_summary     = raw.health_summary;
  if (!c.avg_founder_visits && raw.avg_founder_visits) c.avg_founder_visits = raw.avg_founder_visits;
  if (!c.class_data         && raw.class_data)         c.class_data         = raw.class_data;
  if (!c.founder_classes    && raw.founder_classes)    c.founder_classes    = raw.founder_classes;
  if (!c.peak_times         && raw.founder_times)      c.peak_times         = raw.founder_times;
  if (!c.peak_days          && raw.founder_days)       c.peak_days          = raw.founder_days;
  if (!c.first_time_visitors&& raw.first_visit_count)  c.first_time_visitors= raw.first_visit_count;

  // Normalise instructor data — old format used top_instructors
  if (!c.instructor_data && raw.top_instructors) {
    c.instructor_data = raw.top_instructors.map(i => ({
      name:          i.name,
      visits:        i.visits,
      classes_taught: 0,
      avg_per_class: 0,
    }));
  }

  // Normalise dorian — old format may be missing never_visited
  if (c.dorian && !c.dorian.never_visited) {
    c.dorian.never_visited = [];
  }

  return c;
}
