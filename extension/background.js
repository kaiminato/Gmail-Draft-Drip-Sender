/* Gmail Draft Drip Sender - service worker.
 * Owns the schedule. MV3 workers get torn down constantly, so all state lives in
 * chrome.storage.local and the next send is armed as a chrome.alarms one-shot.
 *
 * Volume is chosen by tier (few / less / normal / many sends per day). Each day
 * the planner (planner.js) lays out that day's send times like a person's day:
 * a nightly rest, a few sessions, short gaps inside a session. The alarm just
 * fires at the next planned time.
 *
 * It also talks to the dashboard: a heartbeat every half minute reports status
 * and queued events, and the reply may carry a start (with a tier) or stop
 * command the admin has queued.
 */

importScripts('config.js');
// Per-machine override (gitignored). Missing is the normal case.
try { importScripts('config.local.js'); } catch (_) {}
importScripts('planner.js');

const CFG = Object.assign(
  { apiBase: '', apiKey: '', heartbeatMinutes: 0.5 },
  (typeof self !== 'undefined' && self.DRIP_CONFIG) || {}
);
const SERVER_CONFIGURED = /^https?:\/\//.test(CFG.apiBase) && !!CFG.apiKey && CFG.apiKey !== 'REPLACE_ME';
const Planner = self.DripPlanner;
const TIERS = Planner.TIERS;

const ALARM = 'gmail-draft-drip';
const HEARTBEAT_ALARM = 'drip-heartbeat';
const GMAIL_URL = 'https://mail.google.com/';
const MAX_LOG = 200;
const RETRY_DELAY_MS = 60 * 1000;
const SKIP_RETRY_DELAY_MS = 35 * 1000; // alarms clamp below ~30s
const FAILURE_NOTIFY_EVERY = 5;        // failures never stop the run; every Nth notifies
const START_STAGGER_MIN = 20;          // dashboard-triggered starts spread over this
const MAX_QUEUED_EVENTS = 500;
const EVENTS_PER_HEARTBEAT = 100;
const HEARTBEAT_TIMEOUT_MS = 15000;
const CYCLE_STALE_MS = 10 * 60000;

