// ════════════════════════════════════════════════════════════════
//  pages/api/process.js — Prana CEO Dashboard
//  CHANGELOG
//  ────────────────────────────────────────────────────────────────
//  2026-05-26
//  1. Active member source supports Founder, Prana, and Prana Plus.
//  2. MRR is browser-calculated from tier pricing, not a single $200 rate.
//  3. Pack & Class Sales excludes all membership rows from 01_sales.
//  4. Legacy founder_* keys are treated as active-member compatibility keys.
// ════════════════════════════════════════════════════════════════

const AI_TIMEOUT_MS = 22000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const data = req.body;
    if (!data?.week_of) return res.status(400).json({ ok: false, error: 'No data received' });

    const historyWeeks = (Array.isArray(data.history) ? data.history : [])
      .filter(item => item?.week_of)
      .sort((a, b) => String(a.week_of).localeCompare(String(b.week_of)));
    const previousSummary = historyWeeks.at(-1) || null;
    const previous = previousSummary ? summaryToPrevious(previousSummary) : null;
    const slimData = buildSlimData(data, previousSummary);

    let result = null;
    let source = 'calculated';
    const key = process.env.ANTHROPIC_KEY;

    if (key) {
      try {
        result = await requestClaude(key, slimData, historyWeeks);
        source = 'claude';
      } catch (error) {
        console.warn('[dashboard-process] AI unavailable, using calculated result', { error: errorMessage(error) });
      }
    }

    if (!result) result = buildCalculatedResult(data, historyWeeks);
    result.week_of = data.week_of;
    result.uploaded_at = new Date().toISOString();

    console.log('[dashboard-process] completed', { week_of: data.week_of, source });
    return res.status(200).json({ ok: true, current: result, previous, source });
  } catch (error) {
    console.error('[dashboard-process] failed', { error: errorMessage(error) });
    return res.status(500).json({ ok: false, error: 'The uploaded reports could not be processed.' });
  }
}

function buildSlimData(data, previousSummary) {
  const slimData = {
    week_of: data.week_of,
    sales_total: data.sales_total,
    non_autopay_total: data.non_autopay_total,
    mrr: data.mrr,
    total_weekly_revenue: data.total_weekly_revenue,
    active_count: data.active_count,
    new_this_week: data.first_visit_count,
    cancelled_count: data.cancelled_count,
    flow_net_growth: data.first_visit_count - data.cancelled_count,
    first_time_visitors: data.first_time_visitors,
    no_show_count: data.no_show_count,
    avg_founder_visits: data.avg_founder_visits,
    avg_member_visits: data.avg_founder_visits,
    health_summary: data.health_summary,
    total_sessions: data.total_sessions,
    avg_per_session: data.avg_per_session,
    failed_payments: (data.failed_payments || []).slice(0, 20),
    no_return_members: (data.no_return_members || []).slice(0, 10),
    cancelled_members: (data.cancelled_members || []).slice(0, 5),
    new_founder_members: (data.new_founder_members || []).slice(0, 5),
    member_product_counts: data.member_product_counts || {},
    class_data: (data.class_data || []).slice(0, 10),
    class_schedule: (data.class_schedule || []).slice(0, 60),
    founder_classes: (data.founder_classes || []).slice(0, 5),
    member_classes: (data.founder_classes || []).slice(0, 5),
    instructor_data: (data.instructor_data || []).slice(0, 5),
    peak_times: (data.peak_times || []).slice(0, 5),
    peak_days: (data.peak_days || []).slice(0, 7)
  };
  if (previousSummary) slimData.previous_week = previousSummary;
  return slimData;
}

async function requestClaude(key, slimData, historyWeeks) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 2400,
        messages: [{ role: 'user', content: buildPrompt(slimData, historyWeeks) }]
      })
    });
    if (!response.ok) throw new Error(`Claude returned HTTP ${response.status}`);
    const claude = await response.json();
    const text = claude.content?.[0]?.text;
    if (!text) throw new Error('Claude returned no content');
    return parseClaudeResult(text);
  } finally {
    clearTimeout(timeout);
  }
}

function parseClaudeResult(value) {
  const text = String(value).replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const startIdx = text.indexOf('{');
  if (startIdx === -1) throw new Error('Claude returned no JSON');
  let depth = 0;
  for (let index = startIdx; index < text.length; index++) {
    if (text[index] === '{') depth++;
    if (text[index] === '}') depth--;
    if (depth === 0) return JSON.parse(text.substring(startIdx, index + 1));
  }
  throw new Error('Claude returned incomplete JSON');
}

