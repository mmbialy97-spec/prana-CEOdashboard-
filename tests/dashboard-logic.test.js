const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scriptStart = html.indexOf('<script>\n//');
const scriptEnd = html.indexOf('</script>', scriptStart);
const dashboardScript = html
  .slice(scriptStart + '<script>\n'.length, scriptEnd)
  .replace(/\ninit\(\);\s*$/, '');

const context = vm.createContext({
  console,
  Date,
  Math,
  Number,
  Object,
  Set,
  String,
  Array,
  JSON,
  parseFloat,
  parseInt,
  isNaN,
  setTimeout,
  clearTimeout,
});

vm.runInContext(`${dashboardScript}\n;globalThis.dashboardTest = {
  aggregate(fileMap) { state.fileMap = fileMap; return aggregateData(); },
  memberProductFromText,
  renderDashboard(current, previous = null, tab = 'overview') {
    state.dashData = {current, previous};
    state.selectedWeek = current.week_of;
    state.allWeeksData = [current];
    state.tab = tab;
    return renderDashboard();
  },
};`, context);

function fileMap(overrides = {}) {
  const rows = key => ({status: 'ok', rows: overrides[key] || []});
  return {
    '01_sales': rows('01_sales'),
    '02_autopay': rows('02_autopay'),
    '03_members_active': rows('03_members_active'),
    '04_members_cancelled': rows('04_members_cancelled'),
    '05_first_visit': rows('05_first_visit'),
    '06_no_return': rows('06_no_return'),
    '07_retention_management': rows('07_retention_management'),
    '08_retention': rows('08_retention'),
    '09_attendance_analysis': rows('09_attendance_analysis'),
    '10_attendance_no_revenue': rows('10_attendance_no_revenue'),
    '11_attendance_with_revenue': rows('11_attendance_with_revenue'),
    '12_class_visit': rows('12_class_visit'),
  };
}

function auditedFixture() {
  return fileMap({
    '01_sales': [
      {'Sale Date':'7/20/2026', 'Item name':'Prana Membership', 'Item Total':'249'},
      {'Sale Date':'7/21/2026', 'Item name':'Prana Plus Membership', 'Item Total':'379'},
      {'Sale Date':'7/22/2026', 'Item name':'Prana 10 Class Pack', 'Item Total':'100'},
      {'Sale Date':'7/23/2026', 'Item name':'Drop-in', 'Item Total':'50'},
    ],
    '02_autopay': [
      {Item:'Prana Membership', Status:'SUCCESS - Posted', Client:'Paid Member', Email:'paid@example.com'},
      {Item:'Prana Plus Membership', Status:'Declined', Client:'Plus Member', Email:'plus@example.com', Amount:'379'},
      {Item:'Prana Plus Membership', Status:'Declined - Retry', Client:'Plus Member', Email:'plus@example.com', Amount:'379'},
      {Item:'Prana 10 Class Pack', Status:'Declined', Client:'Pack Buyer', Email:'pack@example.com', Amount:'100'},
    ],
    '03_members_active': [
      {ID:'1', 'First name':'Ari', 'Last name':'Core', Email:'core@example.com', Status:'Active', Membership:'Prana Membership', 'Member Since':'7/20/2026', 'Check Ins 30 Day':'3', 'Check Ins YTD':'10'},
      {ID:'2', 'First name':'Pia', 'Last name':'Plus', Email:'plus@example.com', Status:'Current', Membership:'Prana Plus Membership', 'Member Since':'7/26/2026', 'Check Ins 30 Day':'1', 'Check Ins YTD':'1'},
      {ID:'3', 'First name':'Casey', 'Last name':'Cancelled', Email:'cancelled@example.com', Status:'Canceled', Membership:'Prana Membership', 'Member Since':'7/22/2026'},
      {ID:'4', 'First name':'Future', 'Last name':'Start', Email:'future@example.com', Status:'Active', Membership:'Prana Membership', 'Member Since':'7/27/2026'},
      {'First name':'5', 'Last name':'Taylor', ID:'Jordan', Email:'swapped@example.com', Status:'Active', Membership:'Prana Monthly', 'Member Since':'7/19/2026', 'Check Ins 30 Day':'2', 'Check Ins YTD':'4'},
      {ID:'9', 'First name':'Unknown', 'Last name':'Plan', Email:'unknown@example.com', Status:'Active', Membership:'Prana Elite Membership', 'Member Since':'7/22/2026'},
    ],
    '07_retention_management': [
      {ID:'6', 'First name':'Fran', 'Last name':'Founder', Email:'founder@example.com', Status:'Active', 'Membership Type':'Founder Membership', 'Member Since':'1/1/2026', 'Check Ins 30 Day':'4', 'Check Ins YTD':'30'},
      {ID:'1', 'First name':'Ari', 'Last name':'Core', Email:'core@example.com', Status:'Active', 'Membership Type':'Prana Membership', Last:'7/23/2026'},
      {ID:'7', 'First name':'Blank', 'Last name':'Status', Email:'blank@example.com', Status:'', 'Membership Type':'Prana Membership'},
    ],
    '04_members_cancelled': [
      {Name:'In Week', 'Cancellation Date':'7/21/2026', Membership:'Prana Plus Membership'},
      {Name:'Next Week', 'Cancellation Date':'7/27/2026', Membership:'Prana Membership'},
      {Name:'Total: 2', 'Cancellation Date':'', Membership:''},
    ],
    '05_first_visit': [
      {Client:'First Visitor'},
      {Client:'Total: 1'},
    ],
    '09_attendance_analysis': [
      {Description:'Sculpt', Status:'Signed in', 'Client ID':'5', Date:'7/22/2026', 'Start time':'9:00 AM', Staff:'Coach'},
      {Description:'Sculpt', Status:'Signed in', 'Client ID':'999', Date:'7/22/2026', 'Start time':'9:00 AM', Staff:'Coach'},
    ],
    '10_attendance_no_revenue': [
      {Status:'No Show'},
    ],
  });
}

