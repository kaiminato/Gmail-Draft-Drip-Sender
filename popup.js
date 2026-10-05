/* Popup UI: renders state from the service worker and sends it commands. */

const $ = (id) => document.getElementById(id);
const send = (type, extra) => chrome.runtime.sendMessage({ type, ...(extra || {}) });

let state = null;
let ticker = null;

function fmtCountdown(ms) {
  if (ms <= 0) return 'any moment';
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return h + 'h ' + m + 'm'; // overnight and weekend holds
  return m + ':' + String(s).padStart(2, '0');
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Same-day times need no date; anything further out does.
function fmtWhen(ts) {
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return fmtTime(ts);
  return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + fmtTime(ts);
}

function renderStatus() {
  if (!state) return;
  const box = $('status');
  const main = $('statusMain');
  const sub = $('statusSub');

  $('dot').classList.toggle('on', state.running);
  $('toggle').textContent = state.running ? 'Stop' : 'Start';
  $('toggle').classList.toggle('stop', state.running);

  box.classList.remove('running', 'error', 'idle');

  if (state.busy) {
    box.classList.add('running');
    main.textContent = 'Sending…';
    sub.textContent = 'Working in the Gmail tab.';
  } else if (state.running) {
    box.classList.add('running');
    const left = state.nextSendAt - Date.now();
    main.textContent = 'Next send in ' + fmtCountdown(left);
    sub.textContent = state.nextSendAt
      ? 'Scheduled for ' + fmtWhen(state.nextSendAt) + (state.lastMessage ? ' · ' + state.lastMessage : '')
      : (state.lastMessage || '');
  } else {
    box.classList.add('idle');
    main.textContent = 'Idle';
    sub.textContent = state.lastMessage || 'Press Start to begin sending drafts.';
  }

  const pill = $('tabPill');
  if (state.gmailTabs > 0) {
    pill.textContent = state.gmailTabs === 1 ? 'Gmail open' : state.gmailTabs + ' Gmail tabs';
    pill.classList.remove('bad');
  } else {
    pill.textContent = 'no Gmail tab';
    pill.classList.add('bad');
  }

  const alerts = state.pendingAlerts || [];
  $('alertBox').hidden = alerts.length === 0;
  if (alerts.length) {
    const a = alerts[0];
    $('alertText').textContent = a.subject +
      (a.from ? ' — ' + a.from : '') +
      (alerts.length > 1 ? ' (+' + (alerts.length - 1) + ' more)' : '');
    box.classList.remove('idle', 'running');
    box.classList.add('error');
  }

  $('sentToday').textContent = state.sentToday;
  $('totalSent').textContent = state.totalSent;
  $('skipCount').textContent = state.skipIds.length;
  $('bounceCount').textContent = state.bounceCount || 0;
  $('clearSkips').disabled = state.skipIds.length === 0;
  $('sendNow').disabled = !!state.busy;
}

function hm(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function renderSettings() {
  $('minMinutes').value = state.minMinutes;
  $('maxMinutes').value = state.maxMinutes;
  $('order').value = state.order;
  $('dailyLimit').value = state.dailyLimit;
  $('sendFirstImmediately').checked = state.sendFirstImmediately;
  $('restoreView').checked = state.restoreView;
  $('checkInbox').checked = state.checkInbox;
  $('focusTab').checked = state.focusTab;
  $('naturalPacing').checked = state.naturalPacing;
  $('skipWeekends').checked = state.skipWeekends;
  $('activeHours').checked = state.activeHours;
  $('activeStart').value = state.activeStart;
  $('activeEnd').value = state.activeEnd;
  renderHours();
}

function renderHours() {
  const on = $('activeHours').checked;
  $('activeStart').disabled = !on;
  $('activeEnd').disabled = !on;
  const a = hm($('activeStart').value);
  const b = hm($('activeEnd').value);
  $('hoursWarn').hidden = !(on && a !== null && b !== null && a >= b);
}

function renderLog() {
  const ul = $('log');
  ul.textContent = '';
  if (!state.log.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing yet.';
    ul.append(li);
    return;
  }
  for (const e of state.log) {
    const li = document.createElement('li');
    li.className = e.level;
    const t = document.createElement('time');
    t.textContent = fmtTime(e.t);
    const m = document.createElement('span');
    m.className = 'msg';
    m.textContent = e.msg;
    li.append(t, m);
    ul.append(li);
  }
}

async function refresh(full) {
  state = await send('GET_STATE');
  if (full) renderSettings();
  renderStatus();
  renderLog();
}

function pushSettings() {
  return send('SET_SETTINGS', {
    patch: {
      minMinutes: $('minMinutes').value,
      maxMinutes: $('maxMinutes').value,
      order: $('order').value,
      dailyLimit: $('dailyLimit').value,
      sendFirstImmediately: $('sendFirstImmediately').checked,
      restoreView: $('restoreView').checked,
      checkInbox: $('checkInbox').checked,
      focusTab: $('focusTab').checked,
      naturalPacing: $('naturalPacing').checked,
      skipWeekends: $('skipWeekends').checked,
      activeHours: $('activeHours').checked,
      activeStart: $('activeStart').value,
      activeEnd: $('activeEnd').value
    }
  }).then((s) => { state = { ...state, ...s }; renderStatus(); });
}

['order', 'sendFirstImmediately', 'restoreView', 'checkInbox', 'focusTab', 'naturalPacing', 'skipWeekends']
  .forEach((id) => $(id).addEventListener('change', pushSettings));

['activeHours', 'activeStart', 'activeEnd'].forEach((id) => {
  $(id).addEventListener('change', async () => {
    renderHours();
    await pushSettings();
  });
});

['minMinutes', 'maxMinutes', 'dailyLimit'].forEach((id) => {
  $(id).addEventListener('change', async () => {
    await pushSettings();
    renderSettings(); // reflect clamping / min-max swap
  });
});

$('toggle').addEventListener('click', async () => {
  $('toggle').disabled = true;
  try {
    await pushSettings();
    state = await send(state.running ? 'STOP' : 'START');
    renderStatus();
    renderLog();
  } finally {
    $('toggle').disabled = false;
  }
  setTimeout(() => refresh(false), 1200);
});

$('sendNow').addEventListener('click', async () => {
  $('sendNow').disabled = true;
  $('sendNow').textContent = 'Sending…';
  try {
    await send('SEND_NOW');
  } finally {
    $('sendNow').textContent = 'Send one now';
    await refresh(false);
  }
});

$('clearSkips').addEventListener('click', async () => {
  state = await send('CLEAR_SKIPS');
  renderStatus();
  renderLog();
});

// Copying beats retyping when several profiles are being compared.
$('copyLog').addEventListener('click', async () => {
  const btn = $('copyLog');
  const head = [
    'Gmail Draft Drip Sender v' + (state.version || '?') + ' - ' + new Date().toLocaleString(),
    'interval ' + state.minMinutes + '-' + state.maxMinutes + 'm | order ' + state.order +
      ' | daily cap ' + state.dailyLimit,
    'checkInbox ' + state.checkInbox + ' | focusTab ' + state.focusTab +
      ' | pacing ' + state.naturalPacing + ' | hours ' + state.activeHours +
      ' | weekends skipped ' + state.skipWeekends,
    'sent today ' + state.sentToday + ' | total ' + state.totalSent +
      ' | skipped ' + state.skipIds.length + ' | bounced ' + (state.bounceCount || 0) +
      ' | gmail tabs ' + state.gmailTabs,
    'running ' + state.running + (state.nextSendAt ? ' | next ' + new Date(state.nextSendAt).toLocaleString() : ''),
    ''
  ].join('\n');
  const body = state.log
    .map((e) => new Date(e.t).toLocaleString() + '  [' + e.level + ']  ' + e.msg)
    .join('\n');
  try {
    await navigator.clipboard.writeText(head + body);
    btn.textContent = 'copied';
  } catch (_) {
    btn.textContent = 'failed';
  }
  setTimeout(() => { btn.textContent = 'copy'; }, 1500);
});

$('clearLog').addEventListener('click', async () => {
  state = await send('CLEAR_LOG');
  renderStatus();
  renderLog();
});

// Storage changes let the popup follow along while a send runs.
chrome.storage.onChanged.addListener(() => refresh(false));

refresh(true);
ticker = setInterval(() => {
  if (state && state.running) renderStatus();
}, 1000);
setInterval(() => refresh(false), 5000);
window.addEventListener('unload', () => clearInterval(ticker));