const DEFAULTS = {
  running: false,
  tier: 'normal',
  tierSetAt: 0,
  dayPlan: null,           // see planner.js makeDayPlan()
  alarmKind: 'send',       // 'send' = fire a cycle, 'replan' = new day, make a plan
  order: 'random',
  sendFirstImmediately: true,
  restoreView: true,
  naturalPacing: true,
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
  stopReason: '',        // '' | user | empty | blocked | admin | daily_cap (= target reached)
  lastSendAt: 0,
  remainingBucket: 'unknown', // unknown | none | 1-10 | 10+
  remainingCount: null,       // exact drafts left after the last cycle
  eventQueue: [],
  pendingAcks: [],
  executedCommandIds: [],
  serverLastTryAt: 0,
  serverLastOkAt: 0,
  serverLastError: '',
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

const todayKey = () => Planner.dateKey(Date.now());

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

const validTier = (t) => (TIERS[t] ? t : null);

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

/* ---------- the day plan ---------- */

// Returns today's plan, making a new one when there is none, the day changed,
// the tier changed, or `force` is set (a restart re-plans what is left).
async function ensurePlan(force) {
  let st = await rollDailyCounter(await getState());
  const deviceId = st.deviceId || (await getDeviceId());
  const cur = st.dayPlan;
  const stale = !cur || cur.date !== todayKey() || cur.tier !== st.tier;
  if (!stale && !force) return cur;
  const plan = Planner.makeDayPlan({
    deviceId, tier: st.tier, naturalPacing: st.naturalPacing, fromMs: Date.now(), sentToday: st.sentToday
  });
  await setState({ dayPlan: plan });
  await log('info', Planner.describePlan(plan, st.sentToday));
  return plan;
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

async function scheduleAt(when, note, kind) {
  await setState({ nextSendAt: when, alarmKind: kind || 'send' });
  await chrome.alarms.clear(ALARM);
  chrome.alarms.create(ALARM, { when });
  if (note) await log('info', note + ' Next send ' + describeWhen(when) + '.');
  return when;
}

const schedule = (delayMs, note, kind) => scheduleAt(Date.now() + delayMs, note, kind);

function msUntilTomorrow() {
  const d = new Date();
  d.setHours(24, 2, 0, 0); // just past local midnight
  return Math.max(60000, d.getTime() - Date.now());
}

// Arms the alarm for the next planned time, dropping any that already passed
// (a planned time missed while retrying is skipped, never piled up). With
// nothing left for today the run holds until a new plan after midnight.
async function scheduleNextPlanned(note) {
  const plan = await ensurePlan(false);
  const now = Date.now();
  const left = plan.times.filter((t) => t > now);
  if (left.length !== plan.times.length) await setState({ dayPlan: { ...plan, times: left } });
  if (left.length) {
    await setState({ stopReason: '' });
    return scheduleAt(left[0], note, 'send');
  }
  await setState({ stopReason: 'daily_cap' });
  const when = Date.now() + msUntilTomorrow() + Math.random() * 10 * 60000;
  return scheduleAt(when, 'Target reached for today (' + plan.dayTarget + '). New plan after midnight.', 'replan');
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

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
    // A copy from an older build answers too; replace it so new messages are
    // understood.
    if (pong && pong.ok && pong.version === getVersion()) return true;
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
let emailMissLogged = false;
let emailRefreshInFlight = null;
function refreshAccountEmail() {
  if (emailRefreshInFlight) return emailRefreshInFlight;
  emailRefreshInFlight = (async () => {
    const st = await getState();
    if (st.accountEmail) return;
    const tab = await findGmailTab();
    if (!tab || tab.discarded || tab.status !== 'complete') return;
    if (!(await ensureContentScript(tab.id))) return;
    let r = null;
    try { r = await chrome.tabs.sendMessage(tab.id, { type: 'GET_ACCOUNT' }); } catch (_) {}
    if (r && r.email) {
      await rememberEmail(r.email);
    } else if (!emailMissLogged) {
      emailMissLogged = true;
      await log('warn', 'Could not read the signed-in address from the Gmail page yet' +
        (r && r.title ? ' (title: "' + String(r.title).slice(0, 80) + '")' : '') + '. Will keep trying.');
    }
  })().catch(() => {}).finally(() => { emailRefreshInFlight = null; });
  return emailRefreshInFlight;
}

// A fresh install or reload does not reach tabs that were already open, and
// an old copy of the script answers PING but knows nothing new. Inject into
// every open Gmail tab so the extension is live at once.
async function injectIntoOpenGmailTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: '*://mail.google.com/*' }); } catch (_) {}
  for (const t of tabs) {
    if (t.discarded) continue;
    try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }); } catch (_) {}
  }
  if (tabs.length) setTimeout(() => refreshAccountEmail(), 800);
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

    if (typeof res.remaining === 'number' && res.remaining >= 0) {
      await setState({ remainingCount: res.remaining, remainingBucket: bucketOf(res.remaining) });
    }

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
      await setState({ remainingBucket: 'none', remainingCount: 0 });
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
    case 'SENT':
      await scheduleNextPlanned('Sent.');
      break;
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
    case 'BUSY':
      break;
    default: {
      // A failed cycle is retried for as long as the run is on. The count is
      // kept for the log and the dashboard, and a notification goes out
      // every few failures in a row so a stuck profile does not sit quietly.
      const fails = st.consecutiveFailures + 1;
      await setState({ consecutiveFailures: fails });
      await enqueueEvent('failed', { code: res.code || 'ERROR', message: res.message || '', consecutive: fails });
      if (fails % FAILURE_NOTIFY_EVERY === 0) {
        notify('Draft sender still failing', fails + ' in a row. Last problem: ' + (res.message || res.code));
      }
      await schedule(RETRY_DELAY_MS, 'Retry ' + fails + (fails === 1 ? '' : ' (still trying)') + '.');
    }
  }
  return res;
}

