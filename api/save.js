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

    // Save to Apps Script — chunked to stay under URL limits
    // Apps Script GET has ~8000 char URL limit so we send compact JSON
    const compact = JSON.stringify(data);
    const encoded = encodeURIComponent(compact);

    // If payload is small enough, use GET
    if (encoded.length < 7500) {
      const url = APPS_SCRIPT_URL + '?action=save&week_of=' + encodeURIComponent(week_of) + '&data=' + encoded;
      await fetch(url);
      return res.status(200).json({ ok: true });
    }

    // Otherwise strip the largest arrays to fit, preserving all key metrics
    const trimmed = {
      ...data,
      no_return_members:   (data.no_return_members  || []).slice(0, 10),
      new_founder_members: (data.new_founder_members || []).slice(0, 10),
      cancelled_members:   (data.cancelled_members   || []).slice(0, 10),
      class_data:          (data.class_data          || []).slice(0, 15),
      founder_classes:     (data.founder_classes     || []).slice(0, 10),
      instructor_data:     (data.instructor_data     || []).slice(0, 10),
      dorian: {
        critical: (data.dorian?.critical || []).slice(0, 8),
        watch:    (data.dorian?.watch    || []).slice(0, 8),
        lost:     (data.dorian?.lost     || []).slice(0, 8),
        win_back: (data.dorian?.win_back || []).slice(0, 8),
      }
    };

    const trimmedEncoded = encodeURIComponent(JSON.stringify(trimmed));
    const url = APPS_SCRIPT_URL + '?action=save&week_of=' + encodeURIComponent(week_of) + '&data=' + trimmedEncoded;
    await fetch(url);

    return res.status(200).json({ ok: true });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
