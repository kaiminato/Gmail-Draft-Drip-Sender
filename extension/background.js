/* Gmail Draft Drip Sender - service worker.
 * Owns the schedule. MV3 workers get torn down constantly, so all state lives in
 * chrome.storage.local and the next send is armed as a chrome.alarms one-shot.
 *
 * It also talks to the dashboard: a heartbeat every minute reports status and
 * queued events, and the reply carries the settings the dashboard owns plus
 * any start/stop command the admin has queued.
 */

importScripts('config.js');
// Per-machine override (gitignored). Missing is the normal case.
try { importScripts('config.local.js'); } catch (_) {}

const CFG = Object.assign(
  { apiBase: '', apiKey: '', heartbeatMinutes: 1 },
  (typeof self !== 'undefined' && self.DRIP_CONFIG) || {}
);
const SERVER_CONFIGURED = /^https?:\/\//.test(CFG.apiBase) && !!CFG.apiKey && CFG.apiKey !== 'REPLACE_ME';

const ALARM = 'gmail-draft-drip';
const HEARTBEAT_ALARM = 'drip-heartbeat';
const GMAIL_URL = 'https://mail.google.com/';
const MAX_LOG = 200;
const MAX_CONSECUTIVE_FAILURES = 5;
const RETRY_DELAY_MS = 60 * 1000;
const SKIP_RETRY_DELAY_MS = 35 * 1000; // alarms clamp below ~30s
const MAX_QUEUED_EVENTS = 500;
const EVENTS_PER_HEARTBEAT = 100;
const HEARTBEAT_TIMEOUT_MS = 15000;
const CYCLE_STALE_MS = 10 * 60000;

const DEFAULTS = {
  running: false,
  minMinutes: 10,
  maxMinutes: 50,
  order: 'random',
  sendFirstImmediately: true,
  dailyLimit: 0, // 0 = unlimited
  restoreView: true,
  naturalPacing: true,
  activeHours: false,
  activeStart: '09:00',
  activeEnd: '18:00',
  skipWeekends: false,
  checkInbox: true,
  pendingAlerts: [], // what stopped the run, shown in the popup
  ackedAlerts: [],   // alert ids the user has already waved through
  seenBounces: [],   // bounce ids already logged, so they log once each
  bounceCount: 0,
  nextSendAt: 0,
  sentToday: 0,
  sentDate: '',
  totalSent: 0,
  consecutiveFailures: 0,
  lastMessage: '',
  skipIds: [],
  log: [],
  // Dashboard integration.
  deviceId: '',
  accountEmail: '',
  accountEmailAt: 0,
  stopReason: '',        // '' | user | empty | blocked | failures | admin | daily_cap
  lastSendAt: 0,
  remainingBucket: 'unknown', // unknown | none | 1-10 | 10+
  eventQueue: [],
  pendingAcks: [],
  executedCommandIds: [],
  serverLastTryAt: 0,
  serverLastOkAt: 0,
  serverLastError: '',
  serverSettingsAt: 0,
  cycleStartedAt: 0
};

let busy = false;

/* ---------- state ---------- */

async function getState() {
  const stored = await chrome.storage.local.get(null);
  return { ...DEFAULTS, ...stored };
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
  return getState();
}

function getVersion() {
  try { return chrome.runtime.getManifest().version; } catch (_) { return '?'; }
}

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function rollDailyCounter(st) {
  const key = todayKey();
  if (st.sentDate !== key) {
    await setState({ sentDate: key, sentToday: 0 });
    return { ...st, sentDate: key, sentToday: 0 };
  }
  return st;
}

async function log(level, msg) {
  const st = await getState();
  const entry = { t: Date.now(), level, msg: String(msg) };
  const next = [entry, ...st.log].slice(0, MAX_LOG);
  await setState({ log: next, lastMessage: entry.msg });
  return entry;
}

async function setBadge(running) {
  try {
    await chrome.action.setBadgeText({ text: running ? 'ON' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
  } catch (_) {}
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message: String(message).slice(0, 300)
    });
  } catch (_) {}
}

function bucketOf(remaining) {
  if (typeof remaining !== 'number' || !(remaining >= 0)) return null;
  if (remaining === 0) return 'none';
  if (remaining <= 10) return '1-10';
  return '10+';
}