/* ---------- start / stop / tier ---------- */

// `source` is 'user' (popup) or 'admin' (dashboard command). A tier, when
// given, becomes the account's tier before planning.
async function start(source, tier) {
  let st = await rollDailyCounter(await getState());
  // Pressing Start with alerts on screen means "I have seen those" - remember
  // them so the same bounce cannot stop the run a second time.
  if (st.pendingAlerts.length) {
    const acked = [...st.ackedAlerts, ...st.pendingAlerts.map((a) => a.id)].filter(Boolean);
    st = await setState({ ackedAlerts: acked.slice(-50), pendingAlerts: [] });
    await log('info', 'Acknowledged ' + acked.length + ' earlier delivery alert(s).');
  }
  const t = validTier(tier) || validTier(st.tier) || 'normal';
  const tierPatch = t !== st.tier ? { tier: t, tierSetAt: Date.now() } : {};
  await setState({ running: true, consecutiveFailures: 0, stopReason: '', ...tierPatch });
  await setBadge(true);
  // The version is stamped here so the log always says which build produced it.
  await log('info', 'Started v' + getVersion() + (source === 'admin' ? ' from the dashboard' : '') +
    ' on "' + t + '" (' + TIERS[t][0] + '-' + TIERS[t][1] + ' a day), ' +
    ({ oldest: 'oldest draft first', newest: 'newest draft first', random: 'random draft' }[st.order] || st.order) + '.');
  await enqueueEvent('started', { source: source || 'user', tier: t });
  const plan = await ensurePlan(true);

  if (source === 'admin') {
    // Fifty accounts started together must not open Gmail together.
    const delay = rand(0.2, START_STAGGER_MIN) * 60000;
    await schedule(delay, 'Starting in ' + Math.round(delay / 60000) + ' min (staggered).');
  } else if (st.sendFirstImmediately && plan.times.length) {
    await schedule(1000, '');
    tick(false); // fire now; the alarm is a safety net if the worker dies
  } else {
    await scheduleNextPlanned('Following today\'s plan.');
  }
  return getState();
}

// Changes the tier; a running account re-plans the rest of the day.
async function setTier(tier, source) {
  const t = validTier(tier);
  if (!t) return getState();
  const st = await getState();
  if (st.tier === t) return st;
  await setState({ tier: t, tierSetAt: Date.now() });
  await log('info', 'Tier set to "' + t + '" (' + TIERS[t][0] + '-' + TIERS[t][1] + ' a day)' +
    (source === 'admin' ? ' from the dashboard' : '') + '.');
  if (st.running) {
    await ensurePlan(true);
    await scheduleNextPlanned('Re-planned.');
  }
  scheduleHeartbeatSoon();
  return getState();
}

/* ---------- dashboard: heartbeat and commands ---------- */

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
    const period = Math.max(0.5, Number(CFG.heartbeatMinutes) || 0.5);
    chrome.alarms.create(HEARTBEAT_ALARM, { delayInMinutes: 0.1, periodInMinutes: period });
  } catch (_) {}
}

