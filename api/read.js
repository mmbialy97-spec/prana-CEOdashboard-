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

    // Apps Script may return JSONP like: callback({...}) or just {...}
    let json = text.trim();

    // Strip JSONP wrapper if present
    const jsonpMatch = json.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(([\s\S]*)\)\s*;?\s*$/);
    if (jsonpMatch) {
      json = jsonpMatch[1].trim();
    }

    // Parse JSON
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      // If parsing fails return empty state so dashboard shows empty screen not error
      return res.status(200).json({ ok: false, message: 'No data yet' });
    }

    return res.status(200).json(data);

  } catch (err) {
    // Return ok:false so dashboard shows empty state rather than crashing
    return res.status(200).json({ ok: false, error: err.message });
  }
}
