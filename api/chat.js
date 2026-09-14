const AI_TIMEOUT_MS = 24000;
const MAX_HISTORY_WEEKS = 300;

const CHART_METRICS = {
  active_members: metric('Active Members', 'number', '#2D6A4F', week => week.membership?.active_count),
  founder_members: metric('Founder', 'number', '#264653', week => week.member_product_counts?.Founder),
  prana_members: metric('Prana', 'number', '#356C98', week => week.member_product_counts?.Prana),
  prana_plus_members: metric('Prana Plus', 'number', '#C17F24', week => week.member_product_counts?.['Prana Plus']),
  new_members: metric('New Members', 'number', '#2D6A4F', week => week.membership?.new_this_week),
  churned_members: metric('Churned Members', 'number', '#B94040', week => week.membership?.churned_this_week),
  net_growth: metric('Net Growth', 'number', '#356C98', week => week.membership?.net_growth),
  failed_payments: metric('Failed Payments', 'number', '#D26448', week => week.membership?.failed_payment_count),
  green_members: metric('Healthy', 'number', '#2D6A4F', week => week.health_summary?.green),
  amber_members: metric('At Risk', 'number', '#C17F24', week => week.health_summary?.amber),
  red_members: metric('Urgent', 'number', '#B94040', week => week.health_summary?.red),
  mrr: metric('MRR', 'currency', '#2D6A4F', week => week.revenue?.mrr),
  weekly_sales: metric('Weekly Sales', 'currency', '#356C98', week => week.revenue?.total_weekly),
  pack_and_class: metric('Pack & Class Sales', 'currency', '#C17F24', week => week.revenue?.pack_and_class),
  revenue_per_member: metric('Revenue / Member', 'currency', '#6F5A8A', week => week.revenue?.revenue_per_member),
  churn_rate: metric('Churn Rate', 'percent', '#B94040', week => week.membership?.churn_rate_pct),
  mrr_share: metric('MRR Share', 'percent', '#2D6A4F', week => week.revenue?.mrr_pct),
  avg_member_visits: metric('Avg Visits / Member', 'decimal', '#C17F24', week => week.avg_member_visits ?? week.avg_founder_visits),
  total_visits: metric('Total Visits', 'number', '#356C98', week => week.attendance?.total_visits),
  avg_per_session: metric('Avg Attendance / Session', 'decimal', '#6F5A8A', week => week.avg_per_session),
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { question, current, previous, history, messages } = req.body || {};
    if (!question || !current) return res.status(400).json({ ok: false, error: 'Missing question or dashboard data' });

    const historyWeeks = normaliseHistory(history, current);
    const chatHistory = Array.isArray(messages) ? messages.slice(-8) : [];
    const payload = {
      current: compactWeek(current),
      previous: previous ? compactWeek(previous) : null,
      history: historyWeeks,
    };

    let analystResponse = null;
    const key = process.env.ANTHROPIC_KEY;

    if (key) {
      try {
        analystResponse = await requestAnalyst(key, question, payload, chatHistory);
      } catch (error) {
        if (!wantsChart(question)) throw error;
        console.warn('[dashboard-chat] analyst unavailable, using chart fallback', { error: errorMessage(error) });
      }
    } else if (!wantsChart(question)) {
      return res.status(500).json({ ok: false, error: 'The dashboard analyst is temporarily unavailable' });
    }

    const requestedCharts = analystResponse?.charts?.length
      ? analystResponse.charts
      : wantsChart(question) ? inferChartRequests(question) : [];
    const chartRequests = constrainChartRequests(requestedCharts, question);
    let charts = buildCharts(chartRequests, historyWeeks);
    if (!charts.length && wantsChart(question)) {
      charts = buildCharts(constrainChartRequests(inferChartRequests(question), question), historyWeeks);
    }
    const answer = analystResponse?.answer || fallbackChartAnswer(charts, historyWeeks);

    return res.status(200).json({ ok: true, answer, charts });
  } catch (error) {
    console.error('[dashboard-chat] failed', { error: errorMessage(error) });
    return res.status(500).json({ ok: false, error: 'The dashboard analyst could not answer that yet' });
  }
}