// The clamp/swap rules for the settings the dashboard owns, shared by the
// popup path and the heartbeat path.
function sanitizeSettings(patch) {
  const clean = {};
  if (patch.minMinutes !== undefined) clean.minMinutes = Math.max(0.5, Number(patch.minMinutes) || 10);
  if (patch.maxMinutes !== undefined) clean.maxMinutes = Math.max(0.5, Number(patch.maxMinutes) || 50);
  if (clean.minMinutes !== undefined && clean.maxMinutes !== undefined && clean.minMinutes > clean.maxMinutes) {
    const t = clean.minMinutes; clean.minMinutes = clean.maxMinutes; clean.maxMinutes = t;
  }
  if (patch.dailyLimit !== undefined) clean.dailyLimit = Math.max(0, Math.floor(Number(patch.dailyLimit) || 0));
  return clean;
}

/* ---------- event queue (survives worker teardown; flushed by heartbeat) ---------- */

// Writes to the queue are serialised so an enqueue cannot race a prune and lose
// an event. Only matters within one worker lifetime, which is the only time two
// writes can overlap.
let queueChain = Promise.resolve();
function withQueueLock(fn) {
  const run = queueChain.then(fn, fn);
  queueChain = run.catch(() => {});
  return run;
}

function newId() {
  try { return crypto.randomUUID(); } catch (_) {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
}

async function enqueueEvent(type, data) {
  const ev = { id: newId(), t: Date.now(), type, ...(data || {}) };
  await withQueueLock(async () => {
    const st = await getState();
    const q = [...st.eventQueue, ev].slice(-MAX_QUEUED_EVENTS);
    await setState({ eventQueue: q });
  });
  scheduleHeartbeatSoon();
  return ev;
}

/* ---------- scheduling ---------- */

function parseHM(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins < 1440 ? mins : null;
}

// True only for a sane daytime window; anything else means "no hour limit".
function usableWindow(st) {
  if (!st.activeHours) return null;
  const s = parseHM(st.activeStart);
  const e = parseHM(st.activeEnd);
  if (s === null || e === null || s >= e) return null;
  return { s, e };
}

// The gap before the next send.
function gapMs(st) {
  const lo = Math.max(0.1, Math.min(st.minMinutes, st.maxMinutes));
  const hi = Math.max(lo, Math.max(st.minMinutes, st.maxMinutes));
  if (!st.naturalPacing) return (lo + Math.random() * (hi - lo)) * 60000;

  // Averaging two draws gives a triangular spread: most gaps land mid-range,
  // the extremes stay rare. A flat random interval is itself a machine pattern.
  const u = (Math.random() + Math.random()) / 2;
  let mins = lo + u * (hi - lo);
  // Now and then, step away from the desk.
  if (Math.random() < 0.15) mins *= 1.5 + Math.random() * 1.5;
  return mins * 60000;
}

function startOfWindow(day, win) {
  const d = new Date(day);
  d.setHours(Math.floor(win.s / 60), win.s % 60, 0, 0);
  // Drift into the window so it never opens at exactly the same second each day.
  const slack = Math.min(25, (win.e - win.s) / 3) * 60000;
  return new Date(d.getTime() + Math.random() * slack);
}

function nextDay(d) {
  const x = new Date(d);
  x.setDate(x.getDate() + 1);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Walks `whenMs` forward until it lands inside the active hours / weekdays.
function nextAllowedTime(st, whenMs) {
  const win = usableWindow(st);
  if (!win && !st.skipWeekends) return whenMs;
  let d = new Date(whenMs);
  for (let guard = 0; guard < 16; guard++) {
    const day = d.getDay();
    if (st.skipWeekends && (day === 0 || day === 6)) {
      d = win ? startOfWindow(nextDay(d), win) : nextDay(d);
      continue;
    }
    if (win) {
      const mins = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
      if (mins < win.s) { d = startOfWindow(d, win); continue; }
      if (mins >= win.e) { d = startOfWindow(nextDay(d), win); continue; }
    }
    return d.getTime();
  }
  return d.getTime();
}

function describeWhen(ts) {
  const ms = ts - Date.now();
  if (ms < 60 * 60000) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return 'in ' + (m <= 0 ? s + 's' : m + 'm ' + String(s).padStart(2, '0') + 's');
  }
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameDay) return 'at ' + time;
  if (d.toDateString() === tomorrow.toDateString()) return 'tomorrow at ' + time;
  return d.toLocaleDateString([], { weekday: 'long' }) + ' at ' + time;
}