test('recognises Prana memberships without treating branded class packs as memberships', () => {
  const classify = context.dashboardTest.memberProductFromText;
  assert.equal(classify('Prana'), 'prana');
  assert.equal(classify('Prana Annual'), 'prana');
  assert.equal(classify('Prana Plus Monthly'), 'prana_plus');
  assert.equal(classify('Prana+ Membership'), 'prana_plus');
  assert.equal(classify('Prana 10 Class Pack'), null);
  assert.equal(classify('Prana Elite Membership'), null);
});

test('counts and deduplicates active Founder, Prana, and Prana Plus members', () => {
  const data = context.dashboardTest.aggregate(auditedFixture());
  assert.equal(data.active_count, 5);
  assert.deepEqual({...data.member_product_counts}, {Prana:3, 'Prana Plus':1, Founder:1});
  assert.equal(data.mrr, 1326);
  assert.equal(data.data_quality.duplicates_merged, 1);
  assert.deepEqual([...data.data_quality.unknown_product_labels], ['Prana Elite Membership']);
});

test('bounds new members and cancellations to the selected Monday-Sunday week', () => {
  const data = context.dashboardTest.aggregate(auditedFixture());
  assert.equal(data.week_of, '2026-07-20');
  assert.equal(data.new_member_count, 2);
  assert.equal(data.new_members.length, 2);
  assert.deepEqual(Array.from(data.new_members, member => member.member_since).sort(), ['7/20/2026', '7/26/2026']);
  assert.equal(data.cancelled_count, 1);
  assert.equal(data.cancelled_members.length, 1);
});

test('aligns revenue periods before calculating totals and recurring share', () => {
  const data = context.dashboardTest.aggregate(auditedFixture());
  assert.equal(data.non_autopay_total, 150);
  assert.equal(data.weekly_mrr_equivalent, 306);
  assert.equal(data.weekly_revenue_run_rate, 456);
  assert.equal(data.monthly_revenue_run_rate, 1976);
  assert.equal(data.annual_revenue_run_rate, 23712);
  assert.equal(data.recurring_revenue_pct, 67);
});

test('uses normalized member IDs and all bookings for attendance rates', () => {
  const data = context.dashboardTest.aggregate(auditedFixture());
  assert.equal(data.total_visits, 2);
  assert.equal(data.member_classes[0].member_visits, 1);
  assert.equal(data.avg_member_visits, 0.2);
  assert.equal(data.no_show_count, 1);
  assert.equal(data.total_bookings, 3);
  assert.equal(data.no_show_rate_pct, 33.3);
});

test('treats payment statuses case-insensitively and deduplicates retries', () => {
  const data = context.dashboardTest.aggregate(auditedFixture());
  assert.equal(data.failed_payments.length, 1);
  assert.equal(data.failed_payments[0].membership, 'Prana Plus');
});

test('renders the refreshed revenue definitions from deterministic values', () => {
  const data = context.dashboardTest.aggregate(auditedFixture());
  const current = {
    week_of: data.week_of,
    baseline_corrected: true,
    revenue: {
      mrr: data.mrr,
      pack_and_class: data.non_autopay_total,
      weekly_mrr_equivalent: data.weekly_mrr_equivalent,
      weekly_revenue_run_rate: data.weekly_revenue_run_rate,
      monthly_revenue_run_rate: data.monthly_revenue_run_rate,
      annual_revenue_run_rate: data.annual_revenue_run_rate,
      mrr_pct: data.recurring_revenue_pct,
    },
    membership: {
      active_count: data.active_count,
      new_this_week: data.new_member_count,
      churned_this_week: data.cancelled_count,
      net_growth: 1,
      churn_rate_pct: 20,
      progress_to_800_pct: 1,
    },
    attendance: {
      total_visits: data.total_visits,
      no_show_count: data.no_show_count,
      total_bookings: data.total_bookings,
      no_show_rate_pct: data.no_show_rate_pct,
    },
    member_product_counts: data.member_product_counts,
    member_product_mrr: data.member_product_mrr,
    new_members: data.new_members,
    member_classes: data.member_classes,
    avg_member_visits: data.avg_member_visits,
    data_quality: data.data_quality,
    health_summary: data.health_summary,
    class_data: data.class_data,
    intelligence: {actions:[]},
  };
  const rendered = context.dashboardTest.renderDashboard(current, null, 'revenue');
  assert.match(rendered, /Est\. Weekly Revenue/);
  assert.match(rendered, /\$456/);
  assert.match(rendered, /Monthly Run Rate/);
  assert.match(rendered, /\$1,976/);
  assert.match(rendered, /Recurring share of revenue run rate/);
  assert.match(rendered, />67%<\/span>/);
});