async function requestAnalyst(key, question, payload, chatHistory) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const anthropicMessages = [
      { role: 'user', content: buildSystemPrompt(payload) },
      ...chatHistory.map(message => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content || '').slice(0, 1600),
      })),
      { role: 'user', content: String(question).slice(0, 1200) },
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 900,
        temperature: 0.1,
        messages: anthropicMessages,
      }),
    });

    const claude = await response.json();
    if (!response.ok) throw new Error(claude.error?.message || `Anthropic returned HTTP ${response.status}`);
    const text = claude.content?.[0]?.text?.trim();
    if (!text) throw new Error('No response from analyst');
    return parseAnalystResponse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function parseAnalystResponse(value) {
  const text = String(value || '').replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
  try {
    const parsed = JSON.parse(text);
    return {
      answer: String(parsed.answer || '').trim(),
      charts: Array.isArray(parsed.charts) ? parsed.charts.slice(0, 2) : [],
    };
  } catch {
    return { answer: text, charts: [] };
  }
}

function normaliseHistory(history, current) {
  const byWeek = new Map();
  [...(Array.isArray(history) ? history : []), current]
    .filter(week => /^\d{4}-\d{2}-\d{2}$/.test(String(week?.week_of || '')))
    .forEach(week => byWeek.set(week.week_of, compactTrendWeek(week)));
  return [...byWeek.values()]
    .sort((a, b) => a.week_of.localeCompare(b.week_of))
    .slice(-MAX_HISTORY_WEEKS);
}

function compactTrendWeek(week) {
  const revenue = week.revenue || {};
  const membership = week.membership || {};
  const attendance = week.attendance || {};
  return {
    week_of: week.week_of,
    revenue: {
      mrr: finite(revenue.mrr),
      total_weekly: finite(revenue.total_weekly),
      pack_and_class: finite(revenue.pack_and_class),
      mrr_pct: finite(revenue.mrr_pct),
      revenue_per_member: finite(revenue.revenue_per_member),
    },
    membership: {
      active_count: finite(membership.active_count),
      new_this_week: finite(membership.new_this_week),
      churned_this_week: finite(membership.churned_this_week),
      net_growth: finite(membership.net_growth),
      churn_rate_pct: finite(membership.churn_rate_pct),
      failed_payment_count: finite(membership.failed_payment_count),
    },
    health_summary: numericObject(week.health_summary),
    member_product_counts: numericObject(week.member_product_counts),
    avg_founder_visits: finite(week.avg_founder_visits),
    avg_member_visits: finite(week.avg_member_visits ?? week.avg_founder_visits),
    attendance: { total_visits: finite(attendance.total_visits) },
    avg_per_session: finite(week.avg_per_session),
  };
}