async function schedule(delayMs, note) {
  const st = await getState();
  const raw = Date.now() + delayMs;
  const when = nextAllowedTime(st, raw);
  await setState({ nextSendAt: when });
  await chrome.alarms.clear(ALARM);
  chrome.alarms.create(ALARM, { when });
  if (note) {
    const held = when - raw > 60000 ? ' Outside sending hours, so holding.' : '';
    await log('info', note + held + ' Next send ' + describeWhen(when) + '.');
  }
  return when;
}

// `code` is the machine-readable reason the dashboard shows; `message` is the
// log line.
async function stop(code, message, level) {
  await chrome.alarms.clear(ALARM);
  await setState({ running: false, nextSendAt: 0, stopReason: code || 'user' });
  await setBadge(false);
  if (message) await log(level || 'info', message);
  await enqueueEvent('stopped', { reason: code || 'user', message: message || '' });
}

function msUntilTomorrow() {
  const d = new Date();
  d.setHours(24, 2, 0, 0); // just past local midnight
  return Math.max(60000, d.getTime() - Date.now());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- gmail tab plumbing ---------- */

async function findGmailTab() {
  const tabs = await chrome.tabs.query({ url: '*://mail.google.com/*' });
  if (!tabs.length) return null;
  const live = tabs.filter((t) => !t.discarded && t.status === 'complete');
  const pool = live.length ? live : tabs;
  return pool.find((t) => t.active) ||
    pool.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

function waitForTabComplete(tabId, timeout = 45000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;
    const tick = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tab.status === 'complete' && !tab.discarded) return resolve(true);
      } catch (_) { return resolve(false); }
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 700);
    };
    tick();
  });
}

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (pong && pong.ok) return true;
  } catch (_) { /* not injected yet */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await sleep(400);
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return !!(pong && pong.ok);
  } catch (_) {
    return false;
  }
}

// Gmail's shell can be "complete" long before its UI is usable. Ask the page.
async function waitForGmailReady(tabId, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await ensureContentScript(tabId)) {
      try {
        const r = await chrome.tabs.sendMessage(tabId, { type: 'GMAIL_READY' });
        if (r && r.ready) {
          if (r.email) await rememberEmail(r.email);
          return true;
        }
      } catch (_) {}
    }
    await sleep(1000);
  }
  return false;
}

// Sending drives the real UI, so Gmail has to be the page on screen: Chrome
// throttles hidden tabs to a timer tick a minute, and a minimised window is
// hidden too.
async function bringToFront(tab) {
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === 'minimized') await chrome.windows.update(win.id, { state: 'normal' });
    await chrome.windows.update(win.id, { focused: true });
  } catch (_) {}
  try { await chrome.tabs.update(tab.id, { active: true }); } catch (_) {}
  await sleep(1200);
}

// Finds, or opens, a Gmail tab and brings it to the front fully loaded.
async function acquireGmailTab() {
  let tab = await findGmailTab();
  let created = false;
  if (!tab) {
    try {
      tab = await chrome.tabs.create({ url: GMAIL_URL, active: true });
    } catch (e) {
      return { error: 'NO_TAB', message: 'Could not open a Gmail tab: ' + ((e && e.message) || e) };
    }
    created = true;
    await log('info', 'No Gmail tab was open - opened one.');
  } else if (tab.discarded || tab.status !== 'complete') {
    try { await chrome.tabs.reload(tab.id); } catch (_) {}
  }

  await bringToFront(tab);

  const ready = await waitForTabComplete(tab.id, created ? 60000 : 45000);
  if (!ready) return { error: 'TAB_NOT_READY', message: 'Gmail tab is still loading.' };

  let fresh = tab;
  try { fresh = await chrome.tabs.get(tab.id); } catch (_) {
    return { error: 'NO_TAB', message: 'The Gmail tab disappeared while loading.' };
  }
  const url = fresh.url || fresh.pendingUrl || '';
  if (!/^https?:\/\/mail\.google\.com\//i.test(url)) {
    let host = url;
    try { host = new URL(url).hostname; } catch (_) {}
    return {
      error: 'NOT_SIGNED_IN',
      message: 'The Gmail tab went to ' + (host || 'another page') + ' instead of Gmail - is this profile signed in?'
    };
  }

  const uiReady = await waitForGmailReady(fresh.id, created ? 45000 : 30000);
  if (!uiReady) return { error: 'TAB_NOT_READY', message: 'Gmail did not finish loading its UI.' };
  return { tab: fresh };
}