async function collectHeartbeat(trigger) {
  const st = await rollDailyCounter(await getState());
  const deviceId = st.deviceId || (await getDeviceId());
  const tabs = await chrome.tabs.query({ url: '*://mail.google.com/*' });
  const cycling = busy || (st.cycleStartedAt > 0 && Date.now() - st.cycleStartedAt < CYCLE_STALE_MS);
  const plan = st.dayPlan && st.dayPlan.date === todayKey() ? st.dayPlan : null;
  return {
    deviceId,
    email: st.accountEmail || null,
    version: getVersion(),
    ts: Date.now(),
    trigger: trigger || 'alarm',
    running: !!st.running,
    busy: cycling,
    stopReason: st.stopReason || '',
    tier: st.tier,
    tierSetAt: st.tierSetAt || 0,
    dayTarget: plan ? plan.dayTarget : null,
    plannedLeft: plan ? plan.times.length : null,
    restStart: plan ? plan.restStart : '',
    restEnd: plan ? plan.restEnd : '',
    nextSendAt: st.running ? st.nextSendAt || 0 : 0,
    lastSendAt: st.lastSendAt || 0,
    remainingBucket: st.remainingBucket || 'unknown',
    remainingCount: typeof st.remainingCount === 'number' ? st.remainingCount : null,
    sentToday: st.sentToday || 0,
    totalSent: st.totalSent || 0,
    bounceCount: st.bounceCount || 0,
    consecutiveFailures: st.consecutiveFailures || 0,
    gmailTabOpen: tabs.length > 0,
    acks: st.pendingAcks || [],
    events: (st.eventQueue || []).slice(0, EVENTS_PER_HEARTBEAT)
  };
}

let heartbeatInFlight = null;
let heartbeatSoonTimer = null;

// Event-driven beats are debounced and skipped while the server is known to
// be down; the periodic alarm keeps retrying regardless.
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
    // Fill in the address before reporting, if a loaded Gmail tab can tell us.
    try { await refreshAccountEmail(); } catch (_) {}
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

    if (reply && reply.command) await executeCommand(reply.command);
    // More events may be waiting if the queue was long.
    const left = (await getState()).eventQueue.length;
    if (left > 0 && body.events.length >= EVENTS_PER_HEARTBEAT) scheduleHeartbeatSoon();
    return true;
  })().finally(() => { heartbeatInFlight = null; });
  return heartbeatInFlight;
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
    const tier = validTier(cmd.tier);
    if (st.running) {
      // Already running: a different tier is applied, nothing else changes.
      if (tier && tier !== st.tier) await setTier(tier, 'admin');
      await pushAck('done', 'already running');
    } else {
      await start('admin', tier);
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
  if (st.alarmKind === 'replan') {
    // A new day: make the plan and wait for its first time.
    await rollDailyCounter(st);
    await ensurePlan(true);
    await scheduleNextPlanned('New day.');
    return;
  }
  await tick(false);
});

chrome.runtime.onStartup.addListener(async () => {
  const st = await getState();
  await setBadge(st.running);
  await ensureHeartbeatAlarm();
  if (!st.running) return;
  const existing = await chrome.alarms.get(ALARM);
  if (!existing) await scheduleNextPlanned('Browser restarted.');
});

chrome.runtime.onInstalled.addListener(async () => {
  const st = await getState();
  await chrome.storage.local.set({ ...DEFAULTS, ...st });
  await getDeviceId();
  await setBadge(st.running);
  await ensureHeartbeatAlarm();
  await injectIntoOpenGmailTabs();
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
        // Opening the popup is a good moment to fill in a missing address.
        if (!st.accountEmail) refreshAccountEmail();
        const tabs = await chrome.tabs.query({ url: '*://mail.google.com/*' });
        let apiHost = '';
        try { apiHost = new URL(CFG.apiBase).host; } catch (_) {}
        const plan = st.dayPlan && st.dayPlan.date === todayKey() ? st.dayPlan : null;
        return {
          ...st,
          dayPlan: plan,
          tiers: TIERS,
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
        const clean = {};
        if (patch.order !== undefined) clean.order = patch.order;
        if (patch.sendFirstImmediately !== undefined) clean.sendFirstImmediately = !!patch.sendFirstImmediately;
        if (patch.restoreView !== undefined) clean.restoreView = !!patch.restoreView;
        if (patch.naturalPacing !== undefined) clean.naturalPacing = !!patch.naturalPacing;
        if (patch.checkInbox !== undefined) clean.checkInbox = !!patch.checkInbox;
        return setState(clean);
      })());
      return true;

    case 'START':
      reply(start('user', msg.tier));
      return true;

    case 'SET_TIER':
      reply(setTier(msg.tier, 'user'));
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
        if (st.running && res.code === 'SENT') await scheduleNextPlanned('Sent.');
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
