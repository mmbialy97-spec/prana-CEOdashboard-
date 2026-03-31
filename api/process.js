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

    const text   = claude.content[0].text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(text);

    result.week_of     = data.week_of;
    result.uploaded_at = new Date().toISOString();

    // 2. Save to Google Sheets via Apps Script
    const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyyqmSW4DM178V3C9W1H4Isnhh_t8bhwo1V1yLVjpAzvdSeoXaHIhkpcqfHjQjbfe-K/exec';

    const saveUrl = APPS_SCRIPT_URL +
      '?action=save&week_of=' + encodeURIComponent(data.week_of) +
      '&uploaded_at=' + encodeURIComponent(result.uploaded_at) +
      '&data=' + encodeURIComponent(JSON.stringify(result));

    try {
      await fetch(saveUrl);
    } catch (saveErr) {
      result.save_warning = 'Could not save to Sheets: ' + saveErr.message;
    }

    // 3. Get previous week for WoW comparison
    let previous = null;
    try {
      const prevRes  = await fetch(APPS_SCRIPT_URL + '?action=get_previous&week_of=' + encodeURIComponent(data.week_of));
      const prevData = await prevRes.json();
      if (prevData.ok) previous = prevData.data;
    } catch {
      // Optional
    }

    return res.status(200).json({ ok: true, current: result, previous });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function buildPrompt(data) {
  return `You are the data analyst for Prana Wellness Club, a boutique fitness studio in Austin targeting 800 members.

Analyse this weekly data and return ONLY a raw JSON object. No markdown, no backticks, no explanation.

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
- critical = no_return where days_since_visit 14-29
- watch = no_return where days_since_visit 8-13
- lost = no_return where days_since_visit 30+
- win_back = cancelled_members as-is
- avg_fill_rate_pct = average visits/capacity*100 where capacity>0
- total_visits = sum of all class visits
- no_show_rate_pct = round(no_show_count/total_visits*100) if total_visits>0
- top_classes = 3 classes by highest visits
- bottom_classes = 3 classes by lowest visits excluding 0

RETURN EXACTLY THIS JSON STRUCTURE:
{
  "revenue": {"total_weekly":0,"mrr":0,"mrr_pct":0,"pack_and_class":0,"revenue_per_member":0},
  "membership": {"active_count":0,"new_this_week":0,"churned_this_week":0,"net_growth":0,"churn_rate_pct":0,"retention_rate_pct":0,"progress_to_800_pct":0},
  "attendance": {"avg_fill_rate_pct":0,"total_visits":0,"no_show_rate_pct":0,"top_classes":[{"name":"","visits":0,"fill_rate_pct":0}],"bottom_classes":[{"name":"","visits":0,"fill_rate_pct":0}]},
  "dorian": {"critical":[{"name":"","email":"","phone":"","membership":"","last_visit":"","days_since_visit":0,"lifetime_visits":0,"member_since":""}],"watch":[],"lost":[],"win_back":[{"name":"","email":"","phone":"","membership":"","cancel_date":""}]},
  "intelligence": {"headline":"","actions":["","",""],"risk":"","bright_spot":""},
  "warnings":[]
}

Intelligence rules:
- headline: one sentence, most important thing about this week
- actions: 3 specific tactical recommendations with real numbers
- risk: single biggest threat to the business this week
- bright_spot: one thing working well that could be doubled down on`;
}