async function rememberEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return;
  const st = await getState();
  if (st.accountEmail === e) return;
  await setState({ accountEmail: e, accountEmailAt: Date.now() });
  await log('info', 'Gmail account: ' + e);
  scheduleHeartbeatSoon();
}

// Read-only: asks an already-loaded Gmail tab who it is. Never navigates.
async function refreshAccountEmail() {
  const st = await getState();
  if (st.accountEmail) return;
  const tab = await findGmailTab();
  if (!tab || tab.discarded || tab.status !== 'complete') return;
  if (!(await ensureContentScript(tab.id))) return;
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'GET_ACCOUNT' });
    if (r && r.email) await rememberEmail(r.email);
  } catch (_) {}
}

/* ---------- one send cycle ---------- */

async function runCycle(manual) {
  if (busy) return { ok: false, code: 'BUSY', message: 'A send is already in progress.' };
  busy = true;
  await setState({ cycleStartedAt: Date.now() });
  // A cycle can run for minutes; keep the worker from being torn down mid-send.
  const keepAlive = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch (_) {} }, 20000);
  // Early exits log too, so the popup always explains why nothing was sent.
  const fail = async (code, message) => {
    await log('warn', message);
    return { ok: false, code, message };
  };
  try {
    let st = await rollDailyCounter(await getState());

    if (!manual && st.dailyLimit > 0 && st.sentToday >= st.dailyLimit) {
      await setState({ stopReason: 'daily_cap' });
      await log('warn', 'Daily limit of ' + st.dailyLimit + ' reached. Pausing until tomorrow.');
      await schedule(msUntilTomorrow(), 'Resuming after midnight.');
      return { ok: false, code: 'DAILY_LIMIT' };
    }

    const got = await acquireGmailTab();
    if (got.error) return fail(got.error, got.message);
    const tab = got.tab;

    let res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, {
        type: 'SEND_ONE_DRAFT',
        order: st.order,
        skipIds: st.skipIds,
        restoreView: st.restoreView,
        humanize: st.naturalPacing,
        checkInbox: st.checkInbox,
        ackedAlerts: st.ackedAlerts,
        seenBounces: st.seenBounces
      });
    } catch (e) {
      return fail('NO_CONTENT_SCRIPT', 'Lost contact with the Gmail tab: ' + ((e && e.message) || e));
    }
    if (!res) return fail('NO_RESPONSE', 'Gmail page did not respond.');

    // Undeliverable addresses are worth knowing about but are not a reason to
    // halt: log each one once, then carry on.
    if (res.bounces && res.bounces.length) {
      const cur = await getState();
      const ids = [...cur.seenBounces, ...res.bounces.map((b) => b.id)].filter(Boolean);
      await setState({
        seenBounces: ids.slice(-200),
        bounceCount: cur.bounceCount + res.bounces.length
      });
      for (const b of res.bounces) {
        await log('warn', 'Bounced: "' + b.subject + '"' + (b.from ? ' from ' + b.from : '') + ' - still sending.');
        await enqueueEvent('bounce', { subject: b.subject, from: b.from || '' });
      }
    }

    const bucket = bucketOf(res.remaining);
    if (bucket) await setState({ remainingBucket: bucket });

    if (res.ok && res.code === 'SENT') {
      st = await rollDailyCounter(await getState());
      await setState({
        sentToday: st.sentToday + 1,
        totalSent: st.totalSent + 1,
        consecutiveFailures: 0,
        lastSendAt: Date.now(),
        stopReason: ''
      });
      const left = typeof res.remaining === 'number' ? ' (' + res.remaining + ' left)' : '';
      await log(res.late ? 'warn' : 'ok', res.message + left);
      await enqueueEvent('sent', {
        subject: (res.draft && res.draft.subject) || '',
        recipients: res.recipients || [],
        late: !!res.late,
        remaining: typeof res.remaining === 'number' ? res.remaining : null
      });
    } else if (res.code === 'BLOCKED') {
      await setState({ pendingAlerts: res.alerts || [] });
      await log('err', res.message);
    } else if (res.code === 'NO_RECIPIENT') {
      const cur = await getState();
      const id = res.draft && res.draft.id;
      if (id && !cur.skipIds.includes(id)) await setState({ skipIds: [...cur.skipIds, id] });
      await log('warn', res.message);
    } else if (res.code === 'NO_DRAFTS') {
      await setState({ remainingBucket: 'none' });
      await log('info', res.message);
    } else {
      await log(res.code === 'ALL_SKIPPED' ? 'info' : 'warn',
        res.message || ('Send failed: ' + res.code));
    }
    return res;
  } catch (err) {
    const message = String((err && err.message) || err);
    await log('err', 'Unexpected error: ' + message);
    return { ok: false, code: 'ERROR', message };
  } finally {
    clearInterval(keepAlive);
    busy = false;
    await setState({ cycleStartedAt: 0 });
    refreshAccountEmail().catch(() => {});
  }
}