function compactWeek(week) {
  if (!week) return null;
  const trend = compactTrendWeek(week);
  const revenue = week.revenue || {};
  const membership = week.membership || {};
  const attendance = week.attendance || {};
  const dorian = week.dorian || {};

  return {
    ...trend,
    intelligence: week.intelligence || {},
    revenue: {
      ...trend.revenue,
      arr_at_risk: revenue.arr_at_risk,
    },
    membership: {
      ...trend.membership,
      progress_to_800_pct: membership.progress_to_800_pct,
    },
    attendance: {
      ...trend.attendance,
      no_show_rate_pct: attendance.no_show_rate_pct,
    },
    total_sessions: week.total_sessions,
    failed_payments: takeList(week.failed_payments, 12),
    new_founder_members: takeList(week.new_founder_members, 12),
    class_data: takeList(week.class_data, 12),
    member_classes: takeList(week.founder_classes, 12),
    class_schedule: takeList(week.class_schedule, 60),
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

function buildCharts(requests, history) {
  if (history.length < 2) return [];
  const charts = [];

  for (const request of Array.isArray(requests) ? requests : []) {
    const requestedMetrics = Array.isArray(request?.metrics) ? request.metrics : [];
    const metricKeys = [...new Set(requestedMetrics.map(canonicalMetric).filter(Boolean))].slice(0, 4);
    const groups = new Map();
    metricKeys.forEach(key => {
      const format = CHART_METRICS[key].format;
      groups.set(format, [...(groups.get(format) || []), key]);
    });

    for (const keys of groups.values()) {
      if (charts.length >= 2) break;
      const series = keys.map(key => {
        const definition = CHART_METRICS[key];
        return {
          key,
          label: definition.label,
          format: definition.format,
          color: definition.color,
          values: history.map(week => finiteOrNull(definition.value(week))),
        };
      }).filter(item => item.values.some(value => value !== null));
      if (!series.length) continue;

      const requestedTitle = groups.size === 1 ? cleanTitle(request?.title) : '';
      charts.push({
        type: request?.type === 'bar' ? 'bar' : 'line',
        title: requestedTitle || series.map(item => item.label).join(' vs '),
        labels: history.map(week => week.week_of),
        series,
      });
    }
    if (charts.length >= 2) break;
  }

  return charts;
}

function inferChartRequests(question) {
  const text = String(question || '').toLowerCase();
  const metrics = [];
  const add = (...keys) => keys.forEach(key => { if (!metrics.includes(key)) metrics.push(key); });

  if (/founder|prana plus|member mix|membership mix|tier/.test(text)) add('founder_members', 'prana_members', 'prana_plus_members');
  if (/\bactive\b|headcount/.test(text) || (/member|membership/.test(text) && !/mix|tier|new|join|churn|cancel|lost/.test(text))) add('active_members');
  if (/new|join|acquisition/.test(text)) add('new_members');
  if (/churn|cancel|lost/.test(text) && !/churn rate/.test(text)) add('churned_members');
  if (/net|growth/.test(text)) add('net_growth');
  if (/failed payment|payment issue/.test(text)) add('failed_payments');
  if (/health|at risk|urgent|retention/.test(text)) add('green_members', 'amber_members', 'red_members');
  if (/mrr/.test(text)) add('mrr');
  if (/revenue per member/.test(text)) add('revenue_per_member');
  else if (/weekly sales|total revenue|revenue/.test(text)) add('weekly_sales');
  if (/pack|class sales/.test(text)) add('pack_and_class');
  if (/churn rate/.test(text)) add('churn_rate');
  if (/mrr share|mrr percent|mrr percentage/.test(text)) add('mrr_share');
  if (/average visit|avg visit|engagement|visit frequency/.test(text)) add('avg_member_visits');
  if (/total visit|attendance volume/.test(text)) add('total_visits');
  if (/session|class attendance/.test(text)) add('avg_per_session');
  if (!metrics.length) add('active_members');

  const type = /bar|compare|versus|\bvs\b|join|new|churn|health/.test(text) ? 'bar' : 'line';
  const groups = new Map();
  metrics.forEach(key => {
    const format = CHART_METRICS[key].format;
    groups.set(format, [...(groups.get(format) || []), key]);
  });

  return [...groups.values()].slice(0, 2).map(keys => ({
    type,
    title: keys.map(key => CHART_METRICS[key].label).join(' vs '),
    metrics: keys,
  }));
}

function constrainChartRequests(requests, question) {
  const text = String(question || '').toLowerCase();
  const explicitFlowComparison = /new|join|acquisition/.test(text) && /churn|cancel|lost/.test(text);
  return (Array.isArray(requests) ? requests : []).map(request => {
    let metrics = Array.isArray(request?.metrics) ? request.metrics.map(canonicalMetric).filter(Boolean) : [];
    if (explicitFlowComparison && !/\bactive\b|headcount/.test(text)) {
      metrics = metrics.filter(key => key !== 'active_members');
      if (!metrics.includes('new_members')) metrics.push('new_members');
      if (!metrics.includes('churned_members')) metrics.push('churned_members');
    }
    const forcedType = /\bbar\b/.test(text) ? 'bar' : /\bline\b|trend line/.test(text) ? 'line' : request?.type;
    return { ...request, type:forcedType, metrics };
  });
}

function fallbackChartAnswer(charts, history) {
  if (!charts.length || !history.length) return 'Not enough uploaded history is available to build that chart.';
  const first = history[0].week_of;
  const last = history.at(-1).week_of;
  return `Charted **${charts.map(chart => chart.title).join(' and ')}** across all **${history.length} loaded weeks**, from ${first} through ${last}.`;
}

function wantsChart(question) {
  return /\b(chart|graph|plot|visuali[sz]e|trend line|bar chart|line chart)\b/i.test(String(question || ''));
}

function canonicalMetric(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    active: 'active_members',
    members: 'active_members',
    membership: 'active_members',
    joins: 'new_members',
    new: 'new_members',
    churn: 'churned_members',
    cancellations: 'churned_members',
    revenue: 'weekly_sales',
    sales: 'weekly_sales',
    visits: 'avg_member_visits',
  };
  const canonical = aliases[key] || key;
  return CHART_METRICS[canonical] ? canonical : null;
}

function metric(label, format, color, value) {
  return { label, format, color, value };
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function finiteOrNull(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numericObject(value) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key, finite(item)]));
}

