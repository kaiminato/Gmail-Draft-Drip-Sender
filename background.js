/* Gmail Draft Drip Sender - service worker.
 * Owns the schedule. MV3 workers get torn down constantly, so all state lives in
 * chrome.storage.local and the next send is armed as a chrome.alarms one-shot.
 */

const ALARM = 'gmail-draft-drip';
const MAX_LOG = 200;
const MAX_CONSECUTIVE_FAILURES = 5;
const RETRY_DELAY_MS = 60 * 1000;
const SKIP_RETRY_DELAY_MS = 35 * 1000; // alarms clamp below ~30s

const DEFAULTS = {
  running: false,
  minMinutes: 10,
  maxMinutes: 30,
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
  focusTab: false,
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
  log: []
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

async function stop(reason, level) {
  await chrome.alarms.clear(ALARM);
  await setState({ running: false, nextSendAt: 0 });
  await setBadge(false);
  if (reason) await log(level || 'info', reason);
}

function msUntilTomorrow() {
  const d = new Date();
  d.setHours(24, 2, 0, 0); // just past local midnight
  return Math.max(60000, d.getTime() - Date.now());
}

/* ---------- gmail tab plumbing ---------- */

async function findGmailTab() {
  const tabs = await chrome.tabs.query({ url: '*://mail.google.com/*' });
  if (!tabs.length) return null;
  return tabs.find((t) => !t.discarded && t.status === 'complete') || tabs[0];
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
    await new Promise((r) => setTimeout(r, 400));
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return !!(pong && pong.ok);
  } catch (_) {
    return false;
  }
}

/* ---------- one send cycle ---------- */

async function runCycle(manual) {
  if (busy) return { ok: false, code: 'BUSY', message: 'A send is already in progress.' };
  busy = true;
  // Early exits log too, so the popup always explains why nothing was sent.
  const fail = async (code, message) => {
    await log('warn', message);
    return { ok: false, code, message };
  };
  try {
    let st = await rollDailyCounter(await getState());

    if (!manual && st.dailyLimit > 0 && st.sentToday >= st.dailyLimit) {
      await log('warn', 'Daily limit of ' + st.dailyLimit + ' reached. Pausing until tomorrow.');
      await schedule(msUntilTomorrow(), 'Resuming after midnight.');
      return { ok: false, code: 'DAILY_LIMIT' };
    }

    let tab = await findGmailTab();
    if (!tab) {
      return fail('NO_TAB', 'No Gmail tab found. Open mail.google.com and leave it loaded.');
    }
    if (tab.discarded || tab.status !== 'complete') {
      await chrome.tabs.reload(tab.id);
      const ready = await waitForTabComplete(tab.id);
      if (!ready) return fail('TAB_NOT_READY', 'Gmail tab is still loading.');
      await new Promise((r) => setTimeout(r, 3000)); // let Gmail boot its UI
    }

    // A hidden tab gets its timers throttled to about once a minute. Making it
    // the active tab in its window lifts that, at the cost of pulling you off
    // whatever else is in that window.
    if (st.focusTab) {
      try {
        await chrome.tabs.update(tab.id, { active: true });
        await new Promise((r) => setTimeout(r, 1200));
      } catch (_) {}
    }

    const injected = await ensureContentScript(tab.id);
    if (!injected) {
      return fail('NO_CONTENT_SCRIPT', 'Could not reach the Gmail page. Try reloading the tab.');
    }

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
      }
    }

    if (res.ok && res.code === 'SENT') {
      st = await rollDailyCounter(await getState());
      await setState({
        sentToday: st.sentToday + 1,
        totalSent: st.totalSent + 1,
        consecutiveFailures: 0
      });
      const left = typeof res.remaining === 'number' ? ' (' + res.remaining + ' left)' : '';
      await log(res.late ? 'warn' : 'ok', res.message + left);
    } else if (res.code === 'BLOCKED') {
      await setState({ pendingAlerts: res.alerts || [] });
      await log('err', res.message);
    } else if (res.code === 'NO_RECIPIENT') {
      const cur = await getState();
      const id = res.draft && res.draft.id;
      if (id && !cur.skipIds.includes(id)) await setState({ skipIds: [...cur.skipIds, id] });
      await log('warn', res.message);
    } else {
      await log(res.code === 'NO_DRAFTS' || res.code === 'ALL_SKIPPED' ? 'info' : 'warn',
        res.message || ('Send failed: ' + res.code));
    }
    return res;
  } catch (err) {
    const message = String((err && err.message) || err);
    await log('err', 'Unexpected error: ' + message);
    return { ok: false, code: 'ERROR', message };
  } finally {
    busy = false;
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
        await log('warn', 'Daily limit of ' + st.dailyLimit + ' reached. Pausing until tomorrow.');
        await schedule(msUntilTomorrow(), 'Resuming after midnight.');
      } else {
        await schedule(gapMs(st), 'Scheduled.');
      }
      break;
    }
    case 'BLOCKED': {
      const n = (st.pendingAlerts || []).length;
      await stop('Stopped: Gmail is blocking or limiting your mail. Press Start to continue anyway.', 'err');
      notify('Sending stopped', n > 1
        ? n + ' block/limit notices arrived in your inbox.'
        : (res.message || 'Gmail is refusing mail from this account.'));
      break;
    }
    case 'NO_DRAFTS':
      await stop('Drafts folder is empty - stopped.', 'ok');
      notify('Draft sender finished', 'All drafts have been sent.');
      break;
    case 'ALL_SKIPPED':
      await stop('Every remaining draft was skipped as unsendable - stopped.', 'warn');
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
      if (fails >= MAX_CONSECUTIVE_FAILURES) {
        await stop('Stopped after ' + fails + ' failures in a row. Last problem: ' + (res.message || res.code), 'err');
        notify('Draft sender stopped', res.message || res.code);
      } else {
        await schedule(RETRY_DELAY_MS, 'Retry ' + fails + '/' + MAX_CONSECUTIVE_FAILURES + '.');
      }
    }
  }
  return res;
}

