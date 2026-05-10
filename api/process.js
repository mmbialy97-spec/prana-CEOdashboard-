// ════════════════════════════════════════════════════════════════
//  pages/api/process.js — Prana CEO Dashboard
//  CHANGELOG (2026-04-27)
//  ────────────────────────────────────────────────────────────────
//  1. MRR formula corrected: count × $200 (was $199)
//  2. Active Founder source standardised to 07_retention_management
//     (Status='Active' AND Membership Type contains 'Founder')
//  3. Pack & Class Sales now excludes Founder rows from 01_sales
//  4. Weekly Sales = MRR contribution + non-autopay (total revenue)
//  5. MRR Stability target copy fixed
//  6. Revenue/Member redefined as total weekly rev ÷ active members
//  7. Class avg copy ("of 98") fixed: now per-session, not total
//  8. Failed payments passed through for Payment Issues card
// ════════════════════════════════════════════════════════════════

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyXKb1IAu8YGfmP86Z8eL4B3YEvKE5cLh6k1MgGOAM2BQ_FRd9zIHbFco631fIFxq07/exec';

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

    // ── Fetch previous week (for wow comparisons) ──
    let previous = null;
    try {
      const prevRes   = await fetch(APPS_SCRIPT_URL + '?action=get_previous&week_of=' + encodeURIComponent(data.week_of), { redirect: 'follow' });
      const prevText  = await prevRes.text();
      const prevClean = prevText.trim().replace(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(/, '').replace(/\)\s*;?\s*$/, '');
      const prevData  = JSON.parse(prevClean);
      if (prevData.ok) previous = prevData.data;
    } catch { /* optional */ }

    // ── Use history sent from browser (last 4 weeks already loaded) ──
    const historyWeeks = Array.isArray(data.history) ? data.history : [];

    const slimData = {
      week_of:             data.week_of,
      sales_total:         data.sales_total,           // Now = non-Founder sales only
      non_autopay_total:   data.non_autopay_total,     // Same as sales_total, kept for clarity
      mrr:                 data.mrr,                   // count × $200
      total_weekly_revenue:data.total_weekly_revenue,  // mrr + non_autopay
      active_count:        data.active_count,
      new_this_week:       data.first_visit_count,
      cancelled_count:     data.cancelled_count,
      first_time_visitors: data.first_time_visitors,
      no_show_count:       data.no_show_count,
      avg_founder_visits:  data.avg_founder_visits,
      health_summary:      data.health_summary,
      total_sessions:      data.total_sessions,
      avg_per_session:     data.avg_per_session,
      failed_payments:     (data.failed_payments     || []).slice(0, 20),
      no_return_members:   (data.no_return_members   || []).slice(0, 10),
      cancelled_members:   (data.cancelled_members   || []).slice(0, 5),
      new_founder_members: (data.new_founder_members || []).slice(0, 5),
      class_data:          (data.class_data          || []).slice(0, 10),
      class_schedule:      (data.class_schedule      || []).slice(0, 60),
      founder_classes:     (data.founder_classes     || []).slice(0, 5),
      instructor_data:     (data.instructor_data     || []).slice(0, 5),
      peak_times:          (data.peak_times          || []).slice(0, 5),
      peak_days:           (data.peak_days           || []).slice(0, 7),
    };

    if (previous) {
      slimData.previous_week = {
        week_of:       previous.week_of,
        active_count:  previous.membership?.active_count  || previous.active_count  || 0,
        new_this_week: previous.membership?.new_this_week || 0,
        churned:       previous.membership?.churned_this_week || 0,
        mrr:           previous.revenue?.mrr || 0,
        avg_visits:    previous.avg_founder_visits || 0,
      };
    }

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
        messages: [{ role: 'user', content: buildPrompt(slimData, historyWeeks) }]
      })
    });

    const claude = await response.json();

    if (!claude.content || !claude.content[0]) {
      return res.status(500).json({ error: 'No response from Claude', detail: claude });
    }

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

