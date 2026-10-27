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
const BASE_CONFIG = (typeof self !== 'undefined' && self.DRIP_CONFIG) || {};
// Per-machine override (gitignored). Missing is the normal case; a key it
// leaves out keeps the value from config.js.
try { importScripts('config.local.js'); } catch (_) {}
importScripts('planner.js');

const CFG = Object.assign(
  { apiBase: '', apiKey: '', heartbeatMinutes: 0.5, timeZone: '' },
  BASE_CONFIG,
  (typeof self !== 'undefined' && self.DRIP_CONFIG) || {}
);
const SERVER_CONFIGURED = /^https?:\/\//.test(CFG.apiBase) && !!CFG.apiKey && CFG.apiKey !== 'REPLACE_ME';
const Planner = self.DripPlanner;
const TIERS = Planner.TIERS;
// One clock for every machine, so their days roll over together.
Planner.setTimeZone(CFG.timeZone);

const ALARM = 'gmail-draft-drip';
const HEARTBEAT_ALARM = 'drip-heartbeat';
const OPEN_GMAIL_ALARM = 'drip-open-gmail';
const GMAIL_MISSING_MS = 3 * 60000;      // a running account without a Gmail tab this long gets one opened
const GMAIL_URL = 'https://mail.google.com/';
const MAX_LOG = 200;
const RETRY_DELAY_MS = 60 * 1000;
const SKIP_RETRY_DELAY_MS = 35 * 1000; // alarms clamp below ~30s
const FAILURE_NOTIFY_EVERY = 5;        // failures never stop the run; every Nth notifies
const START_STAGGER_MIN = 20;          // dashboard-triggered starts spread over this
const MAX_QUEUED_EVENTS = 500;
const EVENTS_PER_HEARTBEAT = 100;
const HEARTBEAT_TIMEOUT_MS = 15000;
const HEARTBEAT_JITTER_MS = 8000;        // alarm beats are spread so profiles on one machine do not fire together
const CHALLENGE_SOLVE_EVERY_MS = 2 * 60000; // at most one browser-check tab this often
const CHALLENGE_TAB_MAX_MS = 45000;      // how long that tab gets to clear the check
const CHALLENGE_RELOADS = 2;             // reloads after a "Failed to verify" before giving up this round
const CHALLENGE_BG_FAILS_BEFORE_POPUP = 2; // background-tab rounds that must fail before a (never focused) window is tried
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
  keepInPlace: true,       // never focus the Gmail window; see bringToFront()
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
  draftCountAt: 0,            // last time the Drafts folder was counted outside a cycle
  eventQueue: [],
  pendingAcks: [],
  executedCommandIds: [],
  serverLastTryAt: 0,
  serverLastOkAt: 0,
  serverLastError: '',
  cycleStartedAt: 0,
  retryDraftId: '',        // the draft the last cycle opened but did not finish sending
  retryDraftSubject: '',
  gmailSignedOut: false,   // Gmail sent the tab somewhere else (sign-in page); no new tab until signed in again
  gmailTabId: 0,           // the tab this extension last opened for Gmail; while it is off Gmail, no other is opened
  gmailMissingSince: 0,    // when the profile was first seen without a Gmail tab
  gmailWatchLoggedAt: 0,   // last time the tab watchdog wrote its status line
  challengeSolveAt: 0,     // last time a browser-check tab was opened
  challengeBgFails: 0      // browser-check rounds in a background tab that failed in a row; reset when one passes
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

// Chrome can keep running a cached copy of this worker after the files on
// disk were replaced: the manifest then reports the new version while the
// code is the old one, and everything added since is silently absent. (Seen
// on the VPS: a 1.6.11 manifest with the 1.6.6 worker.) So the code carries
// its own version, and a mismatch reloads the extension. The two are bumped
// together; extension/test/version.test.js checks that.
const CODE_VERSION = '1.6.20';

