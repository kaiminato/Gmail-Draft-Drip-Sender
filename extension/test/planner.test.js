/* Planner invariants. Run with:  node extension/test/planner.test.js
 * No framework: each check throws on failure and the script exits non-zero.
 */
'use strict';
require('../planner.js');
const P = globalThis.DripPlanner;

const MS_MIN = 60000;
const MS_DAY = 24 * 3600000;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); }
}

function midnight(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
function inRest(t, deviceId, dayStart) {
  for (const r of [P.restWindow(deviceId, dayStart - MS_DAY), P.restWindow(deviceId, dayStart)]) {
    if (r && t >= r.start && t < r.end) return true;
  }
  return false;
}

const devices = ['dev-aaaa-1111', 'dev-bbbb-2222', 'dev-cccc-3333'];
const day0 = midnight(Date.now()) + 7 * MS_DAY; // a week ahead, any week
const summary = [];

for (const deviceId of devices) {
  for (const tier of P.TIER_ORDER) {
    const [lo, hi] = P.TIERS[tier];
    for (let d = 0; d < 7; d++) {
      const dayStart = day0 + d * MS_DAY;
      const plan = P.makeDayPlan({ deviceId, tier, naturalPacing: true, fromMs: dayStart + 1000, sentToday: 0 });
      ok(plan.dayTarget >= lo && plan.dayTarget <= hi, `${tier} target ${plan.dayTarget} outside ${lo}-${hi}`);
      ok(plan.times.length >= plan.dayTarget - 1 && plan.times.length <= plan.dayTarget,
        `${tier} planned ${plan.times.length} of ${plan.dayTarget}`);
      ok(plan.sessions >= 1 && plan.sessions <= 6, `sessions ${plan.sessions}`);
      const minGap = plan.gapRange[0] * MS_MIN - 1;
      let longGaps = 0;
      for (let i = 0; i < plan.times.length; i++) {
        const t = plan.times[i];
        ok(t > dayStart && t < dayStart + MS_DAY, 'time outside the day');
        ok(!inRest(t, deviceId, dayStart), `time ${P.hhmm(t)} inside the rest block (${plan.restStart}-${plan.restEnd})`);
        if (i > 0) {
          ok(t > plan.times[i - 1], 'times not sorted');
          const g = t - plan.times[i - 1];
          ok(g >= minGap, `gap ${Math.round(g / MS_MIN)}m below minimum ${plan.gapRange[0]}m`);
          if (g >= P.SESSION_SEP_MIN * MS_MIN) longGaps++;
        }
      }
      if (plan.sessions > 1) ok(longGaps >= 1, 'no long gap between sessions');
      // The top of "many" needs a little compression in an 18-hour day; it
      // must never get anywhere near the floor.
      if (tier === 'many') ok(plan.gapRange[0] >= 3, `many gaps compressed to ${plan.gapRange[0]}m at 6h rest`);
      else ok(!plan.compressed, `${tier} should fit without compression at 6h rest`);
      if (d === 0) summary.push(`${deviceId.slice(0, 8)} ${tier.padEnd(6)} ${P.describePlan(plan, 0)}`);
    }
  }
}

// Rest blocks differ between accounts. The daily drift (up to 45 minutes
// either way) can put two accounts in the same half hour on a given day, so
// average it out over a month and compare each account's own base minute.
{
  const meanStart = (id) => {
    let sum = 0;
    for (let d = 0; d < 30; d++) {
      const ds = day0 + d * MS_DAY;
      sum += (P.restWindow(id, ds).start - ds) / MS_MIN;
    }
    return sum / 30;
  };
  const means = devices.map(meanStart);
  for (let i = 0; i < means.length; i++) {
    for (let j = i + 1; j < means.length; j++) {
      ok(Math.abs(means[i] - means[j]) >= 5, 'rest base minutes too close: ' + means[i].toFixed(0) + ' vs ' + means[j].toFixed(0));
    }
  }
}

// The whole-day count is stable across re-plans on the same day.
{
  const a = P.makeDayPlan({ deviceId: devices[0], tier: 'normal', fromMs: day0 + 1000, sentToday: 0 });
  const b = P.makeDayPlan({ deviceId: devices[0], tier: 'normal', fromMs: day0 + 5 * 3600000, sentToday: 0 });
  ok(a.dayTarget === b.dayTarget, 'dayTarget should not change within a day');
}

// Restarting mid-afternoon after 30 sends plans only what is left, all in the future.
{
  const from = day0 + 15 * 3600000;
  const plan = P.makeDayPlan({ deviceId: devices[1], tier: 'normal', fromMs: from, sentToday: 30 });
  ok(plan.dayTarget >= 40, 'target kept');
  ok(plan.times.length <= plan.dayTarget - 30, `planned ${plan.times.length} > remaining ${plan.dayTarget - 30}`);
  ok(plan.times.every((t) => t > from), 'all times after the restart');
  ok(plan.times.length >= 1 || plan.dayTarget - 30 === 0, 'something planned while sends are still owed');
}

// Starting inside the rest block waits for it to end.
{
  const r = P.restWindow(devices[2], day0);
  const from = r.start + 30 * MS_MIN;
  const plan = P.makeDayPlan({ deviceId: devices[2], tier: 'few', fromMs: from, sentToday: 0 });
  ok(plan.times.every((t) => t >= r.end || t < r.start), 'no sends during the rest block after a restart inside it');
}

// Already done for the day: nothing planned.
{
  const plan = P.makeDayPlan({ deviceId: devices[0], tier: 'few', fromMs: day0 + 12 * 3600000, sentToday: 25 });
  ok(plan.times.length === 0, 'nothing to plan when the target is already met');
}

// Compression kicks in when the awake time is short.
{
  const plan = P.makeDayPlan({ deviceId: devices[0], tier: 'many', fromMs: day0 + 1000, sentToday: 0, restHours: 16 });
  ok(plan.compressed, 'expected compression with 8 awake hours for up to 110 sends');
  ok(plan.times.length >= plan.dayTarget - 1, 'compressed plan still covers the target');
}

// Zone-pinned clock: midnight, date and hh:mm follow the configured zone,
// across the year including DST changes, and a plan stays inside its day.
{
  const fmtOf = (tz) => new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const partsOf = (tz, ms) => { const o = {}; for (const p of fmtOf(tz).formatToParts(ms)) o[p.type] = p.value; return o; };
  for (const tz of ['Asia/Tokyo', 'America/New_York', 'Europe/London']) {
    ok(P.setTimeZone(tz) === tz, 'zone accepted ' + tz);
    for (let i = 0; i < 365; i += 3) {
      const ms = Date.UTC(2026, 0, 1, 15, 37) + i * MS_DAY;
      const m = P.localMidnight(ms);
      const p = partsOf(tz, m);
      ok((+p.hour) % 24 === 0 && +p.minute === 0, tz + ' midnight is ' + p.hour + ':' + p.minute);
      ok(p.year + '-' + p.month + '-' + p.day === P.dateKey(ms), tz + ' midnight falls on another day');
      ok(m <= ms && ms - m < 25 * 3600000, tz + ' midnight not within the day');
      const n = P.nextMidnight(ms);
      ok(n > m && n - m >= 23 * 3600000 && n - m <= 25 * 3600000, tz + ' next midnight ' + ((n - m) / 3600000) + 'h away');
      const q = partsOf(tz, ms);
      ok(P.hhmm(ms) === String((+q.hour) % 24).padStart(2, '0') + ':' + q.minute, tz + ' hhmm ' + P.hhmm(ms) + ' vs ' + q.hour + ':' + q.minute);
    }
    const dayStart = P.localMidnight(Date.UTC(2026, 6, 10, 12));
    const plan = P.makeDayPlan({ deviceId: devices[0], tier: 'normal', fromMs: dayStart + 1000, sentToday: 0 });
    ok(plan.times.length > 0, tz + ' plan is empty');
    ok(plan.times.every((t) => P.dateKey(t) === P.dateKey(dayStart)), tz + ' plan leaves its day');
    ok(plan.times.every((t) => !inRest(t, devices[0], dayStart)), tz + ' plan sends during the rest');
  }
  ok(P.setTimeZone('Not/AZone') === null, 'an unknown zone falls back to the machine clock');
  P.setTimeZone(null);
  ok(P.timeZone() === null, 'zone cleared');
}

console.log(summary.join('\n'));
console.log(`\n${checks} checks passed`);
