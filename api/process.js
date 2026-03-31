export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const data = req.body;
    if (!data) return res.status(400).json({ error: 'No data received' });

    const key = process.env.ANTHROPIC_KEY;
    if (!key) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });

    // Cap no_return_members to 20 before sending to Claude
    if (data.no_return_members && data.no_return_members.length > 20) {
      data.no_return_members = data.no_return_members.slice(0, 20);
    }

    // 1. Call Claude
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4000,
        messages: [{ role: 'user', content: buildPrompt(data) }]
      })
    });

    const claude = await response.json();

    if (!claude.content || !claude.content[0]) {
      return res.status(500).json({ error: 'No response from Claude', detail: claude });
    }

    // Robust JSON extraction
    let text = claude.content[0].text.trim();
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'No JSON in Claude response', raw: text.substring(0, 500) });
    }

    const result = JSON.parse(jsonMatch[0]);
    result.week_of     = data.week_of;
    result.uploaded_at = new Date().toISOString();

    // 2. Save to Apps Script via POST body encoded as JSON in a GET param
    // We save a compact version to keep the URL small
    const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyyqmSW4DM178V3C9W1H4Isnhh_t8bhwo1V1yLVjpAzvdSeoXaHIhkpcqfHjQjbfe-K/exec';

    // Strip large arrays from what we save to keep URL short
    // Apps Script only needs the processed metrics + small dorian list
    const toSave = {
      ...result,
      dorian: {
        critical: (result.dorian?.critical || []).slice(0, 10),
        watch:    (result.dorian?.watch    || []).slice(0, 10),
        lost:     (result.dorian?.lost     || []).slice(0, 10),
        win_back: (result.dorian?.win_back || []).slice(0, 10),
      }
    };

    const saveEncoded = encodeURIComponent(JSON.stringify(toSave));

    // Only save if payload is small enough
    if (saveEncoded.length < 8000) {
      try {
        await fetch(APPS_SCRIPT_URL + '?action=save&week_of=' +
          encodeURIComponent(data.week_of) + '&data=' + saveEncoded);
      } catch (e) {
        result.save_warning = 'Save failed: ' + e.message;
      }
    } else {
      result.save_warning = 'Data too large to save (' + saveEncoded.length + ' chars)';
    }

    // 3. Get previous week
    let previous = null;
    try {
      const prevRes  = await fetch(APPS_SCRIPT_URL + '?action=get_previous&week_of=' + encodeURIComponent(data.week_of));
      const prevData = await prevRes.json();
      if (prevData.ok) previous = prevData.data;
    } catch { /* optional */ }

    return res.status(200).json({ ok: true, current: result, previous });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function buildPrompt(data) {
  return `You are the data analyst for Prana Wellness Club, a boutique fitness studio in Austin targeting 800 members.

Analyse this weekly data and return ONLY a valid JSON object. No markdown, no backticks, no explanation, no text before or after the JSON.

WEEKLY DATA:
${JSON.stringify(data)}

CALCULATION RULES:
- mrr = autopay_total
- pack_and_class = sales_total minus autopay_total
- mrr_pct = round(mrr/sales_total*100), 0 if sales_total is 0
- revenue_per_member = round(sales_total/active_count), 0 if active_count is 0
- net_growth = first_visit_count minus cancelled_count
- churn_rate_pct = round(cancelled_count/active_count*100,1), 0 if active_count is 0
- progress_to_800_pct = round(active_count/800*100)
- For each no_return member: calculate days_since_visit from last_visit to today
- critical = no_return where days_since_visit 14-29, MAX 10 members
- watch = no_return where days_since_visit 8-13, MAX 10 members
- lost = no_return where days_since_visit 30+, MAX 10 members
- win_back = cancelled_members as-is
- avg_fill_rate_pct = average visits/capacity*100 where capacity>0, round to integer
- total_visits = sum of all class visits
- no_show_rate_pct = round(no_show_count/total_visits*100) if total_visits>0 else 0
- top_classes = 3 classes by highest visits
- bottom_classes = 3 classes by lowest visits excluding 0

RETURN EXACTLY THIS JSON STRUCTURE AND NOTHING ELSE:
{"revenue":{"total_weekly":0,"mrr":0,"mrr_pct":0,"pack_and_class":0,"revenue_per_member":0},"membership":{"active_count":0,"new_this_week":0,"churned_this_week":0,"net_growth":0,"churn_rate_pct":0,"retention_rate_pct":0,"progress_to_800_pct":0},"attendance":{"avg_fill_rate_pct":0,"total_visits":0,"no_show_rate_pct":0,"top_classes":[{"name":"","visits":0,"fill_rate_pct":0}],"bottom_classes":[{"name":"","visits":0,"fill_rate_pct":0}]},"dorian":{"critical":[{"name":"","email":"","phone":"","membership":"","last_visit":"","days_since_visit":0,"lifetime_visits":0,"member_since":""}],"watch":[],"lost":[],"win_back":[{"name":"","email":"","phone":"","membership":"","cancel_date":""}]},"intelligence":{"headline":"","actions":["","",""],"risk":"","bright_spot":""},"warnings":[]}`;
}
