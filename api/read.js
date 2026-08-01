const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyXKb1IAu8YGfmP86Z8eL4B3YEvKE5cLh6k1MgGOAM2BQ_FRd9zIHbFco631fIFxq07/exec';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, week_of } = req.query || {};
  let url = APPS_SCRIPT_URL + '?action=' + (action || 'read_latest');
  if (week_of) url += '&week_of=' + encodeURIComponent(week_of);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'Accept': 'application/json, text/plain, */*' }
    });
    clearTimeout(timeout);
    const text = await response.text();
    let json = text.trim();
    const match = json.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(([\s\S]*)\)\s*;?\s*$/);
    if (match) json = match[1].trim();
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      return res.status(200).json({ ok: false, message: 'No data yet' });
    }
    if (data.current)  data.current  = normalise(data.current);
    if (data.previous) data.previous = normalise(data.previous);
    if (data.weeks) {
      data.weeks = data.weeks
        .map(w => ({ ...w, week_of: cleanDate(w.week_of) }))
        .sort((a, b) => a.week_of > b.week_of ? 1 : -1);
    }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message || 'fetch failed' });
  }
}

function cleanDate(d) {
  if (!d) return d;
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  return s;
}

function normalise(c) {
  if (!c) return c;
  const raw = c.raw || {};
  if (c.week_of) c.week_of = cleanDate(c.week_of);
  if (!c.health_summary     && raw.health_summary)     c.health_summary     = raw.health_summary;
  if (!c.member_product_counts && raw.member_product_counts) c.member_product_counts = raw.member_product_counts;
  if (!c.member_product_mrr && raw.member_product_mrr) c.member_product_mrr = raw.member_product_mrr;
  if (!c.data_quality       && raw.data_quality)       c.data_quality       = raw.data_quality;
  if (!c.new_members) c.new_members = c.new_founder_members || raw.new_members || raw.new_founder_members || [];
  if (!c.new_founder_members) c.new_founder_members = c.new_members;
  if (c.avg_member_visits == null) c.avg_member_visits = c.avg_founder_visits ?? raw.avg_member_visits ?? raw.avg_founder_visits;
  if (!c.avg_founder_visits && raw.avg_founder_visits) c.avg_founder_visits = raw.avg_founder_visits;
  if (!c.class_data         && raw.class_data)         c.class_data         = raw.class_data;
  if (!c.member_classes) c.member_classes = c.founder_classes || raw.member_classes || raw.founder_classes || [];
  if (!c.founder_classes    && raw.founder_classes)    c.founder_classes    = raw.founder_classes;
  if (!c.first_time_visitors&& raw.first_visit_count)  c.first_time_visitors= raw.first_visit_count;
  if (!c.peak_times && raw.founder_times) c.peak_times = raw.founder_times.map(t=>({time:t.time,visits:t.count}));
  if (!c.peak_days  && raw.founder_days)  c.peak_days  = raw.founder_days.map(d=>({day:d.day,visits:d.count}));
  if (!c.instructor_data && raw.top_instructors) {
    c.instructor_data = raw.top_instructors.map(i=>({name:i.name,visits:i.visits,classes_taught:0,avg_per_class:0}));
  }
  const revenue = c.revenue || {};
  const mrr = Number(revenue.mrr || 0);
  const nonAutopay = Number(revenue.pack_and_class || raw.non_autopay_total || 0);
  if (mrr || nonAutopay) {
    const weeklyMrr = mrr * 12 / 52;
    const weeklyRunRate = weeklyMrr + nonAutopay;
    const monthlyRunRate = mrr + nonAutopay * 52 / 12;
    revenue.weekly_mrr_equivalent = Math.round(weeklyMrr);
    revenue.weekly_revenue_run_rate = Math.round(weeklyRunRate);
    revenue.monthly_revenue_run_rate = Math.round(monthlyRunRate);
    revenue.annual_revenue_run_rate = Math.round(mrr * 12 + nonAutopay * 52);
    revenue.total_weekly = revenue.weekly_revenue_run_rate;
    revenue.mrr_pct = monthlyRunRate > 0 ? Math.round(mrr / monthlyRunRate * 100) : 0;
    const activeCount = Number(c.membership?.active_count || 0);
    revenue.revenue_per_member = activeCount > 0 ? Math.round(monthlyRunRate / activeCount) : 0;
    c.revenue = revenue;
  }
  if (raw.total_visits != null || raw.no_show_count != null) {
    c.attendance = c.attendance || {};
    const totalVisits = Number(raw.total_visits || c.attendance.total_visits || 0);
    const noShowCount = Number(raw.no_show_count || 0);
    const totalBookings = Number(raw.total_bookings || (totalVisits + noShowCount));
    c.attendance.total_visits = totalVisits;
    c.attendance.no_show_count = noShowCount;
    c.attendance.total_bookings = totalBookings;
    c.attendance.no_show_rate_pct = totalBookings > 0 ? Math.round(noShowCount / totalBookings * 1000) / 10 : 0;
  }
  if (c.dorian) {
    if (!c.dorian.never_visited) c.dorian.never_visited = [];
    if (!c.dorian.critical)      c.dorian.critical = [];
    if (!c.dorian.watch)         c.dorian.watch = [];
    if (!c.dorian.lost)          c.dorian.lost = [];
    if (!c.dorian.win_back)      c.dorian.win_back = [];
  }
  return c;
}