async function ensureFreshCode() {
  const manifest = getVersion();
  if (manifest === '?' || manifest === CODE_VERSION) return true;
  const st = await getState();
  const last = Number(st.codeReloadAt) || 0;
  if (Date.now() - last < 10 * 60000) return false; // never a reload storm
  await setState({ codeReloadAt: Date.now() });
  await log('warn', 'The running code is v' + CODE_VERSION + ' but the files are v' + manifest + '; reloading the extension to pick them up.');
  setTimeout(() => { try { chrome.runtime.reload(); } catch (_) {} }, 500);
  return false;
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

// Clicking a notification opens the dashboard's account list scrolled to
// this account's row. The target rides in the notification id, so a click
// after the worker has been restarted still knows where to go.
function notify(title, message) {
  (async () => {
    let url = '';
    try {
      const st = await getState();
      if (SERVER_CONFIGURED && st.deviceId) {
        url = CFG.apiBase.replace(/\/+$/, '') + '/?device=' + encodeURIComponent(st.deviceId);
      }
    } catch (_) {}
    chrome.notifications.create((url ? 'go:' + url : 'n:') + '|' + newId(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message: String(message).slice(0, 300)
    });
  })().catch(() => {});
}

chrome.notifications.onClicked.addListener((id) => {
  const m = /^go:(.+)\|[^|]*$/.exec(id || '');
  try { chrome.notifications.clear(id); } catch (_) {}
  if (m && m[1]) openUrlTab(m[1], true).catch(() => {});
});

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

// The dashboard rejects a heartbeat whose events exceed its field limits, and
// a rejected event would sit at the front of the queue and fail every beat
// after it (a draft sent to 100 recipients did exactly that). So events are
// cut to those limits here, before they are queued.
const EVENT_LIMITS = { subject: 500, from: 320, reason: 100, code: 100, message: 2000, source: 50, tier: 20 };
function fitEvent(ev) {
  const out = { ...ev };
  for (const [k, n] of Object.entries(EVENT_LIMITS)) {
    if (typeof out[k] === 'string' && out[k].length > n) out[k] = out[k].slice(0, n);
  }
  if (Array.isArray(out.recipients)) {
    if (out.recipients.length > 50) out.recipientCount = out.recipients.length;
    out.recipients = out.recipients.slice(0, 50).map((s) => String(s).slice(0, 320));
  }
  if (Array.isArray(out.subjects)) out.subjects = out.subjects.slice(0, 20).map((s) => String(s).slice(0, 500));
  return out;
}

async function enqueueEvent(type, data) {
  const ev = fitEvent({ id: newId(), t: Date.now(), type, ...(data || {}) });
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
  const tz = Planner.timeZone() ? { timeZone: Planner.timeZone() } : {};
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...tz });
  const day = Planner.dateKey(ts);
  if (day === Planner.dateKey(Date.now())) return 'at ' + time;
  if (day === Planner.dateKey(Planner.nextMidnight(Date.now()) + 60000)) return 'tomorrow at ' + time;
  return d.toLocaleDateString([], { weekday: 'long', ...tz }) + ' at ' + time;
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
  // Just past midnight on the configured clock.
  return Math.max(60000, Planner.nextMidnight(Date.now()) + 2 * 60000 - Date.now());
}

// Arms the alarm for the next planned time, dropping any that already passed
// (a planned time missed while retrying is skipped, never piled up). With
// nothing left for today the run holds until a new plan after midnight.
async function scheduleNextPlanned(note) {
  const plan = await ensurePlan(false);
  const st = await rollDailyCounter(await getState());
  const now = Date.now();
  const left = plan.times.filter((t) => t > now);
  // A send outside the plan (Send one now, the immediate first send) counts
  // toward the day: drop planned times from the end so sent plus planned
  // never exceeds the target.
  while (left.length && st.sentToday + left.length > plan.dayTarget) left.pop();
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

// Opens Gmail in a normal browser window, named by id. Never in "the current
// window": while the dashboard host's browser-check popup is up it is the
// focused, hence current, window, and a tab created there is closed with it a
// few seconds later. That is how profiles ended up with no Gmail tab for hours.
// With no normal window at all (Chrome kept alive in the background), one is
// made, so a send never fails on "No current window" either.
async function openUrlTab(url, active) {
  let wins = [];
  try { wins = await chrome.windows.getAll({ windowTypes: ['normal'] }); } catch (_) {}
  if (!wins.length) {
    const win = await chrome.windows.create({ url, type: 'normal', focused: !!active });
    const tab = win && win.tabs && win.tabs[0];
    if (!tab) throw new Error('the new window has no tab');
    return tab;
  }
  const win = wins.find((w) => w.focused) || wins[0];
  if (active) { try { await chrome.windows.update(win.id, { focused: true }); } catch (_) {} }
  return chrome.tabs.create({ url, active: !!active, windowId: win.id });
}

async function createGmailTab(active) {
  const tab = await openUrlTab(GMAIL_URL, active);
  // Remembered so that, wherever Gmail sends it, it still counts as this
  // profile's Gmail tab and no second one is opened beside it.
  if (tab && tab.id != null) await setState({ gmailTabId: tab.id });
  return tab;
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

// Sending drives the real UI, so the Gmail page must not be throttled the way
// Chrome throttles hidden tabs. Making the tab active in its own window is
// usually enough. The window itself is focused only when the page still
// reports itself hidden after that: minimised, or on another virtual desktop
// without the Chrome flag described in the README. So a profile parked on
// another desktop is left there instead of jumping onto the one in use.
async function pageVisible(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.visibilityState === 'visible'
    });
    return !!(r && r.result);
  } catch (_) {
    return false;
  }
}