function buildPrompt(data, history) {
  const today = new Date().toISOString().split('T')[0];
  const hasHistory = history && history.length > 0;

  return `You are the business intelligence engine for Prana Wellness Club, a boutique fitness studio in Austin, Texas.

ABOUT PRANA:
- Target: 800 Founder Members at full capacity
- Services: Pilates Reformer, Heated Sculpt, Heated Mat Pilates, Prana Vinyasa Flow, Yin, Private
- Revenue model: MRR = active_count × $200/month always. This is the only MRR formula.
- Key staff: Dorian owns Founder Member retention and outreach
- MRR target: >70% of total revenue should be Founder Member autopay
- CRITICAL: Only reference Founder Members in all analysis. Never mention ClassPass, Friends and Family, or drop-ins except as an acquisition opportunity in bright_spot only.
- Reformer Pilates is NOT included in any Founder Membership — it is a separate paid service.
- Founder Membership (Unlimited) covers: Yoga, Sculpt, Mat Pilates, Vinyasa, Yin

IMPORTANT DATA NOTES:
- mrr = active_count × $200 (this is the canonical MRR — always use this)
- non_autopay_total = sum of 01_sales Item Total EXCLUDING any row with "Founder" in Item name (drop-ins, packs, late fees, no-show fees)
- sales_total alias = non_autopay_total (same value)
- total_weekly_revenue = mrr + non_autopay_total (the CEO-level "Weekly Sales" figure)
- active_count = Founder Members from 07_retention_management filtered to Status=Active AND Membership Type contains 'Founder'
- new_this_week = Founder Members who joined THIS WEEK ONLY (not cumulative)
- cancelled_count = Founder Members who cancelled THIS WEEK ONLY (not cumulative)
- avg_founder_visits = average visits per Founder Member this week. Target is 3+/week.
- health_summary = {green: 3+visits/month, amber: 1-2 visits/month, red: 0 visits or 21+ days absent}
- failed_payments = Founder Members whose autopay charge was Suspended or Declined this week — these are revenue at risk
- total_sessions = total class sessions held this week (denominator for "average attendance per session")
- avg_per_session = total_visits ÷ total_sessions (typical class size — use this NOT total visits when discussing class performance)
- class_schedule = optional current schedule CSV, normalized as class name, day/date, time, instructor, room, capacity, booked, waitlist. Use it to compare current attendance patterns against what is actually on the schedule.

CALCULATION RULES:
- mrr is already calculated; do NOT recompute
- pack_and_class = non_autopay_total
- mrr_pct = round(mrr / total_weekly_revenue * 100)
- revenue_per_member = round(total_weekly_revenue / active_count)  ← uses TOTAL revenue, not just MRR
- net_growth = new_this_week minus cancelled_count
- churned_this_week = cancelled_count
- churn_rate_pct = round(cancelled_count / active_count * 100, 1)
- progress_to_800_pct = round(active_count / 800 * 100)
- failed_payment_count = length of failed_payments array
- arr_at_risk = failed_payment_count × $200 × 12 (annualised value at risk if these cards aren't fixed)
- Today is ${today}
- critical = members with 0 visits in past 14-29 days, MAX 10
- watch = members with 1-2 visits/month (amber health), MAX 10
- lost = members with 0 visits for 30+ days, MAX 10
- win_back = cancelled_members list as-is
- total_visits = sum of all visits in class_data
- no_show_rate_pct = round(no_show_count / total_visits * 100)
- top_classes = top 3 by visits descending
- bottom_classes = bottom 3 by visits ascending, exclude 0 visits

CLASS LANGUAGE RULES (avoid the old "98" bug):
- When commenting on whether a class underperforms, compare its per-session attendance to avg_per_session, NOT to total_visits.
- Example phrasing: "Yoga Sculpt averaged 8.5 attendees per session vs studio average of ${'${avg_per_session}'}/session"
- Never say "less than half of 98" — 98 was actually the count of sessions, not attendance.
- If class_schedule exists, use it for tactical schedule decisions: keep, add, cut, move, or staff classes based on uploaded schedule plus attendance demand.

${data.previous_week ? `PREVIOUS WEEK DATA (use for trajectory analysis):
${JSON.stringify(data.previous_week)}` : 'No previous week data — this is the first upload.'}

WEEKLY DATA:
${JSON.stringify(data)}

${hasHistory ? `HISTORICAL TREND DATA (${history.length} previous weeks, oldest first):
${JSON.stringify(history)}` : 'No historical trend data available yet.'}

INTELLIGENCE — CEO LEVEL. Qualitative AND quantitative. Only reference Founder Members.

headline: One punchy sentence with the most important business reality. If previous week exists, reference trajectory. If MRR is above 70% of total revenue, lead with that being a HEALTHY signal — do not frame as "missing the target" when the target is hit.

insight: 2-3 sentences comparing trajectory — members, MRR, churn, visits this week vs last week.

actions: Exactly 3 actions. Mix of STRATEGIC (CEO decides) and DELEGATION (CEO assigns to team). If failed_payments > 0, one action MUST be to recover those failed payments before they become churn.
- Do NOT name individual members in actions
- Mix 1-2 strategic + 1-2 delegation per response

risk: The single most urgent CEO-level threat with specific numbers. If failed_payment_count >= 3, this is your risk — call out arr_at_risk in dollars.

bright_spot: One specific metric or pattern that is working. Be concrete with numbers.

TRENDS INTELLIGENCE — populate based on ${hasHistory ? history.length + ' weeks of history plus this week' : 'this week only (note limited data)'}:

trend_summary: 2 sentences. What is the single most important multi-week pattern? Is the business accelerating, stalling, or declining? Be direct.

churn_diagnosis: 1-2 sentences. Is churn accelerating, stable, or improving? What does the pattern suggest — onboarding failure, engagement drop, or external?

engagement_signal: 1-2 sentences. Is avg_visits/member trending up or down? Flag if it is dropping as a leading indicator of upcoming churn.

projection: Based on average weekly net_growth across all available weeks, state plainly: "At current pace (+X net/week avg), you reach 800 in Y weeks (~Z months)." If net growth is negative, state how long until membership drops to a critical threshold instead.

trend_actions: Exactly 3 tactical actions driven by the multi-week patterns. Each must reference a specific number from the trend data. Label each as URGENT, THIS WEEK, or THIS MONTH.

RETURN ONLY THIS JSON, NOTHING ELSE:
{"revenue":{"total_weekly":0,"mrr":0,"mrr_pct":0,"pack_and_class":0,"revenue_per_member":0,"arr_at_risk":0},"membership":{"active_count":0,"new_this_week":0,"churned_this_week":0,"net_growth":0,"churn_rate_pct":0,"retention_rate_pct":0,"progress_to_800_pct":0,"failed_payment_count":0},"attendance":{"avg_fill_rate_pct":0,"total_visits":0,"total_sessions":0,"avg_per_session":0,"no_show_rate_pct":0,"top_classes":[{"name":"","visits":0,"fill_rate_pct":0}],"bottom_classes":[{"name":"","visits":0,"fill_rate_pct":0}]},"dorian":{"critical":[],"watch":[],"lost":[],"win_back":[]},"intelligence":{"headline":"","insight":"","actions":["","",""],"risk":"","bright_spot":""},"trends_intelligence":{"trend_summary":"","churn_diagnosis":"","engagement_signal":"","projection":"","trend_actions":[{"label":"","action":""},{"label":"","action":""},{"label":"","action":""}]},"warnings":[]}`;
}
