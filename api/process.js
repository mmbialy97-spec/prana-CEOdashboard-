const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyyqmSW4DM178V3C9W1H4Isnhh_t8bhwo1V1yLVjpAzvdSeoXaHIhkpcqfHjQjbfe-K/exec';

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

    // Step 1: fetch previous week FIRST so we can include it in Claude's context
    let previous = null;
    try {
      const prevRes   = await fetch(APPS_SCRIPT_URL + '?action=get_previous&week_of=' + encodeURIComponent(data.week_of), { redirect: 'follow' });
      const prevText  = await prevRes.text();
      const prevClean = prevText.trim().replace(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(/, '').replace(/\)\s*;?\s*$/, '');
      const prevData  = JSON.parse(prevClean);
      if (prevData.ok) previous = prevData.data;
    } catch { /* optional — first upload has no previous */ }

    // Step 2: build slim payload for Claude (small arrays only)
    const slimData = {
      week_of:             data.week_of,
      sales_total:         data.sales_total,
      autopay_total:       data.autopay_total,
      active_count:        data.active_count,
      cancelled_count:     data.cancelled_count,
      first_visit_count:   data.first_visit_count,
      first_time_visitors: data.first_time_visitors,
      no_show_count:       data.no_show_count,
      avg_founder_visits:  data.avg_founder_visits,
      health_summary:      data.health_summary,
      no_return_members:   (data.no_return_members  || []).slice(0, 10),
      cancelled_members:   (data.cancelled_members  || []).slice(0, 5),
      new_founder_members: (data.new_founder_members|| []).slice(0, 5),
      class_data:          (data.class_data         || []).slice(0, 10),
      founder_classes:     (data.founder_classes    || []).slice(0, 5),
      instructor_data:     (data.instructor_data    || []).slice(0, 5),
      peak_times:          (data.peak_times         || []).slice(0, 5),
      peak_days:           (data.peak_days          || []).slice(0, 7),
    };

    // Add previous week summary for trajectory-aware insights
    if (previous) {
      slimData.previous_week = {
        week_of:       previous.week_of,
        active_count:  previous.membership?.active_count  || previous.active_count  || 0,
        new_this_week: previous.membership?.new_this_week || 0,
        churned:       previous.membership?.churned_this_week || 0,
        mrr:           previous.revenue?.mrr || previous.autopay_total || 0,
        avg_visits:    previous.avg_founder_visits || 0,
      };
    }

    // Step 3: call Claude
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 8000,
        messages: [{ role: 'user', content: buildPrompt(slimData) }]
      })
    });

    const claude = await response.json();

    if (!claude.content || !claude.content[0]) {
      return res.status(500).json({ error: 'No response from Claude', detail: claude });
    }

    // Robust JSON extraction using brace counting
    let text = claude.content[0].text.trim();
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    let result;
    const startIdx = text.indexOf('{');
    if (startIdx === -1) {
      return res.status(500).json({ error: 'No JSON in Claude response', raw: text.substring(0, 500) });
    }
    let depth = 0, endIdx = -1;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    if (endIdx === -1) {
      return res.status(500).json({ error: 'Incomplete JSON in Claude response' });
    }
    try {
      result = JSON.parse(text.substring(startIdx, endIdx + 1));
    } catch(parseErr) {
      return res.status(500).json({ error: 'JSON parse failed: ' + parseErr.message, raw: text.substring(0, 500) });
    }

    result.week_of     = data.week_of;
    result.uploaded_at = new Date().toISOString();

    return res.status(200).json({ ok: true, current: result, previous });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function buildPrompt(data) {
  const today = new Date().toISOString().split('T')[0];
  return `You are the business intelligence engine for Prana Wellness Club, a boutique fitness studio in Austin, Texas.

ABOUT PRANA:
- Target: 800 Founder Members at full capacity
- Services: Pilates Reformer, Heated Sculpt, Heated Mat Pilates, Prana Vinyasa Flow, Yin, Private
- Revenue model: MRR = active_count × $199/month always. This is the only MRR formula.
- Key staff: Dorian owns Founder Member retention and outreach
- MRR target: >70% of total revenue should be Founder Member autopay
- CRITICAL: Only reference Founder Members in all analysis. Never mention ClassPass, Friends and Family, or drop-ins except as an acquisition opportunity in bright_spot only.
- Reformer Pilates is NOT included in any Founder Membership — it is a separate paid service.
- Founder Membership (Unlimited) covers: Yoga, Sculpt, Mat Pilates, Vinyasa, Yin

IMPORTANT DATA NOTES:
- autopay_total = active_count × $199 (MRR — always use this formula)
- sales_total = weekly non-recurring sales (secondary metric)
- active_count = Founder Members only
- avg_founder_visits = average visits per Founder Member this week. Target is 3+/week.
- health_summary = {green: 3+visits/month, amber: 1-2/month, red: 0 visits or 21+ days absent}

CALCULATION RULES:
- mrr = autopay_total (= active_count × $199)
- pack_and_class = sales_total
- mrr_pct = round(mrr / (mrr + sales_total) * 100)
- revenue_per_member = round(mrr / active_count)
- net_growth = first_visit_count minus cancelled_count
- churn_rate_pct = round(cancelled_count / active_count * 100, 1)
- progress_to_800_pct = round(active_count / 800 * 100)
- Today is ${today}
- critical = no_return where days_since_visit between 14 and 29, MAX 10
- watch = no_return where days_since_visit between 8 and 13, MAX 10
- lost = no_return where days_since_visit 30+, MAX 10
- win_back = cancelled_members list as-is
- total_visits = sum of all visits in class_data
- no_show_rate_pct = round(no_show_count / total_visits * 100)
- top_classes = top 3 by visits descending
- bottom_classes = bottom 3 by visits ascending, exclude 0 visits

${data.previous_week ? `PREVIOUS WEEK DATA (use for trajectory analysis):
${JSON.stringify(data.previous_week)}` : 'No previous week data — this is the first upload.'}

WEEKLY DATA:
${JSON.stringify(data)}

INTELLIGENCE — CEO LEVEL. Qualitative AND quantitative. Only reference Founder Members.

headline: One punchy sentence with the most important business reality. If previous week exists, reference trajectory (growth trend, MRR movement, member count change over both weeks).

insight: 2-3 sentences. If previous week exists, ALWAYS compare trajectory — members, MRR, churn, visits this week vs last week. Show the trend direction. Think like a business advisor, not a data analyst.

actions: Exactly 3 actions. Mix of STRATEGIC (CEO decides) and DELEGATION (CEO assigns to team).
- Do NOT name individual members in actions
- Mix 1-2 strategic + 1-2 delegation per response

risk: The single most urgent CEO-level threat with specific numbers.

bright_spot: One specific metric or pattern that is working. Be concrete with numbers.

RETURN ONLY THIS JSON, NOTHING ELSE:
{"revenue":{"total_weekly":0,"mrr":0,"mrr_pct":0,"pack_and_class":0,"revenue_per_member":0},"membership":{"active_count":0,"new_this_week":0,"churned_this_week":0,"net_growth":0,"churn_rate_pct":0,"retention_rate_pct":0,"progress_to_800_pct":0},"attendance":{"avg_fill_rate_pct":0,"total_visits":0,"no_show_rate_pct":0,"top_classes":[{"name":"","visits":0,"fill_rate_pct":0}],"bottom_classes":[{"name":"","visits":0,"fill_rate_pct":0}]},"dorian":{"critical":[],"watch":[],"lost":[],"win_back":[]},"intelligence":{"headline":"","insight":"","actions":["","",""],"risk":"","bright_spot":""},"warnings":[]}`;
}
