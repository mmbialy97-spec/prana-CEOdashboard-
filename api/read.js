const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyyqmSW4DM178V3C9W1H4Isnhh_t8bhwo1V1yLVjpAzvdSeoXaHIhkpcqfHjQjbfe-K/exec';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { action, week_of } = req.query;

    let url = APPS_SCRIPT_URL + '?action=' + (action || 'read_latest');
    if (week_of) url += '&week_of=' + encodeURIComponent(week_of);

    const response = await fetch(url);
    const text     = await response.text();

    // Apps Script returns JSONP — strip the callback wrapper if present
    const json = text.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, '').trim();
    const data = JSON.parse(json);

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