// Focusing a window on another virtual desktop makes Windows switch the
// operator to that desktop, so by default (keepInPlace) the window is never
// focused: the tab is made active, a minimised window is restored, and that
// is all. A page that still reports hidden then runs its sends throttled,
// which is slower but correct (see the README on background tabs); the
// Chrome switches from the README make such a page count as visible again.
let hiddenLogged = false;
async function bringToFront(tab) {
  const st = await getState();
  try { await chrome.tabs.update(tab.id, { active: true }); } catch (_) {}
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === 'minimized') await chrome.windows.update(win.id, { state: 'normal' });
  } catch (_) {}
  await sleep(400);
  if (await pageVisible(tab.id)) return;
  if (st.keepInPlace) {
    if (!hiddenLogged) {
      hiddenLogged = true;
      await log('info', 'Gmail tab reports itself hidden and is left where it is, so sends run slower. ' +
        'Launch this profile with the Chrome switches from the README to keep them quick, ' +
        'or untick "Never bring Gmail to the front".');
    }
    return;
  }
  if (!hiddenLogged) {
    hiddenLogged = true;
    await log('info', 'Gmail tab reports itself hidden, so its window is brought forward for each send. ' +
      'To keep it where it is, launch this profile with the Chrome switches from the README.');
  }
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
  try { await chrome.tabs.update(tab.id, { active: true }); } catch (_) {}
  await sleep(1200);
}

// Where a signed-out profile's Gmail tab ends up: the sign-in page, the
// Gmail front page for people without a session, an account notice.
const SIGNED_OUT_URLS = [
  '*://accounts.google.com/*',
  '*://accounts.youtube.com/*',
  '*://myaccount.google.com/*',
  '*://www.google.com/gmail/*',
  '*://workspace.google.com/*'
];

// A Google sign-in page in this profile: Gmail sent its tab there because the
// session expired. While one is open, no Gmail tab is opened, since it would
// only land on the same page, a minute apart, for ever. Gmail does not always
// use accounts.google.com for that, so the tab this extension itself opened
// for Gmail counts too, wherever it was sent: a tab opened for Gmail that is
// not on Gmail is the sign-in tab, whatever its address. That is what kept
// opening tab after tab: the first one landed on a page the host list did
// not know, and every few minutes another went the same way.
async function findSignInTab() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: SIGNED_OUT_URLS }); } catch (_) {}
  if (tabs[0]) return tabs[0];
  const id = Number((await getState()).gmailTabId) || 0;
  if (!id) return null;
  let t = null;
  try { t = await chrome.tabs.get(id); } catch (_) { await setState({ gmailTabId: 0 }); return null; }
  const url = (t && (t.url || t.pendingUrl)) || '';
  if (/^https?:\/\/mail\.google\.com\//i.test(url)) return null;
  // Tab ids start over when the browser restarts, so the remembered one may
  // now be any tab at all: it only counts while it is somewhere Google sends
  // a signed-out Gmail tab, or on an error page.
  if (!/^https?:\/\/[^/]*\.(google|youtube)\.com\//i.test(url) && !/^chrome-error:/i.test(url)) {
    await setState({ gmailTabId: 0 });
    return null;
  }
  return t;
}

function tabHost(t) {
  const url = (t && (t.url || t.pendingUrl)) || '';
  if (/^chrome-error:/i.test(url)) return 'an error page';
  try { return new URL(url).hostname || 'accounts.google.com'; } catch (_) { return 'accounts.google.com'; }
}

// Finds, or opens, a Gmail tab and brings it to the front fully loaded.
async function acquireGmailTab() {
  let tab = await findGmailTab();
  let created = false;
  if (!tab) {
    const signin = await findSignInTab();
    if (signin) {
      return { error: 'NOT_SIGNED_IN', message: 'Gmail is asking for a sign-in (' + tabHost(signin) + ' is open instead of Gmail).' };
    }
    try {
      tab = await createGmailTab(true);
    } catch (e) {
      return { error: 'NO_TAB', message: 'Could not open a Gmail tab: ' + ((e && e.message) || e) };
    }
    created = true;
    await log('info', 'No Gmail tab was open - opened one.');
  } else if (tab.discarded || tab.status !== 'complete') {
    try { await chrome.tabs.reload(tab.id); } catch (_) {}
  }

  // Activate the tab so it loads at full speed; the window is dealt with once
  // the page is there and can say whether it is visible.
  try { await chrome.tabs.update(tab.id, { active: true }); } catch (_) {}

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
    // The tab is left where it is: it is the sign-in page someone has to use.
    return {
      error: 'NOT_SIGNED_IN',
      message: 'The Gmail tab went to ' + (host || 'another page') + ' instead of Gmail - this profile needs to sign in again.'
    };
  }

  await bringToFront(fresh);
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

