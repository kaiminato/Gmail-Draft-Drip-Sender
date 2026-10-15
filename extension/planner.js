/* Gmail Draft Drip Sender - the day planner.
 *
 * Pure functions, no Chrome APIs, so the same file runs in the service worker
 * (importScripts) and under Node for the test harness. Everything is exposed
 * on globalThis.DripPlanner.
 *
 * A day plan is a list of absolute send times. It is shaped like a person's
 * day rather than a drip: a nightly rest block (placed per account, drifting a
 * little each day), two to six sending sessions spread over the awake hours,
 * short gaps inside a session, long gaps between sessions, and a daily count
 * drawn from the account's tier.
 */
(function (root) {
  'use strict';

  const TIERS = { few: [10, 20], less: [20, 40], normal: [40, 70], many: [70, 110] };
  const TIER_ORDER = ['few', 'less', 'normal', 'many'];
  const REST_HOURS = 6;              // nightly block
  const REST_DRIFT_MIN = 45;         // +/- daily drift of the block
  const SESSION_GAP_MIN = [4, 12];   // minutes between sends inside a session
  const MIN_GAP_FLOOR = [1.5, 3];    // never compress below this
  const SESSION_SEP_MIN = 45;        // minimum quiet time between sessions
  const SENDS_PER_SESSION = 12;      // rough size used to pick the session count
  const MS_MIN = 60000;
  const MS_DAY = 24 * 3600000;

  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Small, stable string hash (FNV-1a) for per-account placement.
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // Deterministic float in [0,1) from a seed string.
  function seeded01(seed) {
    return (hashStr(seed) % 100000) / 100000;
  }

  function localMidnight(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function dateKey(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function hhmm(ms) {
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // The rest block that *starts* on the given day for this account: a stable
  // base minute per account somewhere in the late evening (22:30-01:30, so
  // every account sleeps at night but not at the same minute), drifted a
  // little per day.
  const REST_EARLIEST_MIN = 22 * 60 + 30;
  const REST_BAND_MIN = 180;
  function restWindow(deviceId, dayStartMs, restHours) {
    const hours = typeof restHours === 'number' ? restHours : REST_HOURS;
    if (hours <= 0) return null;
    const base = REST_EARLIEST_MIN + (hashStr(String(deviceId || 'x')) % REST_BAND_MIN);
    const drift = (seeded01(String(deviceId) + '|' + dateKey(dayStartMs)) * 2 - 1) * REST_DRIFT_MIN;
    const start = dayStartMs + (base + drift) * MS_MIN;
    return { start, end: start + hours * 3600000 };
  }

  // [from, dayEnd) minus any rest block that overlaps it (yesterday's tail,
  // today's). Returns non-empty intervals in order.
  function awakeIntervals(deviceId, fromMs, dayStartMs, restHours) {
    const dayEnd = dayStartMs + MS_DAY;
    let intervals = [[Math.max(fromMs, dayStartMs), dayEnd]];
    const rests = [restWindow(deviceId, dayStartMs - MS_DAY, restHours), restWindow(deviceId, dayStartMs, restHours)]
      .filter(Boolean);
    for (const r of rests) {
      const next = [];
      for (const [a, b] of intervals) {
        if (r.end <= a || r.start >= b) { next.push([a, b]); continue; }
        if (r.start > a) next.push([a, r.start]);
        if (r.end < b) next.push([r.end, b]);
      }
      intervals = next;
    }
    return intervals.filter(([a, b]) => b - a > MS_MIN);
  }

  const totalLen = (ivs) => ivs.reduce((n, [a, b]) => n + (b - a), 0);

  // Maps an offset in "awake time" to an absolute time by walking the intervals.
  function mapOffset(ivs, offset) {
    let left = offset;
    for (const [a, b] of ivs) {
      const len = b - a;
      if (left <= len) return a + left;
      left -= len;
    }
    const last = ivs[ivs.length - 1];
    return last ? last[1] : 0;
  }

  // One gap inside a session. Natural pacing averages two draws (triangular:
  // most gaps mid-range, extremes rare); otherwise flat.
  function gapMs(range, natural) {
    const [lo, hi] = range;
    const u = natural ? (Math.random() + Math.random()) / 2 : Math.random();
    return (lo + u * (hi - lo)) * MS_MIN;
  }

  // Splits n across k parts, each >= minEach, with random weights.
  function splitCounts(n, k, minEach) {
    const base = Array(k).fill(minEach);
    let left = n - minEach * k;
    const w = Array.from({ length: k }, () => 0.5 + Math.random());
    const sum = w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < k && left > 0; i++) {
      const take = Math.min(left, Math.round((n - minEach * k) * w[i] / sum));
      base[i] += take;
      left -= take;
    }
    for (let i = 0; left > 0; i = (i + 1) % k) { base[i]++; left--; }
    return base;
  }

  /**
   * Builds today's plan from `fromMs` onward.
   *   opts: { deviceId, tier, naturalPacing, fromMs, sentToday, restHours }
   * Returns { date, tier, dayTarget, times[], restStart, restEnd, gapRange,
   *           compressed, sessions }.
   * `dayTarget` is the whole day's intended count (already-sent included), so
   * a restart mid-day only plans what is left of it.
   */
  function makeDayPlan(opts) {
    const tier = TIERS[opts.tier] ? opts.tier : 'normal';
    const [lo, hi] = TIERS[tier];
    const natural = opts.naturalPacing !== false;
    const fromMs = opts.fromMs || Date.now();
    const dayStart = localMidnight(fromMs);
    const sentToday = Math.max(0, opts.sentToday || 0);
    const restHours = typeof opts.restHours === 'number' ? opts.restHours : REST_HOURS;

    const fullDay = awakeIntervals(opts.deviceId, dayStart, dayStart, restHours);
    const rest = awakeIntervals(opts.deviceId, fromMs, dayStart, restHours);
    const fullLen = totalLen(fullDay);
    const restLen = totalLen(rest);
    const todaysRest = restWindow(opts.deviceId, dayStart, restHours);

    const base = {
      date: dateKey(fromMs), tier, times: [], sessions: 0,
      restStart: todaysRest ? hhmm(todaysRest.start) : '',
      restEnd: todaysRest ? hhmm(todaysRest.end) : '',
      gapRange: SESSION_GAP_MIN.slice(), compressed: false
    };

    // The whole day's count is fixed once per day; keep it stable across
    // re-plans on the same day by seeding it from the date.
    const seed = seeded01(String(opts.deviceId) + '|target|' + base.date + '|' + tier);
    const dayTarget = lo + Math.floor(seed * (hi - lo + 1));
    base.dayTarget = Math.max(dayTarget, sentToday);

    let want = Math.max(0, dayTarget - sentToday);
    if (want > 0 && fullLen > 0 && restLen < fullLen) {
      // Restarting late in the day: plan a proportional share of what is left,
      // but never zero while something is still owed.
      want = Math.max(1, Math.round(want * (restLen / fullLen)));
    }
    if (want === 0 || restLen <= 0) return base;

    // Sessions and their sizes.
    let k = clamp(Math.round(want / SENDS_PER_SESSION), 2, 6);
    k = Math.max(1, Math.min(k, want));
    const minEach = want >= 2 * k ? 2 : 1;
    const counts = splitCounts(want, k, minEach);

    // Fit check: sessions must fit in the awake time with quiet gaps between.
    let gapRange = SESSION_GAP_MIN.slice();
    const meanGap = (r) => (r[0] + r[1]) / 2 * MS_MIN;
    const needed = (r) => counts.reduce((n, c) => n + Math.max(0, c - 1) * meanGap(r), 0) + (k - 1) * SESSION_SEP_MIN * MS_MIN;
    if (needed(gapRange) > restLen * 0.9) {
      const f = Math.max(0.05, (restLen * 0.9 - (k - 1) * SESSION_SEP_MIN * MS_MIN) /
        Math.max(1, counts.reduce((n, c) => n + Math.max(0, c - 1) * meanGap(gapRange), 0)));
      gapRange = [Math.max(MIN_GAP_FLOOR[0], gapRange[0] * f), Math.max(MIN_GAP_FLOOR[1], gapRange[1] * f)];
      base.compressed = true;
    }
    base.gapRange = [Math.round(gapRange[0] * 10) / 10, Math.round(gapRange[1] * 10) / 10];

    // Lay sessions out in awake-offset space: random slack before the first
    // session, between sessions (at least the quiet gap), and after the last.
    const sessionLens = counts.map((c) => {
      let len = 0;
      const gaps = [];
      for (let i = 1; i < c; i++) { const g = gapMs(gapRange, natural); gaps.push(g); len += g; }
      return { gaps, len };
    });
    const used = sessionLens.reduce((n, s) => n + s.len, 0) + (k - 1) * SESSION_SEP_MIN * MS_MIN;
    const slack = Math.max(0, restLen - used);
    // Random partition of the slack into k+1 pieces; the first one is kept
    // small-ish so a fresh start does not idle for hours.
    const w = Array.from({ length: k + 1 }, (_, i) => (i === 0 ? 0.35 : 1) * (0.3 + Math.random()));
    const wsum = w.reduce((a, b) => a + b, 0);
    const pieces = w.map((x) => slack * x / wsum);

    const times = [];
    let off = pieces[0];
    for (let s = 0; s < k; s++) {
      times.push(mapOffset(rest, off));
      for (const g of sessionLens[s].gaps) {
        off += g;
        times.push(mapOffset(rest, off));
      }
      off += SESSION_SEP_MIN * MS_MIN + pieces[s + 1];
    }
    base.times = times.filter((t) => t > fromMs).sort((a, b) => a - b);
    base.sessions = k;
    return base;
  }

  function describePlan(plan, sentToday) {
    const total = plan.dayTarget || 0;
    const left = plan.times.length;
    let s = 'Plan (' + plan.tier + '): ' + total + ' today';
    if (sentToday) s += ', ' + sentToday + ' done';
    s += ', ' + left + ' to go in ' + plan.sessions + ' session' + (plan.sessions === 1 ? '' : 's');
    if (plan.restStart) s += ', resting ' + plan.restStart + '–' + plan.restEnd;
    if (plan.compressed) s += ' (gaps compressed to ' + plan.gapRange[0] + '–' + plan.gapRange[1] + ' min to fit)';
    return s + '.';
  }

  root.DripPlanner = {
    TIERS, TIER_ORDER, REST_HOURS, SESSION_GAP_MIN, SESSION_SEP_MIN,
    makeDayPlan, describePlan, restWindow, awakeIntervals, hashStr, dateKey, hhmm
  };
})(typeof self !== 'undefined' ? self : globalThis);
