const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'read.js'), 'utf8')
  .replace('export default async function handler', 'async function handler');
const context = vm.createContext({console, Date, Math, Number, Object, String, Array, JSON, setTimeout, clearTimeout, AbortController});
vm.runInContext(`${source}\n;globalThis.apiReadTest = {cleanDate, normalise};`, context);

test('keeps the calendar date when normalising an ISO timestamp', () => {
  assert.equal(context.apiReadTest.cleanDate('2026-07-20T00:00:00.000Z'), '2026-07-20');
});

test('recalculates legacy saved revenue on a consistent time basis', () => {
  const week = context.apiReadTest.normalise({
    week_of:'2026-07-20T00:00:00.000Z',
    revenue:{mrr:38132, pack_and_class:8702, total_weekly:46834, mrr_pct:81, revenue_per_member:279},
    membership:{active_count:168},
    new_founder_members:[{membership:'Prana Membership'}],
    avg_founder_visits:2.4,
    founder_classes:[{name:'Sculpt'}],
  });
  assert.equal(week.revenue.weekly_mrr_equivalent, 8800);
  assert.equal(week.revenue.weekly_revenue_run_rate, 17502);
  assert.equal(week.revenue.monthly_revenue_run_rate, 75841);
  assert.equal(week.revenue.annual_revenue_run_rate, 910088);
  assert.equal(week.revenue.mrr_pct, 50);
  assert.equal(week.revenue.revenue_per_member, 451);
  assert.equal(week.new_members.length, 1);
  assert.equal(week.avg_member_visits, 2.4);
  assert.equal(week.member_classes.length, 1);
});