/* ---------- drafts-left count ---------- */

const COUNT_RETRY_MS = 5 * 60000;
const COUNT_EVERY_STOPPED_MS = 10 * 60000;
const COUNT_EVERY_RUNNING_MS = 30 * 60000;

// A run parked on an empty folder, or one whose planned times ran out while
// it was empty, picks the day up again with a plan for what is left of it.
async function draftsBack(st, count) {
  const target = st.dayPlan && st.dayPlan.date === todayKey() ? st.dayPlan.dayTarget : 0;
  const parked = st.stopReason === 'empty' || (st.stopReason === 'daily_cap' && st.sentToday < target);
  if (count > 0 && st.running && parked && !busy) {
    await setState({ stopReason: '' });
    await ensurePlan(true);
    await scheduleNextPlanned('Drafts are back (' + count + ').');
  }
}

// The cheap count: Gmail's own Drafts badge in its sidebar, readable from
// any view without navigating. Taken before every heartbeat and a few
// seconds after each send, so the dashboard's drafts-left follows the folder
// within a minute. The full count below stays for when the badge is not
// there (a page that just loaded, or no badge at all).
let draftBadgeInFlight = null;
function refreshDraftBadge() {
  if (draftBadgeInFlight) return draftBadgeInFlight;
  draftBadgeInFlight = (async () => {
    const st = await getState();
    if (busy) return;
    const tab = await findGmailTab();
    if (!tab || tab.discarded || tab.status !== 'complete') return;
    let r = null;
    try { r = await chrome.tabs.sendMessage(tab.id, { type: 'DRAFTS_BADGE' }); } catch (_) { return; }
    if (!r || !r.ok || typeof r.count !== 'number') return;
    if (r.count === st.remainingCount) return;
    await setState({ remainingCount: r.count, remainingBucket: bucketOf(r.count), draftCountAt: Date.now() });
    await log('info', 'Drafts left: ' + r.count + '.');
    await draftsBack(st, r.count);
    scheduleHeartbeatSoon();
  })().catch(() => {}).finally(() => { draftBadgeInFlight = null; });
  return draftBadgeInFlight;
}

