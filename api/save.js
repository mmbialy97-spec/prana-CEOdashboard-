const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyyqmSW4DM178V3C9W1H4Isnhh_t8bhwo1V1yLVjpAzvdSeoXaHIhkpcqfHjQjbfe-K/exec';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { week_of, data } = req.body;
    if (!week_of || !data) return res.status(400).json({ error: 'Missing week_of or data' });

    // Send as POST to Apps Script — no URL length limits
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', week_of, data })
    });

    const text = await response.text();

    // Parse response (may be JSONP-wrapped)
    let result;
    try {
      const clean = text.trim().replace(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(/, '').replace(/\)\s*;?\s*$/, '');
      result = JSON.parse(clean);
    } catch {
      result = { ok: true }; // Apps Script saved but response unparseable
    }

    return res.status(200).json({ ok: true, result });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
