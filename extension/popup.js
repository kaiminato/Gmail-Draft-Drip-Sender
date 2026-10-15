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
  if (h > 0) return h + 'h ' + m + 'm';
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

const TIER_LABEL = { few: 'Few', less: 'Less', normal: 'Normal', many: 'Many' };

function renderStatus() {
  if (!state) return;
  const box = $('status');
  const main = $('statusMain');
  const sub = $('statusSub');
  const planEl = $('statusPlan');

  $('dot').classList.toggle('on', state.running);
  $('stop').hidden = !state.running;

  for (const b of document.querySelectorAll('#tiers .tier')) {
    const t = b.dataset.tier;
    b.classList.toggle('active', state.running && state.tier === t);
    b.classList.toggle('chosen', !state.running && state.tier === t);
    b.title = state.running
      ? (state.tier === t ? 'Running on ' + TIER_LABEL[t] : 'Switch to ' + TIER_LABEL[t] + ' without stopping')
      : 'Start on ' + TIER_LABEL[t];
  }
  $('tierHint').textContent = state.running
    ? 'Running on ' + TIER_LABEL[state.tier] + '. Pick another volume to change it, or Stop.'
    : 'Pick a volume to start. Last used: ' + TIER_LABEL[state.tier] + '.';

  box.classList.remove('running', 'error', 'idle');

  if (state.busy) {
    box.classList.add('running');
    main.textContent = 'Sending…';
    sub.textContent = 'Working in the Gmail tab.';
  } else if (state.running) {
    box.classList.add('running');
    if (state.stopReason === 'daily_cap') {
      main.textContent = 'Done for today';
      sub.textContent = 'Target reached. A new plan is made after midnight' +
        (state.nextSendAt ? ' (' + fmtWhen(state.nextSendAt) + ')' : '') + '.';
    } else {
      const left = state.nextSendAt - Date.now();
      main.textContent = 'Next send in ' + fmtCountdown(left);
      sub.textContent = state.nextSendAt
        ? 'Scheduled for ' + fmtWhen(state.nextSendAt) + (state.lastMessage ? ' · ' + state.lastMessage : '')
        : (state.lastMessage || '');
    }
  } else {
    box.classList.add('idle');
    main.textContent = state.stopReason === 'admin' ? 'Stopped from the dashboard'
      : state.stopReason === 'blocked' ? 'Stopped: blocked'
      : state.stopReason === 'empty' ? 'Stopped: no drafts left'
      : 'Idle';
    sub.textContent = state.lastMessage || 'Pick a volume to start.';
  }

  const plan = state.dayPlan;
  if (plan && plan.dayTarget) {
    planEl.hidden = false;
    planEl.textContent = 'Today: ' + state.sentToday + ' / ' + plan.dayTarget + ' on ' + TIER_LABEL[plan.tier] +
      (plan.times && plan.times.length ? ' · ' + plan.times.length + ' to go' : '') +
      (plan.restStart ? ' · resting ' + plan.restStart + '–' + plan.restEnd : '');
  } else {
    planEl.hidden = true;
  }

  const acct = $('accountPill');
  acct.textContent = state.accountEmail || 'account unknown';
  acct.classList.toggle('bad', !state.accountEmail);

  const srv = $('serverPill');
  srv.classList.remove('ok', 'bad');
  if (!state.serverConfigured) {
    srv.textContent = 'dashboard not set up';
    srv.title = 'Fill in apiBase and apiKey in config.js (or config.local.js).';
    srv.classList.add('bad');
  } else if (state.serverLastError && state.serverLastTryAt > state.serverLastOkAt) {
    srv.textContent = 'dashboard error';
    srv.title = (state.apiHost || '') + ': ' + state.serverLastError;
    srv.classList.add('bad');
  } else if (state.serverLastOkAt) {
    const ago = Math.max(0, Math.round((Date.now() - state.serverLastOkAt) / 1000));
    srv.textContent = 'dashboard ok · ' + (ago < 90 ? ago + 's' : Math.round(ago / 60) + 'm') + ' ago';
    srv.title = state.apiHost || '';
    srv.classList.add('ok');
  } else {
    srv.textContent = 'dashboard: connecting…';
    srv.title = state.apiHost || '';
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

function renderSettings() {
  $('order').value = state.order;
  $('sendFirstImmediately').checked = state.sendFirstImmediately;
  $('restoreView').checked = state.restoreView;
  $('checkInbox').checked = state.checkInbox;
  $('naturalPacing').checked = state.naturalPacing;
  if (state.tiers) {
    for (const b of document.querySelectorAll('#tiers .tier')) {
      const r = state.tiers[b.dataset.tier];
      if (r) b.querySelector('.tier-range').textContent = r[0] + '–' + r[1] + ' / day';
    }
  }
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
      order: $('order').value,
      sendFirstImmediately: $('sendFirstImmediately').checked,
      restoreView: $('restoreView').checked,
      checkInbox: $('checkInbox').checked,
      naturalPacing: $('naturalPacing').checked
    }
  }).then((s) => { state = { ...state, ...s }; renderStatus(); });
}

['order', 'sendFirstImmediately', 'restoreView', 'checkInbox', 'naturalPacing']
  .forEach((id) => $(id).addEventListener('change', pushSettings));

// A tier button starts the run on that tier, or switches tier while running.
for (const b of document.querySelectorAll('#tiers .tier')) {
  b.addEventListener('click', async () => {
    const tier = b.dataset.tier;
    const buttons = document.querySelectorAll('#tiers .tier');
    buttons.forEach((x) => { x.disabled = true; });
    try {
      await pushSettings();
      if (state.running) {
        state = await send('SET_TIER', { tier });
        renderStatus();
        renderLog();
      } else {
        state = await send('START', { tier });
        renderStatus();
        // Starting hands the screen over to Gmail; get out of the way.
        window.close();
        return;
      }
    } finally {
      buttons.forEach((x) => { x.disabled = false; });
    }
  });
}

$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  try {
    state = await send('STOP');
    renderStatus();
    renderLog();
  } finally {
    $('stop').disabled = false;
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
  const plan = state.dayPlan;
  const head = [
    'Gmail Draft Drip Sender v' + (state.version || '?') + ' - ' + new Date().toLocaleString(),
    'account ' + (state.accountEmail || 'unknown') + ' | device ' + (state.deviceId || '?') +
      ' | dashboard ' + (state.apiHost || 'not set') +
      (state.serverLastError ? ' (error: ' + state.serverLastError + ')' : ''),
    'tier ' + state.tier + ' | order ' + state.order + ' | stop reason ' + (state.stopReason || '-') +
      (plan ? ' | plan ' + state.sentToday + '/' + plan.dayTarget + ', ' + (plan.times || []).length + ' to go, rest ' +
        plan.restStart + '-' + plan.restEnd + (plan.compressed ? ' (compressed)' : '') : ' | no plan'),
    'checkInbox ' + state.checkInbox + ' | pacing ' + state.naturalPacing +
      ' | sendFirst ' + state.sendFirstImmediately + ' | restoreView ' + state.restoreView,
    'sent today ' + state.sentToday + ' | total ' + state.totalSent +
      ' | skipped ' + state.skipIds.length + ' | bounced ' + (state.bounceCount || 0) +
      ' | drafts left ' + (typeof state.remainingCount === 'number' ? state.remainingCount : '?') +
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