// Keeps the drafts-left figure current without a send: soon when there is
// none (a fresh install, an update from a build that only reported a range)
// or a 0 sits on a running account, every ten minutes on a stopped account
// (drafts get added to those), every half hour on a running one (its sends
// keep the figure fresh in between). Never during a cycle. It reads an
// already-loaded Gmail tab and puts its view back; it never opens a tab or
// brings one forward.
let draftCountInFlight = null;
function refreshDraftCount() {
  if (draftCountInFlight) return draftCountInFlight;
  draftCountInFlight = (async () => {
    const st = await getState();
    if (busy || (st.cycleStartedAt > 0 && Date.now() - st.cycleStartedAt < CYCLE_STALE_MS)) return;
    const known = typeof st.remainingCount === 'number';
    const every = !known || (st.running && st.remainingCount === 0) ? COUNT_RETRY_MS
      : st.running ? COUNT_EVERY_RUNNING_MS : COUNT_EVERY_STOPPED_MS;
    if (Date.now() - (st.draftCountAt || 0) < every) return;
    const tab = await findGmailTab();
    if (!tab || tab.discarded || tab.status !== 'complete') return;
    await setState({ draftCountAt: Date.now() });
    if (!(await ensureContentScript(tab.id))) return;
    let r = null;
    try {
      r = await chrome.tabs.sendMessage(tab.id, { type: 'COUNT_DRAFTS', restoreView: st.restoreView });
    } catch (_) {}
    if (!r || !r.ok || typeof r.count !== 'number') return;
    if (r.count === st.remainingCount) return;
    await setState({ remainingCount: r.count, remainingBucket: bucketOf(r.count) });
    await log('info', 'Drafts left: ' + r.count + '.');
    await draftsBack(st, r.count);
    scheduleHeartbeatSoon();
  })().catch(() => {}).finally(() => { draftCountInFlight = null; });
  return draftCountInFlight;
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
  // A count in progress is reading the same tab; let it finish first.
  if (draftCountInFlight) { try { await draftCountInFlight; } catch (_) {} }
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
        preferId: st.retryDraftId || '',
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
    // Gmail updates its badge a moment after a send; read it then, so the
    // figure the dashboard gets is the folder's own, not an estimate.
    setTimeout(() => refreshDraftBadge().catch(() => {}), 4000);

    if (res.ok && res.code === 'SENT') {
      st = await rollDailyCounter(await getState());
      await setState({
        sentToday: st.sentToday + 1,
        totalSent: st.totalSent + 1,
        consecutiveFailures: 0,
        lastSendAt: Date.now(),
        stopReason: '',
        retryDraftId: '',
        retryDraftSubject: ''
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
    } else if (res.code === 'NO_RECIPIENT' || res.code === 'TOO_MANY_RECIPIENTS') {
      const cur = await getState();
      const id = res.draft && res.draft.id;
      if (id && !cur.skipIds.includes(id)) await setState({ skipIds: [...cur.skipIds, id] });
      await setState({ retryDraftId: '', retryDraftSubject: '' }); // skipped, not to be retried
      await log(res.code === 'TOO_MANY_RECIPIENTS' ? 'err' : 'warn', res.message);
      if (res.code === 'TOO_MANY_RECIPIENTS') {
        // Worth a line on the dashboard and a notification: on a compromised
        // account this is the first visible sign.
        await enqueueEvent('failed', { code: res.code, message: res.message || '' });
        notify('Suspicious draft skipped', 'A draft with ' + (res.recipientCount || 'many') + ' recipients was not sent. Check the Drafts folder and the account\'s security.');
      }
    } else if (res.code === 'NO_DRAFTS') {
      await setState({ remainingBucket: 'none', remainingCount: 0, retryDraftId: '', retryDraftSubject: '' });
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
    case 'ALL_SKIPPED': {
      // Nothing to send right now. The run stays on: the folder is checked
      // every few minutes and sending resumes, on a fresh plan for the rest
      // of the day, as soon as drafts appear (see refreshDraftCount).
      // Planned times that pass meanwhile are simply dropped.
      const first = st.stopReason !== 'empty';
      await scheduleNextPlanned('');
      const after = await getState();
      if (after.stopReason !== 'daily_cap') await setState({ stopReason: 'empty' });
      if (first) {
        const what = res.code === 'NO_DRAFTS' ? 'Drafts folder is empty' : 'Every remaining draft was skipped as unsendable';
        await log(res.code === 'NO_DRAFTS' ? 'ok' : 'warn', what + ' - waiting for new drafts, checking every few minutes.');
        notify('Waiting for drafts', what + '. Sending resumes on its own when drafts appear.');
      }
      break;
    }
    case 'NOT_SIGNED_IN': {
      // Retrying a minute later would only open another Gmail tab that lands
      // on the same sign-in page. Stop; the tab watchdog starts the run again
      // by itself once a Gmail tab is back.
      await setState({ gmailSignedOut: true });
      await stop('signin', 'Gmail needs a sign-in - stopped until this profile is signed in again; sending resumes on its own after that.', 'err');
      notify('Gmail sign-in needed', 'This profile was signed out of Gmail. Sign in again and sending resumes by itself.');
      break;
    }
    case 'NO_RECIPIENT':
    case 'TOO_MANY_RECIPIENTS':
      await schedule(SKIP_RETRY_DELAY_MS, 'Moving on to the next draft.');
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

// A running account whose send alarm is gone (an extension update clears
// every alarm, and Chrome can drop one) would otherwise sit "running" and
// never send again. Re-arm it from the plan; a missing or stale plan is
// made on the way. Safe to call often: it does nothing while the alarm is
// there or a cycle is on.
async function resumeIfNeeded(note) {
  const st = await getState();
  if (!st.running || busy) return false;
  const existing = await chrome.alarms.get(ALARM);
  if (!existing) {
    await scheduleNextPlanned(note);
    return true;
  }
  // A new day while still holding on yesterday's "done for today": make the
  // plan now rather than waiting for the after-midnight alarm, so the
  // dashboard shows the day's target within a heartbeat of midnight.
  if (st.alarmKind === 'replan' && st.dayPlan && st.dayPlan.date !== todayKey()) {
    await rollDailyCounter(st);
    await ensurePlan(true);
    await scheduleNextPlanned('New day.');
    return true;
  }
  return false;
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

/* ---------- the host's browser check ---------- */

// Vercel's DDoS mitigation sometimes answers a heartbeat from a busy address
// (a VPS running many profiles) with a browser challenge instead of passing
// it to the dashboard: HTTP 429 or 403, header x-vercel-mitigated: challenge,
// and an HTML page whose script proves a real browser and earns a cookie. A
// background fetch cannot run that script, but a tab can, and the cookie it
// earns rides on later fetches because they include credentials. So a
// challenge opens the dashboard in a background tab, waits for the checkpoint
// to clear, closes the tab and beats again. Nothing about it takes the focus:
// the tab is never the active one, and the fallback window is never focused.
let challengeSolve = null;

function isChallenge(r) {
  const how = (r.headers.get('x-vercel-mitigated') || '').toLowerCase();
  if (how) return how.includes('challenge');
  const type = r.headers.get('content-type') || '';
  return (r.status === 429 || r.status === 403) && /text\/html/i.test(type);
}

function solveChallenge() {
  if (challengeSolve) return challengeSolve;
  const nap = (ms) => new Promise((res) => setTimeout(res, ms));
  const url = CFG.apiBase.replace(/\/+$/, '') + '/login';
  challengeSolve = (async () => {
    // The guard lives in storage: the worker sleeps between heartbeats, and
    // a variable started from zero every time, so a tab opened per beat.
    const st0 = await getState();
    const last = Number(st0.challengeSolveAt) || 0;
    if (Date.now() - last < CHALLENGE_SOLVE_EVERY_MS) return false;
    const bgFails = Number(st0.challengeBgFails) || 0;
    // A background tab never takes the focus from whatever the person is
    // doing, in this profile or another, so that is where the check runs.
    // Only when the background tab keeps ending in "Failed to verify" (the
    // checkpoint's script starved by tab throttling) does the check get a
    // small window of its own instead, and even that one stays behind the
    // window in use: a check that pops in front every two minutes on every
    // profile makes the machine unusable.
    const usePopup = bgFails >= CHALLENGE_BG_FAILS_BEFORE_POPUP;
    await setState({ challengeSolveAt: Date.now() });
    let win = null;
    let tabId = null;
    try {
      if (usePopup) {
        win = await chrome.windows.create({ url, type: 'popup', focused: false, width: 520, height: 420 });
        tabId = win && win.tabs && win.tabs[0] ? win.tabs[0].id : null;
        if (tabId == null) throw new Error('the check window has no tab');
      } else {
        const tab = await openUrlTab(url, false);
        tabId = tab && tab.id;
        if (tabId == null) throw new Error('the check tab was not created');
      }
      // The checkpoint page reloads into the real page once it is satisfied;
      // with a cookie still valid there is no checkpoint and it loads at once.
      // When it gives up it says so on the page, and a fresh load gets a new
      // attempt, which often passes.
      const started = Date.now();
      let cleared = false;
      let reloads = 0;
      let lastText = '';
      while (Date.now() - started < CHALLENGE_TAB_MAX_MS) {
        await nap(1500);
        let t = null;
        try { t = await chrome.tabs.get(tabId); } catch (_) { break; }
        if (t.status !== 'complete') continue;
        let page = null;
        try {
          const [r] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => ({ title: document.title, text: ((document.body && document.body.innerText) || '').slice(0, 400) })
          });
          page = r && r.result;
        } catch (_) {}
        const title = (page && page.title) || t.title || '';
        lastText = (page && page.text) || '';
        if (/failed to verify/i.test(lastText)) {
          if (reloads >= CHALLENGE_RELOADS) break;
          reloads++;
          try { await chrome.tabs.reload(tabId); } catch (_) {}
          await nap(2500);
          continue;
        }
        if (!/checkpoint|verif|just a moment|challenge/i.test(title)) {
          cleared = true;
          await nap(1000); // let the cookie land before the tab goes
          break;
        }
      }
      const code = /code\s*(\d+)/i.exec(lastText);
      const where = usePopup ? 'in a window behind the one in use' : 'in a background tab';
      await setState({ challengeBgFails: cleared ? 0 : bgFails + 1 });
      await log(cleared ? 'info' : 'warn', cleared
        ? 'Passed the dashboard host\'s browser check ' + where + (reloads ? ' after ' + (reloads + 1) + ' attempts' : '') + '; reporting resumes.'
        : 'The dashboard host\'s browser check did not pass ' + where + (reloads ? ' in ' + (reloads + 1) + ' attempts' : '') +
          (code ? ' (code ' + code[1] + ')' : '') + '. Trying again in ' + Math.round(CHALLENGE_SOLVE_EVERY_MS / 60000) + ' min' +
          (!usePopup && bgFails + 1 >= CHALLENGE_BG_FAILS_BEFORE_POPUP ? ', in a small window behind the one in use' : '') + '.');
      return cleared;
    } catch (e) {
      await log('warn', 'Could not open a tab for the dashboard host\'s browser check: ' + String((e && e.message) || e));
      return false;
    } finally {
      if (win) { try { await chrome.windows.remove(win.id); } catch (_) {} }
      else if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch (_) {} }
    }
  })().finally(() => { challengeSolve = null; });
  return challengeSolve;
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
    // The drafts-left figure: the badge is quick and read every beat; the
    // full count is not awaited (it can take a while) and beats again on
    // its own once it has a number.
    try { await refreshDraftBadge(); } catch (_) {}
    refreshDraftCount();
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
        // Cookies for the dashboard host go along, which is how a passed
        // browser check (see solveChallenge) carries over to these requests.
        credentials: 'include',
        signal: ctl.signal
      });
      if (!r.ok) {
        if (isChallenge(r)) {
          // Pass it in a tab, then beat again straight away. Not awaited:
          // this beat is already lost, and the tab may take a while.
          solveChallenge().then((ok) => {
            if (ok) setTimeout(() => sendHeartbeat('challenge').catch(() => {}), 1500);
          });
          throw new Error('HTTP ' + r.status + ' browser check by the host (Vercel DDoS mitigation); passing it in a tab');
        }
        // The dashboard says why in its JSON body (e.g. a rejected field).
        let detail = '';
        try { detail = (await r.text()).replace(/\s+/g, ' ').trim().slice(0, 160); } catch (_) {}
        if (r.status === 400 && body.events.length) {
          // A rejected batch would be re-sent and rejected on every beat
          // from now on, taking the whole account offline. Drop it: the
          // status fields still go out on the next beat.
          const bad = new Set(body.events.map((e) => e.id));
          await withQueueLock(async () => {
            const st = await getState();
            await setState({ eventQueue: st.eventQueue.filter((e) => !bad.has(e.id)) });
          });
          detail += ' - dropped ' + body.events.length + ' queued event(s) the dashboard rejected, so reporting can continue';
        }
        throw new Error('HTTP ' + r.status + (detail ? ' ' + detail : ''));
      }
      reply = await r.json();
    } catch (e) {
      const msg = (e && e.name === 'AbortError')
        ? 'timed out after ' + Math.round(HEARTBEAT_TIMEOUT_MS / 1000) + 's'
        : String((e && e.message) || e);
      // Logged once per outage, not on every retry.
      const wasFailing = !!(await getState()).serverLastError;
      await setState({ serverLastError: msg });
      if (!wasFailing) await log('warn', 'Dashboard heartbeat failed (' + trigger + '): ' + msg + '. Retrying every heartbeat.');
      return false;
    } finally {
      clearTimeout(timer);
    }

    // Prune by id: anything queued during the request stays.
    const sentIds = new Set(body.events.map((e) => e.id));
    const ackIds = new Set(body.acks.map((a) => a.id));
    let recovered = false;
    await withQueueLock(async () => {
      const st = await getState();
      recovered = !!st.serverLastError;
      await setState({
        eventQueue: st.eventQueue.filter((e) => !sentIds.has(e.id)),
        pendingAcks: st.pendingAcks.filter((a) => !ackIds.has(a.id)),
        serverLastOkAt: Date.now(),
        serverLastError: ''
      });
    });
    if (recovered) {
      await log('ok', 'Dashboard reachable again' +
        (sentIds.size ? ' (' + sentIds.size + ' queued event' + (sentIds.size === 1 ? '' : 's') + ' delivered)' : '') + '.');
    }

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