function summaryToPrevious(summary) {
  return {
    week_of: summary.week_of,
    membership: {
      active_count: number(summary.active_count),
      new_this_week: number(summary.new_this_week),
      churned_this_week: number(summary.churned),
      net_growth: number(summary.net_growth)
    },
    revenue: { mrr: number(summary.mrr) },
    avg_founder_visits: number(summary.avg_visits),
    health_summary: summary.health || {}
  };
}

function buildCalculatedResult(data, historyWeeks) {
  const active = number(data.active_count);
  const joined = number(data.first_visit_count);
  const churned = number(data.cancelled_count);
  const flowNet = joined - churned;
  const previous = historyWeeks.at(-1);
  const previousActive = previous ? number(previous.active_count) : null;
  const netGrowth = previousActive == null ? flowNet : active - previousActive;
  const churnRate = active > 0 ? Math.round(churned / active * 1000) / 10 : 0;
  const mrr = number(data.mrr);
  const totalRevenue = number(data.total_weekly_revenue);
  const nonAutopay = number(data.non_autopay_total);
  const classData = Array.isArray(data.class_data) ? data.class_data : [];
  const totalVisits = classData.reduce((sum, item) => sum + number(item.visits), 0);
  const classesWithVisits = classData.filter(item => number(item.visits) > 0);
  const classRow = item => ({ name: String(item.name || ''), visits: number(item.visits), fill_rate_pct: number(item.fill_rate_pct) });
  const topClasses = [...classesWithVisits].sort((a, b) => number(b.visits) - number(a.visits)).slice(0, 3).map(classRow);
  const bottomClasses = [...classesWithVisits].sort((a, b) => number(a.visits) - number(b.visits)).slice(0, 3).map(classRow);
  const fillRates = classData.map(item => number(item.fill_rate_pct)).filter(value => value > 0);
  const avgFillRate = fillRates.length ? Math.round(fillRates.reduce((sum, value) => sum + value, 0) / fillRates.length) : 0;
  const failedCount = (data.failed_payments || []).length;
  const urgentCount = ['never_visited', 'critical', 'lost']
    .reduce((sum, key) => sum + (data.browser_dorian?.[key] || []).length, 0);
  const movement = netGrowth > 0 ? `up ${netGrowth}` : netGrowth < 0 ? `down ${Math.abs(netGrowth)}` : 'flat';
  const historicalGrowth = historyWeeks.map(item => number(item.net_growth));
  const avgGrowth = Math.round(([...historicalGrowth, netGrowth].reduce((sum, value) => sum + value, 0) / (historicalGrowth.length + 1)) * 10) / 10;
  const weeksToTarget = avgGrowth > 0 ? Math.ceil(Math.max(800 - active, 0) / avgGrowth) : null;
  const projection = weeksToTarget == null
    ? `At the current ${avgGrowth} net members per week, growth must improve before projecting 800 members.`
    : `At the current ${avgGrowth} net members per week, 800 members is approximately ${weeksToTarget} weeks away.`;

  return {
    revenue: {
      total_weekly: totalRevenue,
      mrr,
      mrr_pct: totalRevenue > 0 ? Math.round(mrr / totalRevenue * 100) : 0,
      pack_and_class: nonAutopay,
      revenue_per_member: active > 0 ? Math.round(totalRevenue / active) : 0,
      arr_at_risk: 0
    },
    membership: {
      active_count: active,
      new_this_week: joined,
      churned_this_week: churned,
      net_growth: netGrowth,
      other_status_changes: netGrowth - flowNet,
      churn_rate_pct: churnRate,
      retention_rate_pct: Math.round((100 - churnRate) * 10) / 10,
      progress_to_800_pct: Math.round(active / 800 * 100),
      failed_payment_count: failedCount
    },
    attendance: {
      avg_fill_rate_pct: avgFillRate,
      total_visits: totalVisits,
      total_sessions: number(data.total_sessions),
      avg_per_session: number(data.avg_per_session),
      no_show_rate_pct: totalVisits > 0 ? Math.round(number(data.no_show_count) / totalVisits * 1000) / 10 : 0,
      top_classes: topClasses,
      bottom_classes: bottomClasses
    },
    dorian: data.browser_dorian || { critical: [], watch: [], lost: [], win_back: [] },
    intelligence: {
      headline: `Active membership is ${active}, ${movement} from the previous loaded week.`,
      insight: `${joined} members joined and ${churned} churned this week. Average member visits were ${number(data.avg_founder_visits)} per week.`,
      actions: [
        failedCount ? `Recover ${failedCount} failed member payment${failedCount === 1 ? '' : 's'} this week.` : 'Review membership movement and confirm this week\'s growth owner.',
        `Assign follow-up for ${urgentCount} urgent retention member${urgentCount === 1 ? '' : 's'}.`,
        `Use the ${number(data.avg_per_session)} average attendance per session to prioritise class decisions.`
      ],
      risk: failedCount ? `${failedCount} failed payment${failedCount === 1 ? '' : 's'} require immediate recovery.` : `${urgentCount} members are currently in urgent retention follow-up.`,
      bright_spot: `${active} active members generated ${mrr} in monthly recurring revenue.`
    },
    trends_intelligence: {
      trend_summary: `Membership is ${movement} versus the previous loaded week, with an average of ${avgGrowth} net members across the available history.`,
      churn_diagnosis: `${churned} members churned this week, a ${churnRate}% rate against active membership.`,
      engagement_signal: `Average member visits are ${number(data.avg_founder_visits)} per week against a target of 3 or more.`,
      projection,
      trend_actions: [
        { label: 'URGENT', action: `Complete outreach to ${urgentCount} urgent retention members.` },
        { label: 'THIS WEEK', action: `Recover ${failedCount} failed payments and confirm outcomes.` },
        { label: 'THIS MONTH', action: `Improve average visits from ${number(data.avg_founder_visits)} toward 3 per member per week.` }
      ]
    },
    warnings: []
  };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildPrompt(data, history) {
  const today = new Date().toISOString().split('T')[0];
  const hasHistory = history && history.length > 0;

  return `You are the business intelligence engine for Prana Wellness Club, a boutique fitness studio in Austin, Texas.

ABOUT PRANA:
- Target: 800 active paid members at full capacity
- Services: Pilates Reformer, Heated Sculpt, Heated Mat Pilates, Prana Vinyasa Flow, Yin, Private
- Revenue model: MRR is already calculated by the browser from active Founder, Prana, and Prana Plus members and their monthly amounts.
- Key staff: Dorian owns active member retention and outreach
- MRR target: >70% of total revenue should be active member autopay
- CRITICAL: Reference active Founder, Prana, and Prana Plus members in membership analysis. Never mention ClassPass, Friends and Family, or drop-ins except as an acquisition opportunity in bright_spot only.
- Reformer Pilates is not included in standard membership unless the uploaded membership product says otherwise; treat it as a separate paid service when uncertain.

IMPORTANT DATA NOTES:
- mrr = browser-calculated active member MRR (this is the canonical MRR — always use this)
- non_autopay_total = sum of 01_sales Item Total EXCLUDING Founder/Prana/Prana Plus membership purchases (drop-ins, packs, late fees, no-show fees)
- sales_total alias = non_autopay_total (same value)
- total_weekly_revenue = mrr + non_autopay_total (the CEO-level "Weekly Sales" figure)
- active_count = active Founder + Prana + Prana Plus members
- member_product_counts = count split for Founder vs Prana vs Prana Plus when available
- new_this_week = active members who joined THIS WEEK ONLY (not cumulative)
- cancelled_count = active members who cancelled THIS WEEK ONLY (not cumulative)
- flow_net_growth = new_this_week minus cancelled_count; this is acquisition/churn flow only
- avg_founder_visits = average visits per active member this week. Target is 3+/week.
- avg_member_visits is the same metric as avg_founder_visits; avg_founder_visits is a legacy JSON key and is not Founder-only.
- health_summary = {green: 3+visits/month, amber: 1-2 visits/month, red: 0 visits or 21+ days absent}
- failed_payments = active members whose autopay charge was Suspended or Declined this week — these are revenue at risk
- total_sessions = total class sessions held this week (denominator for "average attendance per session")
- avg_per_session = total_visits ÷ total_sessions (typical class size — use this NOT total visits when discussing class performance)
- class_schedule = optional current schedule CSV, normalized as class name, day/date, time, instructor, room, capacity, booked, waitlist. Use it to compare current attendance patterns against what is actually on the schedule.
- founder_classes is a legacy JSON key for active member-heavy classes. Treat it as all active paid members, not Founder-only.

CALCULATION RULES:
- mrr is already calculated; do NOT recompute
- pack_and_class = non_autopay_total
- mrr_pct = round(mrr / total_weekly_revenue * 100)
- revenue_per_member = round(total_weekly_revenue / active_count)  ← uses TOTAL revenue, not just MRR
- net_growth = active_count minus previous_week.active_count when previous_week exists; otherwise use flow_net_growth for the first upload only
- If net_growth differs from flow_net_growth, the difference is other_status_changes caused by status movement such as Suspended/Declined members returning to Active. Do not call this a calculation mismatch.
- churned_this_week = cancelled_count
- churn_rate_pct = round(cancelled_count / active_count * 100, 1)
- progress_to_800_pct = round(active_count / 800 * 100)
- failed_payment_count = length of failed_payments array
- arr_at_risk = browser-calculated annualised value at risk if these cards aren't fixed
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

INTELLIGENCE — CEO LEVEL. Qualitative AND quantitative. Reference active Founder, Prana, and Prana Plus members.

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