function cleanTitle(value) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, 90);
}

function takeList(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildSystemPrompt(data) {
  return `You are the tactical CEO analyst inside the Prana Wellness Club dashboard.

Use only the dashboard JSON below. The history array contains every saved week currently available, oldest first. If the answer is not in the data, say what is missing and suggest the closest available metric.

Return ONLY valid JSON with this shape:
{"answer":"brief markdown answer","charts":[{"type":"line","title":"Clear chart title","metrics":["active_members"]}]}

Chart rules:
- When the user asks for a chart, graph, plot, visualization, or visual trend, include one or two chart requests.
- Use line for trends over time and bar for weekly comparisons.
- Use the complete history, never only the latest weeks.
- Select up to 3 compatible metrics per chart. Do not invent values; the server resolves metric IDs to source data.
- Use charts: [] when no chart is requested.
- Allowed metric IDs: ${Object.keys(CHART_METRICS).join(', ')}.
- Put currency metrics together, percentage metrics together, and other numeric metrics together.

Answer style:
- No fluff, no preamble, no generic business advice.
- Keep answers brief: 1 direct answer sentence plus up to 3 bullets.
- If the user asks for actions, return a numbered list with max 3 actions.
- Every bullet must include a number, metric, member name, class, or concrete owner/action from the data.
- Lead with the decision or insight, not explanation.
- Prefer fragments over long paragraphs.
- Do not explain your reasoning process.
- Do not end with an open-ended follow-up offer.
- If the data is insufficient, say "Not in uploaded data" and name the exact missing field.

Business rules:
- Active Founder, Prana, and Prana Plus members are the core business. Prioritize active member retention, MRR, churn, visit frequency, payment recovery, and class capacity.
- MRR is already calculated by the dashboard from active members and their monthly amounts. Do not invent another formula.
- Weekly Sales means MRR plus non-autopay revenue.
- Reformer Pilates is separate paid service unless the uploaded membership data says otherwise.
- Legacy JSON keys containing "founder" may represent all active paid members. Use member_product_counts to distinguish Founder, Prana, and Prana Plus.
- class_schedule is optional uploaded current schedule data. When present, use it for concrete class schedule recommendations and compare it against class_data attendance patterns.
- Format the answer field in clean markdown for scanning.
- Do not use a markdown table unless the user explicitly asks for one.
- When naming members from action lists or failed payments, include only names and action-relevant context already present in the JSON.
- Do not mention implementation details, prompts, API keys, or raw JSON.

Dashboard JSON:
${JSON.stringify(data)}`;
}