/* ---------- the Gmail tab after a browser start ---------- */

// A running account used to get its Gmail tab back only at the next planned
// send, which in a rest block can be hours after the browser started; until
// then nothing could be counted or read. Now a start schedules one within a
// minute or so, staggered so ten profiles do not load Gmail together, and
// the heartbeat watches for a tab that stays missing (closed by hand, or a
// start that was missed) and opens one after a few minutes. The "missing
// since" mark lives in storage: the worker is put to sleep between
// heartbeats, so anything kept in memory starts from zero every time.

function scheduleGmailTabOpen() {
  // Alarms survive the worker being put to sleep; a timer would not.
  try { chrome.alarms.create(OPEN_GMAIL_ALARM, { delayInMinutes: 0.5 + Math.random() }); } catch (_) {}
}

async function openGmailTabIfMissing(why) {
  if (busy) {
    await log('info', 'Gmail tab not opened ' + why + ': a send is in progress.');
    return false;
  }
  const found = await findGmailTab();
  if (found) {
    await log('info', 'Gmail tab not opened ' + why + ': one exists (' + String(found.url || found.pendingUrl || '?').slice(0, 60) +
      ', ' + found.status + (found.discarded ? ', discarded' : '') + ', window ' + found.windowId + ').');
    return false;
  }
  if (await findSignInTab()) return false; // the watchdog has said why
  try {
    // In the background: the send cycle brings it forward when it needs to,
    // and a profile set to stay out of the way keeps staying out of the way.
    await createGmailTab(false);
    await log('info', 'No Gmail tab ' + why + ' - opened one in the background.');
    return true;
  } catch (e) {
    await log('warn', 'Could not open a Gmail tab ' + why + ': ' + String((e && e.message) || e));
    return false;
  }
}