/* ---------- start / stop ---------- */

async function start() {
  let st = await rollDailyCounter(await getState());
  // Pressing Start with alerts on screen means "I have seen those" - remember
  // them so the same bounce cannot stop the run a second time.
  if (st.pendingAlerts.length) {
    const acked = [...st.ackedAlerts, ...st.pendingAlerts.map((a) => a.id)].filter(Boolean);
    st = await setState({ ackedAlerts: acked.slice(-50), pendingAlerts: [] });
    await log('info', 'Acknowledged ' + acked.length + ' earlier delivery alert(s).');
  }
  await setState({ running: true, consecutiveFailures: 0 });
  await setBadge(true);
  // The version is stamped here so the log always says which build produced it.
  let ver = '?';
  try { ver = chrome.runtime.getManifest().version; } catch (_) {}
  await log('info', 'Started v' + ver + '. Interval ' + st.minMinutes + '-' + st.maxMinutes + ' minutes, ' +
    ({ oldest: 'oldest draft first', newest: 'newest draft first', random: 'random draft' }[st.order] || st.order) + '.');

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

/* ---------- events ---------- */

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  const st = await getState();
  if (!st.running) return;
  await tick(false);
});

chrome.runtime.onStartup.addListener(async () => {
  const st = await getState();
  await setBadge(st.running);
  if (!st.running) return;
  const existing = await chrome.alarms.get(ALARM);
  if (!existing) await schedule(RETRY_DELAY_MS, 'Browser restarted.');
});

chrome.runtime.onInstalled.addListener(async () => {
  const st = await getState();
  await chrome.storage.local.set({ ...DEFAULTS, ...st });
  await setBadge(st.running);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  const reply = (p) => p.then(sendResponse).catch((e) =>
    sendResponse({ error: String((e && e.message) || e) }));

  switch (msg.type) {
    case 'GET_STATE':
      reply((async () => {
        const st = await rollDailyCounter(await getState());
        const tabs = await chrome.tabs.query({ url: '*://mail.google.com/*' });
        let version = '?';
        try { version = chrome.runtime.getManifest().version; } catch (_) {}
        return { ...st, gmailTabs: tabs.length, busy, version };
      })());
      return true;

    case 'SET_SETTINGS':
      reply((async () => {
        const patch = msg.patch || {};
        const clean = {};
        if (patch.minMinutes !== undefined) clean.minMinutes = Math.max(0.5, Number(patch.minMinutes) || 10);
        if (patch.maxMinutes !== undefined) clean.maxMinutes = Math.max(0.5, Number(patch.maxMinutes) || 30);
        if (clean.minMinutes !== undefined && clean.maxMinutes !== undefined && clean.minMinutes > clean.maxMinutes) {
          const t = clean.minMinutes; clean.minMinutes = clean.maxMinutes; clean.maxMinutes = t;
        }
        if (patch.order !== undefined) clean.order = patch.order;
        if (patch.sendFirstImmediately !== undefined) clean.sendFirstImmediately = !!patch.sendFirstImmediately;
        if (patch.restoreView !== undefined) clean.restoreView = !!patch.restoreView;
        if (patch.dailyLimit !== undefined) clean.dailyLimit = Math.max(0, Math.floor(Number(patch.dailyLimit) || 0));
        if (patch.naturalPacing !== undefined) clean.naturalPacing = !!patch.naturalPacing;
        if (patch.checkInbox !== undefined) clean.checkInbox = !!patch.checkInbox;
        if (patch.focusTab !== undefined) clean.focusTab = !!patch.focusTab;
        if (patch.activeHours !== undefined) clean.activeHours = !!patch.activeHours;
        if (patch.skipWeekends !== undefined) clean.skipWeekends = !!patch.skipWeekends;
        if (patch.activeStart !== undefined && parseHM(patch.activeStart) !== null) clean.activeStart = patch.activeStart;
        if (patch.activeEnd !== undefined && parseHM(patch.activeEnd) !== null) clean.activeEnd = patch.activeEnd;
        return setState(clean);
      })());
      return true;

    case 'START':
      reply(start());
      return true;

    case 'STOP':
      reply((async () => {
        await stop('Stopped by you.', 'info');
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