// Runs a cycle and decides when the next one should happen.
async function tick(manual) {
  const res = await runCycle(manual);
  const st = await getState();
  if (!st.running) return res;

  switch (res.code) {
    case 'SENT': {
      if (st.dailyLimit > 0 && st.sentToday >= st.dailyLimit) {
        await setState({ stopReason: 'daily_cap' });
        await log('warn', 'Daily limit of ' + st.dailyLimit + ' reached. Pausing until tomorrow.');
        await schedule(msUntilTomorrow(), 'Resuming after midnight.');
      } else {
        await schedule(gapMs(st), 'Scheduled.');
      }
      break;
    }
    case 'BLOCKED': {
      const alerts = st.pendingAlerts || [];
      const n = alerts.length;
      await enqueueEvent('blocked', {
        subjects: alerts.map((a) => a.subject).slice(0, 5),
        message: res.message || ''
      });
      await stop('blocked', 'Stopped: Gmail is blocking or limiting your mail. Press Start to continue anyway.', 'err');
      notify('Sending stopped', n > 1
        ? n + ' block/limit notices arrived in your inbox.'
        : (res.message || 'Gmail is refusing mail from this account.'));
      break;
    }
    case 'NO_DRAFTS':
      await stop('empty', 'Drafts folder is empty - stopped.', 'ok');
      notify('Draft sender finished', 'All drafts have been sent.');
      break;
    case 'ALL_SKIPPED':
      await stop('empty', 'Every remaining draft was skipped as unsendable - stopped.', 'warn');
      notify('Draft sender stopped', 'Remaining drafts have no recipient.');
      break;
    case 'NO_RECIPIENT':
      await schedule(SKIP_RETRY_DELAY_MS, 'Moving on to the next draft.');
      break;
    case 'COMPOSE_OPEN':
      // You are writing something yourself - wait it out, do not count it as a failure.
      await schedule(RETRY_DELAY_MS, 'Waiting for your compose window to close.');
      break;
    case 'DAILY_LIMIT':
    case 'BUSY':
      break;
    default: {
      const fails = st.consecutiveFailures + 1;
      await setState({ consecutiveFailures: fails });
      await enqueueEvent('failed', { code: res.code || 'ERROR', message: res.message || '', consecutive: fails });
      if (fails >= MAX_CONSECUTIVE_FAILURES) {
        await stop('failures', 'Stopped after ' + fails + ' failures in a row. Last problem: ' + (res.message || res.code), 'err');
        notify('Draft sender stopped', res.message || res.code);
      } else {
        await schedule(RETRY_DELAY_MS, 'Retry ' + fails + '/' + MAX_CONSECUTIVE_FAILURES + '.');
      }
    }
  }
  return res;
}

/* ---------- start / stop ---------- */