// Runs on every heartbeat, running or stopped: an enabled extension keeps a
// Gmail tab open so the address is known, the drafts are counted and a start
// from the dashboard has somewhere to go. The one exception is a profile
// Gmail has sent to its sign-in page: another Gmail tab would land there too,
// so none is opened until someone signs in, and a run stopped for that
// reason is started again by itself the moment Gmail is back.
async function watchGmailTab() {
  const st = await getState();
  const since = Number(st.gmailMissingSince) || 0;
  const tab = await findGmailTab();
  if (tab) {
    if (st.gmailSignedOut) {
      await setState({ gmailSignedOut: false });
      await log('ok', 'Gmail is signed in again.');
      const cur = await getState();
      if (!cur.running && cur.stopReason === 'signin') await start('auto');
      scheduleHeartbeatSoon();
    }
    if (since) await setState({ gmailMissingSince: 0 });
    return;
  }
  const signin = await findSignInTab();
  if (signin) {
    if (!st.gmailSignedOut) {
      await setState({ gmailSignedOut: true });
      await log('warn', 'Gmail sent its tab to ' + tabHost(signin) + ' instead of Gmail: this profile needs a sign-in. No other Gmail tab will be opened until it is signed in again; sign in on that tab.');
      scheduleHeartbeatSoon();
    }
    if (since) await setState({ gmailMissingSince: 0 });
    return;
  }
  // Every few minutes, say what the watchdog sees, so a tab that never
  // appears can be explained from the log alone.
  if (Date.now() - (Number(st.gmailWatchLoggedAt) || 0) > 5 * 60000) {
    await setState({ gmailWatchLoggedAt: Date.now() });
    await log('info', 'Watchdog: no Gmail tab' +
      (since ? ' since ' + new Date(since).toLocaleTimeString() : ' (just noticed)') +
      '; running ' + st.running + ', busy ' + busy + '. One is opened after ' +
      Math.round(GMAIL_MISSING_MS / 60000) + ' min without.');
  }
  if (!since) { await setState({ gmailMissingSince: Date.now() }); return; }
  if (Date.now() - since < GMAIL_MISSING_MS) return;
  await setState({ gmailMissingSince: 0 });
  await openGmailTabIfMissing('for ' + Math.round(GMAIL_MISSING_MS / 60000) + ' minutes');
}

