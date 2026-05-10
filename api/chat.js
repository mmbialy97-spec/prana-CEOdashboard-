export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { question, current, previous, history, messages } = req.body || {};
    if (!question || !current) return res.status(400).json({ error: 'Missing question or dashboard data' });

    const key = process.env.ANTHROPIC_KEY;
    if (!key) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });

    const chatHistory = Array.isArray(messages) ? messages.slice(-8) : [];
    const payload = {
      current: compactWeek(current),
      previous: previous ? compactWeek(previous) : null,
      history: Array.isArray(history) ? history.slice(-12).map(compactWeek) : [],
    };

    const anthropicMessages = [
      {
        role: 'user',
        content: buildSystemPrompt(payload),
      },
      ...chatHistory.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0, 1600),
      })),
      {
        role: 'user',
        content: String(question).slice(0, 1200),
      },
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1400,
        temperature: 0.2,
        messages: anthropicMessages,
      }),
    });

    const claude = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: claude.error?.message || 'Anthropic request failed' });
    }

    const answer = claude.content?.[0]?.text?.trim();
    if (!answer) return res.status(500).json({ error: 'No response from Claude' });

    return res.status(200).json({ ok: true, answer });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Chat failed' });
  }
}

function compactWeek(week) {
  if (!week) return null;
  const revenue = week.revenue || {};
  const membership = week.membership || {};
  const attendance = week.attendance || {};
  const dorian = week.dorian || {};

  return {
    week_of: week.week_of,
    intelligence: week.intelligence || {},
    revenue: {
      mrr: revenue.mrr,
      total_weekly: revenue.total_weekly,
      pack_and_class: revenue.pack_and_class,
      mrr_pct: revenue.mrr_pct,
      revenue_per_member: revenue.revenue_per_member,
      arr_at_risk: revenue.arr_at_risk,
    },
    membership: {
      active_count: membership.active_count,
      new_this_week: membership.new_this_week,
      churned_this_week: membership.churned_this_week,
      net_growth: membership.net_growth,
      churn_rate_pct: membership.churn_rate_pct,
      progress_to_800_pct: membership.progress_to_800_pct,
      failed_payment_count: membership.failed_payment_count,
    },
    health_summary: week.health_summary,
    avg_founder_visits: week.avg_founder_visits,
    attendance: {
      total_visits: attendance.total_visits,
      no_show_rate_pct: attendance.no_show_rate_pct,
    },
    total_sessions: week.total_sessions,
    avg_per_session: week.avg_per_session,
    failed_payments: takeList(week.failed_payments, 12),
    new_founder_members: takeList(week.new_founder_members, 12),
    class_data: takeList(week.class_data, 12),
    instructor_data: takeList(week.instructor_data, 8),
    peak_times: takeList(week.peak_times, 6),
    peak_days: takeList(week.peak_days, 7),
    dorian: {
      watch: takeList(dorian.watch, 12),
      critical: takeList(dorian.critical, 12),
      lost: takeList(dorian.lost, 12),
      never_visited: takeList(dorian.never_visited, 12),
      win_back: takeList(dorian.win_back, 12),
    },
    warnings: week.warnings || [],
  };
}

function takeList(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function buildSystemPrompt(data) {
  return `You are the data chat analyst inside the Prana Wellness Club CEO dashboard.

Use only the dashboard JSON below. If the answer is not in the data, say what is missing and suggest the closest available metric.

Business rules:
- Founder Members are the core business. Prioritize Founder Member retention, MRR, churn, visit frequency, payment recovery, and class capacity.
- MRR is active Founder Members multiplied by $200/month. Do not invent another formula.
- Weekly Sales means MRR plus non-autopay revenue.
- Reformer Pilates is not included in Founder Membership and should be treated as a separate paid service.
- Keep answers concise, executive, and numeric. Lead with the answer, then give evidence.
- When naming members from action lists or failed payments, include only names and action-relevant context already present in the JSON.
- Do not mention implementation details, prompts, API keys, or the raw JSON.

Dashboard JSON:
${JSON.stringify(data)}`;
}