async function start(source) {
  let st = await rollDailyCounter(await getState());
  // Pressing Start with alerts on screen means "I have seen those" - remember
  // them so the same bounce cannot stop the run a second time.
  if (st.pendingAlerts.length) {
    const acked = [...st.ackedAlerts, ...st.pendingAlerts.map((a) => a.id)].filter(Boolean);
    st = await setState({ ackedAlerts: acked.slice(-50), pendingAlerts: [] });
    await log('info', 'Acknowledged ' + acked.length + ' earlier delivery alert(s).');
  }
  await setState({ running: true, consecutiveFailures: 0, stopReason: '' });
  await setBadge(true);
  // The version is stamped here so the log always says which build produced it.
  await log('info', 'Started v' + getVersion() + (source === 'admin' ? ' from the dashboard' : '') +
    '. Interval ' + st.minMinutes + '-' + st.maxMinutes + ' minutes, ' +
    ({ oldest: 'oldest draft first', newest: 'newest draft first', random: 'random draft' }[st.order] || st.order) + '.');
  await enqueueEvent('started', {
    source: source || 'user',
    minMinutes: st.minMinutes, maxMinutes: st.maxMinutes, dailyLimit: st.dailyLimit
  });

  if (st.sendFirstImmediately) {
    // "Right away" still respects the sending window - pressing Start at
    // 11pm should not fire when you have limited yourself to 9-6.
    const now = Date.now();
    const holding = nextAllowedTime(st, now) - now > 60000;
    await schedule(1000, holding ? 'Started outside sending hours.' : '');
    if (!holding) tick(false); // fire now; the alarm is a safety net if the worker dies
  } else {
    await schedule(gapMs(st), 'Waiting for the first send.');
  }
  return getState();
}

/* ---------- dashboard: heartbeat, settings, commands ---------- */

async function getDeviceId() {
  const st = await getState();
  if (st.deviceId) return st.deviceId;
  const id = newId();
  await setState({ deviceId: id });
  return id;
}

async function ensureHeartbeatAlarm() {
  try {
    const existing = await chrome.alarms.get(HEARTBEAT_ALARM);
    if (existing) return;
    const period = Math.max(0.5, Number(CFG.heartbeatMinutes) || 1);
    chrome.alarms.create(HEARTBEAT_ALARM, { delayInMinutes: 0.1, periodInMinutes: period });
  } catch (_) {}
}

async function collectHeartbeat(trigger) {
  const st = await rollDailyCounter(await getState());
  const deviceId = st.deviceId || (await getDeviceId());
  const tabs = await chrome.tabs.query({ url: '*://mail.google.com/*' });
  const cycling = busy || (st.cycleStartedAt > 0 && Date.now() - st.cycleStartedAt < CYCLE_STALE_MS);
  return {
    deviceId,
    email: st.accountEmail || null,
    version: getVersion(),
    ts: Date.now(),
    trigger: trigger || 'alarm',
    running: !!st.running,
    busy: cycling,
    stopReason: st.stopReason || '',
    nextSendAt: st.nextSendAt || 0,
    lastSendAt: st.lastSendAt || 0,
    remainingBucket: st.remainingBucket || 'unknown',
    sentToday: st.sentToday || 0,
    totalSent: st.totalSent || 0,
    bounceCount: st.bounceCount || 0,
    consecutiveFailures: st.consecutiveFailures || 0,
    gmailTabOpen: tabs.length > 0,
    settings: { minMinutes: st.minMinutes, maxMinutes: st.maxMinutes, dailyLimit: st.dailyLimit },
    serverSettingsAt: st.serverSettingsAt || 0,
    acks: st.pendingAcks || [],
    events: (st.eventQueue || []).slice(0, EVENTS_PER_HEARTBEAT)
  };
}

let heartbeatInFlight = null;
let heartbeatSoonTimer = null;

// Event-driven beats are debounced and skipped while the server is known to
// be down; the minute alarm keeps retrying regardless.
function scheduleHeartbeatSoon() {
  if (!SERVER_CONFIGURED) return;
  if (heartbeatSoonTimer) return;
  heartbeatSoonTimer = setTimeout(async () => {
    heartbeatSoonTimer = null;
    const st = await getState();
    if (st.serverLastError && st.serverLastTryAt > st.serverLastOkAt) return;
    sendHeartbeat('event').catch(() => {});
  }, 3000);
}