/* ---------- events ---------- */

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    // Watchdog: a running account must always have its next send armed.
    resumeIfNeeded('Send schedule was missing; resumed.').catch(() => {});
    watchGmailTab().catch(() => {});
    // Jittered: ten profiles whose alarms were created in the same second
    // would otherwise hit the dashboard in the same second, every time.
    setTimeout(() => sendHeartbeat('alarm').catch(() => {}), Math.random() * HEARTBEAT_JITTER_MS);
    return;
  }
  if (alarm.name === OPEN_GMAIL_ALARM) {
    openGmailTabIfMissing('after the browser started').catch(() => {});
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
  // Tab ids do not survive a restart; the remembered Gmail tab is gone.
  if (st.gmailTabId) await setState({ gmailTabId: 0 });
  await setBadge(st.running);
  await ensureHeartbeatAlarm();
  await resumeIfNeeded('Browser restarted.');
  scheduleGmailTabOpen();
});

chrome.runtime.onInstalled.addListener(async () => {
  const st = await getState();
  await chrome.storage.local.set({ ...DEFAULTS, ...st });
  await getDeviceId();
  await setBadge(st.running);
  await ensureHeartbeatAlarm();
  await injectIntoOpenGmailTabs();
  // An update clears the alarms; a running account carries on from here.
  await resumeIfNeeded('Extension updated to v' + getVersion() + '; carrying on.');
  // A browser restart with changed files arrives here, not at onStartup.
  scheduleGmailTabOpen();
  sendHeartbeat('boot').catch(() => {});
});

// Runs on every worker wake-up, so the heartbeat alarm can never go missing
// and stale worker code never survives a file update.
ensureHeartbeatAlarm();
ensureFreshCode().catch(() => {});

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

    case 'DRAFT_PICKED':
      // From the content script, just before it presses Send: remembered so
      // a run that dies mid-send (tab closed, Chrome restarted, worker gone)
      // starts its next cycle with this draft, not another random one. A
      // confirmed send, or a skip, clears it.
      if (sender && sender.tab && typeof msg.id === 'string') {
        setState({ retryDraftId: msg.id, retryDraftSubject: String(msg.subject || '').slice(0, 200) }).catch(() => {});
      }
      sendResponse({ ok: true });
      return;

    case 'GET_STATE':
      reply((async () => {
        const st = await rollDailyCounter(await getState());
        // Opening the popup is a good moment to fill in a missing address.
        if (!st.accountEmail) refreshAccountEmail();
        if (typeof st.remainingCount !== 'number') refreshDraftCount();
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
          codeVersion: CODE_VERSION,
          serverConfigured: SERVER_CONFIGURED,
          apiHost,
          timeZone: Planner.timeZone() || ''
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
        if (patch.keepInPlace !== undefined) clean.keepInPlace = !!patch.keepInPlace;
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