function sendHeartbeat(trigger) {
  if (!SERVER_CONFIGURED) {
    return setState({ serverLastError: 'Not configured: set apiBase and apiKey in config.js.' })
      .then(() => false);
  }
  if (heartbeatInFlight) return heartbeatInFlight;
  heartbeatInFlight = (async () => {
    const body = await collectHeartbeat(trigger);
    await setState({ serverLastTryAt: Date.now() });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), HEARTBEAT_TIMEOUT_MS);
    let reply;
    try {
      const r = await fetch(CFG.apiBase.replace(/\/+$/, '') + '/api/ext/heartbeat', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + CFG.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: ctl.signal
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      reply = await r.json();
    } catch (e) {
      const msg = (e && e.name === 'AbortError') ? 'timed out' : String((e && e.message) || e);
      await setState({ serverLastError: msg });
      return false;
    } finally {
      clearTimeout(timer);
    }

    // Prune by id: anything queued during the request stays.
    const sentIds = new Set(body.events.map((e) => e.id));
    const ackIds = new Set(body.acks.map((a) => a.id));
    await withQueueLock(async () => {
      const st = await getState();
      await setState({
        eventQueue: st.eventQueue.filter((e) => !sentIds.has(e.id)),
        pendingAcks: st.pendingAcks.filter((a) => !ackIds.has(a.id)),
        serverLastOkAt: Date.now(),
        serverLastError: ''
      });
    });

    if (reply && reply.desired) await applyServerSettings(reply.desired);
    if (reply && reply.command) await executeCommand(reply.command);
    // More events may be waiting if the queue was long.
    const left = (await getState()).eventQueue.length;
    if (left > 0 && body.events.length >= EVENTS_PER_HEARTBEAT) scheduleHeartbeatSoon();
    return true;
  })().finally(() => { heartbeatInFlight = null; });
  return heartbeatInFlight;
}

async function applyServerSettings(desired) {
  const clean = sanitizeSettings(desired || {});
  const st = await getState();
  const changed = Object.keys(clean).filter((k) => clean[k] !== st[k]);
  await setState({ ...clean, serverSettingsAt: Date.now() });
  if (!changed.length) return;
  const next = { ...st, ...clean };
  await log('info', 'Settings updated from the dashboard: interval ' + next.minMinutes + '-' +
    next.maxMinutes + ' min, daily cap ' + (next.dailyLimit || 'off') + '.');
  // An armed send further out than the new maximum would ignore the change.
  if (st.running && st.nextSendAt && (changed.includes('minMinutes') || changed.includes('maxMinutes'))) {
    const maxMs = Math.max(next.minMinutes, next.maxMinutes) * 60000;
    if (st.nextSendAt - Date.now() > maxMs) {
      await schedule(gapMs(next), 'Interval changed by dashboard.');
    }
  }
}

async function executeCommand(cmd) {
  if (!cmd || !cmd.id || !cmd.type) return;
  const st = await getState();
  const pushAck = (status, message) => withQueueLock(async () => {
    const cur = await getState();
    const acks = cur.pendingAcks.filter((a) => a.id !== cmd.id);
    acks.push({ id: cmd.id, status, message: message || '', ts: Date.now() });
    const done = [...cur.executedCommandIds.filter((i) => i !== cmd.id), cmd.id].slice(-20);
    await setState({ pendingAcks: acks, executedCommandIds: done });
  });

  if (st.executedCommandIds.includes(cmd.id)) {
    // The server did not see our ack yet; repeat it, do not re-run it.
    await pushAck('done', 'already applied');
  } else if (cmd.type === 'start') {
    if (st.running) {
      await pushAck('done', 'already running');
    } else {
      await start('admin');
      await pushAck('done', '');
    }
  } else if (cmd.type === 'stop') {
    if (!st.running) {
      await pushAck('done', 'already stopped');
    } else {
      await stop('admin', 'Stopped from the dashboard.', 'info');
      await pushAck('done', '');
    }
  } else {
    await pushAck('error', 'unknown command ' + cmd.type);
  }
  // Not debounced: the admin is probably watching for the ack.
  setTimeout(() => sendHeartbeat('ack').catch(() => {}), 500);
}

/* ---------- events ---------- */

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    sendHeartbeat('alarm').catch(() => {});
    return;
  }
  if (alarm.name !== ALARM) return;
  const st = await getState();
  if (!st.running) return;
  await tick(false);
});

chrome.runtime.onStartup.addListener(async () => {
  const st = await getState();
  await setBadge(st.running);
  await ensureHeartbeatAlarm();
  if (!st.running) return;
  const existing = await chrome.alarms.get(ALARM);
  if (!existing) await schedule(RETRY_DELAY_MS, 'Browser restarted.');
});

chrome.runtime.onInstalled.addListener(async () => {
  const st = await getState();
  await chrome.storage.local.set({ ...DEFAULTS, ...st });
  await getDeviceId();
  await setBadge(st.running);
  await ensureHeartbeatAlarm();
  sendHeartbeat('boot').catch(() => {});
});

// Runs on every worker wake-up, so the heartbeat alarm can never go missing.
ensureHeartbeatAlarm();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  const reply = (p) => p.then(sendResponse).catch((e) =>
    sendResponse({ error: String((e && e.message) || e) }));

  switch (msg.type) {
    case 'ACCOUNT_DETECTED':
      // From the content script, once it has read the signed-in address.
      if (sender && sender.tab && msg.email) rememberEmail(msg.email).catch(() => {});
      sendResponse({ ok: true });
      return;

    case 'GET_STATE':
      reply((async () => {
        const st = await rollDailyCounter(await getState());
        const tabs = await chrome.tabs.query({ url: '*://mail.google.com/*' });
        let apiHost = '';
        try { apiHost = new URL(CFG.apiBase).host; } catch (_) {}
        return {
          ...st,
          gmailTabs: tabs.length,
          busy: busy || (st.cycleStartedAt > 0 && Date.now() - st.cycleStartedAt < CYCLE_STALE_MS),
          version: getVersion(),
          serverConfigured: SERVER_CONFIGURED,
          apiHost
        };
      })());
      return true;

    case 'SET_SETTINGS':
      reply((async () => {
        const patch = msg.patch || {};
        // Interval and daily cap are owned by the dashboard and ignored here.
        const clean = {};
        if (patch.order !== undefined) clean.order = patch.order;
        if (patch.sendFirstImmediately !== undefined) clean.sendFirstImmediately = !!patch.sendFirstImmediately;
        if (patch.restoreView !== undefined) clean.restoreView = !!patch.restoreView;
        if (patch.naturalPacing !== undefined) clean.naturalPacing = !!patch.naturalPacing;
        if (patch.checkInbox !== undefined) clean.checkInbox = !!patch.checkInbox;
        if (patch.activeHours !== undefined) clean.activeHours = !!patch.activeHours;
        if (patch.skipWeekends !== undefined) clean.skipWeekends = !!patch.skipWeekends;
        if (patch.activeStart !== undefined && parseHM(patch.activeStart) !== null) clean.activeStart = patch.activeStart;
        if (patch.activeEnd !== undefined && parseHM(patch.activeEnd) !== null) clean.activeEnd = patch.activeEnd;
        return setState(clean);
      })());
      return true;

    case 'START':
      reply(start('user'));
      return true;

    case 'STOP':
      reply((async () => {
        await stop('user', 'Stopped by you.', 'info');
        return getState();
      })());
      return true;

    case 'SEND_NOW':
      reply((async () => {
        const res = await runCycle(true);
        const st = await getState();
        if (st.running && res.code === 'SENT') {
          await schedule(gapMs(st), 'Scheduled.');
        }
        return { result: res, state: await getState() };
      })());
      return true;

    case 'HEARTBEAT_NOW':
      reply(sendHeartbeat('manual').then((ok) => getState().then((st) => ({ ok, ...st }))));
      return true;

    case 'CLEAR_LOG':
      reply(setState({ log: [], lastMessage: '' }));
      return true;

    case 'CLEAR_SKIPS':
      reply((async () => {
        await setState({ skipIds: [] });
        await log('info', 'Skip list cleared.');
        return getState();
      })());
      return true;
  }
});
