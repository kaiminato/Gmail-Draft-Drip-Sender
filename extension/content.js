/* Gmail Draft Drip Sender - content script.
 * Drives the Gmail UI: opens a draft from the Drafts list and clicks Send.
 * Everything here is defensive: Gmail's class names are obfuscated and change,
 * so each lookup has several fallbacks and every wait has a timeout.
 */
(() => {
  // Reloading the extension re-injects this file into a page that still holds
  // the previous copy's globals, while that copy's message listener is already
  // dead. Bailing out on a leftover flag would leave the tab unreachable until
  // someone refreshed it by hand, so hand over instead: drop the old listener
  // if it is still droppable, then register fresh.
  if (typeof window.__GMAIL_DRAFT_DRIP_DISPOSE__ === 'function') {
    try { window.__GMAIL_DRAFT_DRIP_DISPOSE__(); } catch (_) {}
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);

  // Reported on PING so the worker can tell a stale copy from the current one.
  let SCRIPT_VERSION = '?';
  try { SCRIPT_VERSION = chrome.runtime.getManifest().version; } catch (_) {}

  // Set per run from the popup's "natural pacing" switch.
  let human = true;

  // A pause of roughly this length. Humanized, it varies and sometimes drags,
  // the way attention does; otherwise it takes the floor and moves on.
  function pause(minMs, maxMs) {
    if (!human) return sleep(minMs);
    let ms = rand(minMs, maxMs);
    if (Math.random() < 0.2) ms += rand(800, 2600);
    return sleep(ms);
  }

  // Resolves as soon as test() passes, driven by DOM mutations rather than a
  // poll timer. Chrome throttles timers in a tab hidden for a few minutes to
  // roughly once a minute, which made every polled wait blow its deadline on
  // the first sleep. The ceiling is a timer too, but throttling only makes it
  // more generous, never less.
  function waitFor(test, timeout = 15000, minInterval = 250) {
    return new Promise((resolve) => {
      let settled = false;
      let lastRun = 0;
      let trailing = null;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        try { obs.disconnect(); } catch (_) {}
        try { window.removeEventListener('hashchange', onChange); } catch (_) {}
        clearTimeout(ceiling);
        clearTimeout(trailing);
        resolve(v);
      };
      const run = () => {
        lastRun = Date.now();
        let v = null;
        try { v = test(); } catch (_) { v = null; }
        if (v) finish(v);
      };
      // Gmail mutates constantly, so rate-limit the actual test.
      const onChange = () => {
        if (settled) return;
        const since = Date.now() - lastRun;
        if (since >= minInterval) return run();
        if (!trailing) {
          trailing = setTimeout(() => { trailing = null; run(); }, minInterval - since);
        }
      };
      const obs = new MutationObserver(onChange);
      const ceiling = setTimeout(() => finish(null), timeout);
      try {
        obs.observe(document.documentElement, { childList: true, subtree: true });
      } catch (_) {}
      // A hash change alone is not a DOM mutation.
      try { window.addEventListener('hashchange', onChange); } catch (_) {}
      run();
    });
  }

  // offsetParent is null for position:fixed nodes (compose windows), so measure boxes.
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    let st = null;
    try { st = getComputedStyle(el); } catch (_) { return true; }
    if (!st) return true;
    if (st.visibility === 'hidden' || st.display === 'none') return false;
    return Number(st.opacity) !== 0;
  }

  // Gmail renders a dead twin of the Send button right beside the live one:
  // same classes and tooltip, but role="", tabindex="-1", and inline
  // width/height/opacity of 0 with pointer-events:none. Clicking the twin does
  // nothing at all, so the live-vs-dead test is explicit rather than trusting
  // the box size alone to tell them apart.
  function isLiveButton(el) {
    if (!el || !el.isConnected) return false;
    // Attribute tests first: they settle the twin without forcing layout, and
    // this runs across every button on the page several times a second.
    if (el.getAttribute('aria-disabled') === 'true') return false;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) < 0) return false;
    if (!isVisible(el)) return false;
    try { if (getComputedStyle(el).pointerEvents === 'none') return false; } catch (_) {}
    return true;
  }

  function labelOf(el) {
    return (el.getAttribute('data-tooltip') || el.getAttribute('aria-label') || '').trim();
  }

  // Gmail buttons listen on mousedown/mouseup as well as click.
  function realClick(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, view: window, button: 0, buttons: 1,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
    };
    try { el.dispatchEvent(new MouseEvent('mouseover', base)); } catch (_) {}
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
          el.dispatchEvent(new PointerEvent(type, { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' }));
        } else {
          el.dispatchEvent(new MouseEvent(type.replace('pointer', 'mouse'), base));
        }
      } catch (_) {}
    }
    try { el.click(); } catch (_) {}
    return true;
  }

  // Drift the cursor onto the target instead of teleporting onto it, then
  // hesitate briefly before pressing, as a hand would.
  function moveMouseTo(el) {
    const r = el.getBoundingClientRect();
    const tx = r.left + r.width * rand(0.3, 0.7);
    const ty = r.top + r.height * rand(0.3, 0.7);
    for (let i = 3; i >= 0; i--) {
      const x = tx - i * rand(8, 40);
      const y = ty - i * rand(6, 30);
      try {
        (i === 0 ? el : document).dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, cancelable: true, view: window, clientX: x, clientY: y
        }));
      } catch (_) {}
    }
  }

  async function hoverThenClick(el) {
    if (!el) return false;
    if (human) {
      try { moveMouseTo(el); } catch (_) {}
      await sleep(rand(120, 420));
    }
    return realClick(el);
  }

  function scrollableAncestor(el) {
    let n = el;
    while (n && n !== document.body) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
      n = n.parentElement;
    }
    return document.scrollingElement;
  }

  // Sometimes run an eye down the list before picking one.
  async function glanceAtList(row) {
    if (!human || Math.random() > 0.35) return;
    try {
      const cont = scrollableAncestor(row);
      if (!cont) return;
      const from = cont.scrollTop;
      cont.scrollTop = from + rand(60, 260);
      await sleep(rand(350, 1100));
      cont.scrollTop = from;
      await sleep(rand(150, 400));
    } catch (_) {}
  }

  /* ---------- Message lists (drafts, search results) ---------- */

  function listRows() {
    const rows = document.querySelectorAll('div[role="main"] tr.zA');
    return Array.from(rows).filter(isVisible);
  }

  function rowInfo(row) {
    const subjectEl = row.querySelector('.bog') || row.querySelector('.y6 span');
    const subject = (subjectEl && subjectEl.textContent.trim()) || '(no subject)';
    const toEl = row.querySelector('.yW span[email], .yX span[email]');
    const to = (toEl && toEl.getAttribute('email')) ||
      ((row.querySelector('.yW') || {}).textContent || '').trim();
    const idEl = row.querySelector('[data-legacy-thread-id], [data-thread-id]');
    const id = (idEl && (idEl.getAttribute('data-legacy-thread-id') || idEl.getAttribute('data-thread-id'))) ||
      row.id || subject;
    return { subject, to, id };
  }

  function onDraftsView() {
    return /#drafts/i.test(location.hash);
  }

  // A list has settled once rows appear, or Gmail says there are none. The
  // wording is not dependable across locales or Gmail revisions, so callers
  // must not treat a false here as proof the view failed - only as "unconfirmed".
  function listSettled(hashRe) {
    if (!hashRe.test(location.hash)) return false;
    if (listRows().length) return true;
    const main = document.querySelector('div[role="main"]');
    if (!main) return false;
    return /no (conversations|messages|drafts)|any saved drafts|didn't match any|no results|nothing (here|found)/i
      .test(main.textContent || '');
  }

  // Gmail's left nav shows the number of drafts beside "Drafts", and nothing
  // at all when there are none. That badge states "empty" outright in every
  // locale, where the list's own wording cannot be relied on. Returns the
  // number, 0 for no badge, or null when the nav item cannot be read (nav
  // collapsed to icons, markup changed), in which case nothing is concluded.
  const NAV_TRUST_AFTER_MS = 20000;
  function draftsNavCount() {
    // A freshly loaded page shows its nav before the counts arrive, so an
    // empty badge means nothing until the page has been up for a while.
    if (performance.now() < NAV_TRUST_AFTER_MS) return null;
    const nav = document.querySelector('div[role="navigation"]');
    if (!nav) return null;
    const link = nav.querySelector('a[href*="#drafts"]');
    if (!link || !isVisible(link) || link.getBoundingClientRect().width < 40) return null;
    const item = link.closest('.aio') || (link.parentElement && link.parentElement.parentElement);
    if (!item) return null;
    const badge = item.querySelector('.bsU');
    const digits = badge ? (badge.textContent || '').replace(/[^0-9]/g, '') : '';
    if (!digits) return 0;
    const n = parseInt(digits, 10);
    return Number.isFinite(n) ? n : null;
  }

  async function gotoView(hash, hashRe) {
    if (location.hash !== hash) {
      location.hash = hash;
      await pause(450, 1100);
    }
    const ok = await waitFor(() => listSettled(hashRe), 20000, 300);
    // Gmail swaps rows in after the view flips; give it a beat to finish.
    await pause(600, 1700);
    return !!ok;
  }

  const goToDrafts = () => gotoView('#drafts', /#drafts/i);

  /* ---------- Delivery-problem check ---------- */

  // Two tiers. Account-level trouble ("blocked", "sending limit") stops the run;
  // a single undeliverable address is noted and the run carries on. Gmail's own
  // search does the date filtering, which is far steadier than parsing the
  // localised timestamps out of the rows.
  const ALERT_QUERY = 'in:inbox newer_than:1d (from:mailer-daemon OR from:postmaster ' +
    'OR "message blocked" OR "message not delivered" OR "delivery status notification" ' +
    'OR "sending limit" OR "reached a limit" OR "sending quota" OR "quota exceeded" OR "rate limited" ' +
    'OR "unsolicited mail" OR "unusual sending activity" OR "suspicious activity")';

  // Stop everything: Gmail or the receiving server is refusing your mail.
  const CRITICAL_TEXT = new RegExp([
    'message blocked', 'blocked for (spam|abuse)', 'classified as spam',
    'sending limit', 'sending quota', 'quota exceeded', 'rate limit',
    // Gmail's own phrasing when it throttles an account.
    'limit for sending', 'reached a limit', 'daily limit', 'sending rate',
    'too many (messages|emails|recipients)',
    'unsolicited mail', 'unusual (sending )?activity', 'unusual rate',
    'suspicious activity', 'temporarily (blocked|disabled|rate)',
    'account (has been )?(disabled|suspended)'
  ].join('|'), 'i');

  // Worth noting, not worth stopping: one address that did not accept the mail.
  const BOUNCE_TEXT = new RegExp([
    'message not delivered', 'delivery status notification', 'undeliverable',
    'delivery (has )?failed', 'address not found', "couldn't be found",
    'does not exist', 'mailbox (is )?full', 'user unknown', 'no such user'
  ].join('|'), 'i');

  // Keeps a broken query from classifying ordinary mail as either kind.
  const SYSTEM_FROM = /mailer-?daemon|postmaster|mail delivery|no-?reply@accounts\.google/i;

  function rowAlert(row) {
    const info = rowInfo(row);
    const snippetEl = row.querySelector('.y2');
    const snippet = ((snippetEl && snippetEl.textContent) || '').trim();
    return {
      id: info.id,
      subject: info.subject,
      from: info.to,
      snippet: snippet.slice(0, 160),
      text: info.subject + ' ' + snippet
    };
  }

  async function checkForAlerts(ackedIds, seenBounceIds) {
    const acked = new Set(ackedIds || []);
    const seen = new Set(seenBounceIds || []);
    const hash = '#search/' + encodeURIComponent(ALERT_QUERY);
    await gotoView(hash, /#search/i);
    // An empty result is the normal, healthy case and it has no rows and no
    // dependable wording to confirm itself with. So do not demand confirmation:
    // if we reached the search view at all, read it. No rows means all clear.
    if (!/#search/i.test(location.hash)) {
      return { ok: false, code: 'INBOX_TIMEOUT' };
    }

    const critical = [];
    const bounces = [];
    for (const row of listRows()) {
      const a = rowAlert(row);
      // Gmail puts the human-readable reason at the top of the body, which is
      // what the row preview shows, so classify on subject + preview.
      if (CRITICAL_TEXT.test(a.text)) {
        if (!acked.has(a.id)) critical.push(a);
      } else if (SYSTEM_FROM.test(a.from) || BOUNCE_TEXT.test(a.text)) {
        if (!seen.has(a.id)) bounces.push(a);
      }
    }
    return { ok: true, critical, bounces };
  }

  /* ---------- Compose window ---------- */

  function findSendButtons() {
    const seen = new Set();
    const out = [];
    const push = (el) => {
      if (!el || seen.has(el) || !isLiveButton(el)) return;
      seen.add(el);
      out.push(el);
    };
    // Gmail's own marker for the live one.
    document.querySelectorAll('div[role="button"].mt-send').forEach(push);
    // The blue Send button carries a "Send (Ctrl-Enter)" tooltip.
    document.querySelectorAll('div[role="button"], button').forEach((el) => {
      const t = labelOf(el);
      if (/^send\b/i.test(t) && !/schedul|more send/i.test(t)) push(el);
    });
    // Fallback for non-English UIs: Gmail's send button classes.
    document.querySelectorAll('div[role="button"].T-I.aoO, div[role="button"].T-I.J-J5-Ji.aoO.v7').forEach(push);
    // Last resort: a button whose visible text is exactly "Send".
    document.querySelectorAll('div[role="button"].T-I').forEach((el) => {
      if (/^send$/i.test((el.textContent || '').trim())) push(el);
    });
    return out;
  }

  // A compose collapsed to its title bar at the bottom of the page: the
  // dialog and its fields are still in the DOM, only the Send button is not
  // live. Clicking the title bar restores it. True once a Send button is
  // live again; false when there is no such compose or it would not open.
  async function expandMinimisedCompose() {
    const dialog = Array.from(document.querySelectorAll('div[role="dialog"]'))
      .find((d) => d.querySelector('[name="subjectbox"], [name="to"], input[name="subject"]'));
    if (!dialog) return false;
    const bar = dialog.querySelector('.Hy') || dialog.querySelector('[role="heading"]') || dialog.firstElementChild;
    if (!bar) return false;
    try { realClick(bar); } catch (_) { return false; }
    const btn = await waitFor(() => findSendButtons()[0], 4000, 250);
    return !!btn;
  }

  function composeRoot(sendBtn) {
    let el = sendBtn;
    for (let i = 0; i < 15 && el && el !== document.body; i++) {
      if (el.getAttribute && el.getAttribute('role') === 'dialog') return el;
      if (el.querySelector && el.querySelector('[name="to"], [name="subjectbox"], input[name="subject"]')) return el;
      el = el.parentElement;
    }
    return sendBtn.closest('div[role="dialog"]') || sendBtn.parentElement;
  }

  function recipientsOf(root) {
    const set = new Set();
    if (!root) return [];
    root.querySelectorAll('[data-hovercard-id], [email]').forEach((el) => {
      const v = el.getAttribute('data-hovercard-id') || el.getAttribute('email');
      if (v && v.includes('@')) set.add(v);
    });
    root.querySelectorAll('input[name="to"], textarea[name="to"], input[name="cc"], input[name="bcc"]').forEach((i) => {
      String(i.value || '').split(/[,;]/).forEach((s) => {
        s = s.trim();
        if (s.includes('@')) set.add(s);
      });
    });
    return Array.from(set);
  }

  // What to call a compose that was already open when the cycle began. Its
  // Drafts row, matched by subject and recipient, supplies the id that
  // verifySent() looks for; a compose that was never saved has no row.
  function openComposeInfo(root, rows) {
    const subjEl = root && root.querySelector('input[name="subjectbox"], input[name="subject"]');
    const subject = (subjEl && String(subjEl.value || '').trim()) || '(no subject)';
    const to = recipientsOf(root)[0] || '';
    const match = rows.map(rowInfo).find((r) => r.subject === subject && (!to || !r.to || r.to === to));
    return { subject, to, id: match ? match.id : null, leftOpen: true };
  }

  function saveAndClose(root, sendBtn) {
    const scope = root || document;
    let btn = Array.from(scope.querySelectorAll('div[role="button"], button'))
      .find((el) => /save\s*&\s*close|save and close|close/i.test(labelOf(el)) && isVisible(el));
    if (!btn && scope.querySelector) btn = scope.querySelector('img.Ha, div.Ha');
    if (btn) { realClick(btn); return; }
    // Escape saves the draft and closes the compose window.
    const target = (sendBtn && sendBtn.isConnected) ? sendBtn : document.body;
    ['keydown', 'keyup'].forEach((type) => {
      target.dispatchEvent(new KeyboardEvent(type, {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
      }));
    });
  }

  // Chrome throttles setTimeout in a tab that has been hidden a few minutes to
  // roughly once a minute, which is enough to blind a poll loop completely.
  // MutationObserver still fires on the DOM change, so watch rather than poll.
  const SEND_WAIT_MS = 60000;   // ceiling on the last attempt
  const SEND_TRY_MS = 18000;    // how long to give each earlier attempt
  const SEND_ATTEMPTS = 3;

  // Gmail's "Sending..." / "Message sent" snackbar. Used only to hold back a
  // repeat click - never as proof of success, because a snackbar left over from
  // the previous cycle would read exactly the same.
  // Whatever Gmail is complaining about, in its own words. A refused send is
  // reported as an inline banner or a status line, not as a dialog, so nothing
  // upstream of here ever saw it - the run just failed with no explanation.
  const ERROR_RE = /error|couldn.t|could not|cannot|failed|not sent|limit|quota|try again|blocked|too many|unable|suspend/i;

  function gmailErrorText(root) {
    const seen = new Set();
    const bits = [];
    const add = (raw) => {
      const t = String(raw || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 300 || seen.has(t) || !ERROR_RE.test(t)) return;
      seen.add(t);
      bits.push(t);
    };

    // Gmail's own chrome: banners, snackbars and status lines.
    document.querySelectorAll('div[role="alert"], .bAq, .vh, .aT, [class*="error"]').forEach((n) => {
      if (isVisible(n)) add(n.textContent);
    });

    // Inside the compose, but never the draft itself - the body and subject are
    // the user's words, and a line like "limited spots" must not read as a
    // Gmail error and halt the run.
    if (root && root.querySelectorAll) {
      root.querySelectorAll('div, span').forEach((n) => {
        if (!isVisible(n)) return;
        if (n.closest('[contenteditable="true"]')) return;
        if (n.querySelector('[contenteditable="true"], [name="subjectbox"]')) return;
        add(n.textContent);
      });
    }

    return bits.join(' | ').slice(0, 300);
  }

  // Everything Gmail's chrome is saying right now, unfiltered. Used only when
  // the keyword filter came up empty, so a failure is never reported as "no
  // error" merely because the wording was one we did not anticipate.
  function bannerDump() {
    const bits = [];
    document.querySelectorAll('div[role="alert"], .bAq, .vh, .aT, [class*="error"], [class*="Error"]').forEach((n) => {
      if (!isVisible(n)) return;
      const t = String(n.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 200 && bits.indexOf(t) === -1) bits.push(t);
    });
    return bits.join(' | ').slice(0, 300);
  }

  // The few facts that separate the plausible causes: a throttled tab, a
  // refused send, and a selector that stopped matching all look identical in a
  // bare "it failed" line.
  function diagNote(sendBtn) {
    const n = findSendButtons().length;
    return '[tab ' + (document.hidden ? 'hidden' : 'visible') +
      '; ' + n + ' send button' + (n === 1 ? '' : 's') +
      '; clicked button ' + (isLiveButton(sendBtn) ? 'still live' : 'no longer live') +
      '; snackbar ' + (sendToastVisible() ? 'shown' : 'absent') + ']';
  }

  function sendToastVisible() {
    if (document.getElementById('link_undo_send')) return true;
    const nodes = document.querySelectorAll('div[role="alert"], .bAq, .b8.UC');
    for (const n of nodes) {
      if (isVisible(n) && /sending|message sent|undo/i.test(n.textContent || '')) return true;
    }
    return false;
  }

  // Ctrl-Enter is Gmail's own send shortcut, and it goes through a different
  // handler than the button. Worth a try when the button appears to do nothing.
  function sendViaKeyboard(root) {
    const target = (root && root.querySelector &&
      (root.querySelector('div[contenteditable="true"]') || root.querySelector('textarea'))) ||
      root || document.body;
    try { target.focus(); } catch (_) {}
    for (const type of ['keydown', 'keypress', 'keyup']) {
      try {
        target.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          ctrlKey: true, bubbles: true, cancelable: true
        }));
      } catch (_) {}
    }
  }

  // Four ways a compose can be finished with, not just one: removed outright,
  // shrunk to nothing, demoted into the dead-twin state (opacity 0 /
  // pointer-events none / tabindex -1), or its whole container torn down.
  function composeFinished(sendBtn, root) {
    if (!sendBtn || !sendBtn.isConnected) return true;
    if (!isLiveButton(sendBtn)) return true;
    if (root && (!root.isConnected || !isVisible(root))) return true;
    return false;
  }

  function waitForSendOutcome(sendBtn, root, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let lastFull = 0;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        try { obs.disconnect(); } catch (_) {}
        clearTimeout(timer);
        resolve(v);
      };
      const fullCheck = () => {
        if (composeFinished(sendBtn, root)) return finish({ kind: 'gone' });
        const d = visibleDialog(sendBtn);
        if (d) return finish({ kind: 'dialog', dialog: d, text: (d.textContent || '').trim() });
      };
      // Gmail mutates constantly, so only the cheap test runs on every record.
      const onMutate = () => {
        if (!sendBtn.isConnected) return finish({ kind: 'gone' });
        const now = Date.now();
        if (now - lastFull < 250) return;
        lastFull = now;
        fullCheck();
      };
      const obs = new MutationObserver(onMutate);
      const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
      try {
        obs.observe(document.body, {
          childList: true, subtree: true,
          attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden']
        });
      } catch (_) {}
      fullCheck();
    });
  }

  // Did the draft actually go? Gone from the list AND the list got shorter.
  // Both signals, because a draft id could in principle be reissued.
  async function verifySent(id, beforeCount) {
    const settled = await goToDrafts();
    if (!onDraftsView()) return null; // could not tell
    const rows = listRows();
    if (!rows.length && !settled) return null; // list never loaded; do not guess
    const gone = !rows.some((r) => rowInfo(r).id === id);
    return gone && rows.length < beforeCount;
  }

  /* ---------- Modal dialogs Gmail can throw at us ---------- */

  function visibleDialog(excludeEl) {
    const nodes = document.querySelectorAll('div[role="alertdialog"], .Kj-JD, div[role="dialog"]');
    return Array.from(nodes).find((d) => {
      if (!isVisible(d)) return false;
      if (excludeEl && d.contains(excludeEl)) return false;
      if (d.querySelector('[name="to"], [name="subjectbox"]')) return false; // a compose, not a dialog
      return !!d.querySelector('button, div[role="button"]');
    });
  }

  function dialogButton(dialog, names, re) {
    for (const n of names) {
      const b = dialog.querySelector('button[name="' + n + '"]');
      if (b && isVisible(b)) return b;
    }
    return Array.from(dialog.querySelectorAll('button, div[role="button"], [role="button"]'))
      .find((b) => isVisible(b) && re.test((b.textContent || '').trim()));
  }

  /* ---------- The send routine ---------- */

  // The bounce list is gathered before the send but has to come back with the
  // result whichever way the send goes, so it rides in an out-parameter.
  async function sendOneDraft(opts) {
    const extra = {};
    const res = await runSend(opts, extra);
    return { ...res, ...extra };
  }

  async function runSend(opts, extra) {
    const order = opts.order || 'random';
    const skipIds = new Set(opts.skipIds || []);
    human = opts.humanize !== false;

    if (!/^mail\.google\.com$/i.test(location.hostname)) {
      return { ok: false, code: 'NOT_GMAIL', message: 'This tab is not Gmail.' };
    }

    // A compose window that is already open is a draft left unsent: a send
    // that did not take last cycle, or one somebody opened and walked away
    // from. It goes out first; another draft is picked only when there is
    // none. A compose minimised to its title bar is restored first.
    let leftOpen = findSendButtons().length > 0;
    if (!leftOpen) leftOpen = await expandMinimisedCompose();

    const originalHash = location.hash;
    let sendBtn = null;
    let root = null;

    try {
      if (opts.checkInbox) {
        const chk = await checkForAlerts(opts.ackedAlerts, opts.seenBounces);
        if (!chk.ok) {
          // Could not verify the inbox, so do not send blind - retry next cycle.
          return { ok: false, code: 'INBOX_TIMEOUT', message: 'Could not load the inbox check in time.' };
        }
        extra.bounces = chk.bounces;
        if (chk.critical.length) {
          const first = chk.critical[0];
          return {
            ok: false, code: 'BLOCKED', alerts: chk.critical,
            message: 'Gmail is refusing mail: "' + first.subject + '"' +
              (first.from ? ' from ' + first.from : '') +
              (chk.critical.length > 1 ? ' (+' + (chk.critical.length - 1) + ' more)' : '')
          };
        }
      }

      const draftsSettled = await goToDrafts();
      if (!onDraftsView()) {
        return { ok: false, code: 'DRAFTS_TIMEOUT', message: 'Could not switch to the Drafts view.' };
      }

      const all = listRows();
      if (all.length || draftsSettled) {
        emptyByNavStreak = 0;
      } else if (draftsNavCount() === 0) {
        // "Empty" stops the run for good. The list never confirmed it, so
        // the nav's "no drafts" has to be seen on two cycles in a row before
        // it counts; one sighting is retried like any slow load.
        emptyByNavStreak++;
        if (emptyByNavStreak < 2) {
          return { ok: false, code: 'DRAFTS_TIMEOUT', message: 'Drafts list did not finish loading (nav shows no drafts; confirming).' };
        }
      } else {
        emptyByNavStreak = 0;
        return { ok: false, code: 'DRAFTS_TIMEOUT', message: 'Drafts list did not finish loading.' };
      }
      // Looked up again here: the inbox check and the switch to Drafts may
      // have re-rendered the page, or the compose may have closed meanwhile.
      const openBtn = leftOpen ? (findSendButtons()[0] || null) : null;
      if (!all.length && !openBtn) return { ok: false, code: 'NO_DRAFTS', message: 'Drafts folder is empty.', remaining: 0 };

      let info;
      if (openBtn) {
        sendBtn = openBtn;
        root = composeRoot(sendBtn);
        info = openComposeInfo(root, all);
      } else {
        const usable = all.filter((r) => !skipIds.has(rowInfo(r).id));
        if (!usable.length) {
          return {
            ok: false, code: 'ALL_SKIPPED', remaining: remainingAfter(all.length, 0),
            message: 'All ' + all.length + ' remaining draft(s) were skipped as unsendable.'
          };
        }

        // The draft a previous run opened but never got to send (it reported
        // the id before sending, see DRAFT_PICKED) comes first, whatever the
        // order says; it is back in the list as an ordinary row.
        let row = opts.preferId ? usable.find((r) => rowInfo(r).id === opts.preferId) || null : null;
        const retried = !!row;
        if (!row) {
          // Gmail lists drafts newest-first, so the oldest one sits at the bottom.
          if (order === 'newest') row = usable[0];
          else if (order === 'random') row = usable[Math.floor(Math.random() * usable.length)];
          else row = usable[usable.length - 1];
        }

        info = rowInfo(row);
        if (retried) info.retried = true;
        const before = new Set(findSendButtons());

        await glanceAtList(row);

        const openTarget = row.querySelector('.y6') || row.querySelector('.xY.a4W') || row.querySelector('.bog') || row;
        await hoverThenClick(openTarget);

        sendBtn = await waitFor(() => findSendButtons().find((b) => !before.has(b)), 15000, 250);
        if (!sendBtn) {
          return {
            ok: false, code: 'COMPOSE_NOT_OPEN', draft: info,
            message: 'Draft "' + info.subject + '" did not open into a compose window. ' +
              '[tab ' + (document.hidden ? 'hidden' : 'visible') + '; ' +
              findSendButtons().length + ' send buttons on the page; ' +
              listRows().length + ' drafts listed]'
          };
        }

        root = composeRoot(sendBtn);
      }
      // Say which draft this is before touching Send: if the run dies here,
      // the next one starts with this draft instead of another random one.
      try {
        chrome.runtime.sendMessage({ type: 'DRAFT_PICKED', id: String(info.id || ''), subject: String(info.subject || '') }, () => void chrome.runtime.lastError);
      } catch (_) {}

      // Doubles as read-through time and as the beat Gmail needs to hydrate
      // the recipients and body before the send is valid.
      await pause(1400, 4200);

      const recipients = recipientsOf(root);
      const openNote = info.leftOpen ? ' (was left open)' : info.retried ? ' (left unsent last time)' : '';

      // This sender exists for one-to-one mail. A draft addressed to dozens of
      // people is not that, and on a compromised account it is exactly what an
      // intruder plants in Drafts to get a blast sent. It is never sent: it is
      // put back, skipped from now on, and reported.
      const MAX_RECIPIENTS = 10;
      if (recipients.length > MAX_RECIPIENTS) {
        try { saveAndClose(root, sendBtn); } catch (_) {}
        sendBtn = null;
        await sleep(500);
        return {
          ok: false, code: 'TOO_MANY_RECIPIENTS', draft: info, remaining: remainingAfter(all.length, 0),
          recipientCount: recipients.length,
          message: 'Draft "' + info.subject + '" is addressed to ' + recipients.length + ' recipients - not sent, ' +
            'skipped from now on. Check the Drafts folder: a draft like this may have been planted by someone else with access to the account.'
        };
      }

      // Gmail loads its compose module lazily, so the Send button can be in the
      // DOM and look perfectly live while its click handler is not attached
      // yet. That click lands on nothing and the compose simply sits there,
      // which is why a send can fail and then succeed moments later with
      // nothing else changed. So click again rather than waiting it out. Once a
      // send actually takes the compose closes and the loop stops; the snackbar
      // check is what stops a merely-slow send from being clicked twice.
      let attempts = 0;
      let outcome = { kind: 'timeout' };
      for (let i = 1; i <= SEND_ATTEMPTS; i++) {
        if (i > 1 && sendToastVisible()) {
          // Already on its way - wait it out rather than sending a duplicate.
          outcome = await waitForSendOutcome(sendBtn, root, SEND_WAIT_MS);
          break;
        }
        attempts = i;
        await hoverThenClick(sendBtn);
        if (i > 1) sendViaKeyboard(root);
        const budget = i === SEND_ATTEMPTS ? SEND_WAIT_MS : SEND_TRY_MS;
        outcome = await waitForSendOutcome(sendBtn, root, budget);
        if (outcome.kind !== 'timeout') break;
        if (composeFinished(sendBtn, root)) { outcome = { kind: 'gone' }; break; }
      }

      while (outcome.kind === 'dialog') {
        const text = outcome.text;
        if (/without a subject|no subject/i.test(text)) {
          realClick(dialogButton(outcome.dialog, ['ok'], /^(ok|send|yes)$/i));
          outcome = await waitForSendOutcome(sendBtn, root, SEND_WAIT_MS);
          continue;
        }
        if (/recipient/i.test(text)) {
          realClick(dialogButton(outcome.dialog, ['ok', 'cancel'], /^(ok|cancel|close)$/i));
          await sleep(500);
          return {
            ok: false, code: 'NO_RECIPIENT', draft: info, remaining: remainingAfter(all.length, 0),
            message: 'Draft "' + info.subject + '" has no recipient - skipping it from now on.'
          };
        }
        // Something else (quota, attachment warning...). Try OK once, then bail.
        realClick(dialogButton(outcome.dialog, ['ok'], /^(ok|send|yes|continue)$/i));
        await sleep(900);
        if (visibleDialog(sendBtn)) {
          return {
            ok: false, code: 'DIALOG', draft: info,
            message: 'Gmail showed a dialog we could not clear: ' + text.slice(0, 160)
          };
        }
        outcome = await waitForSendOutcome(sendBtn, root, SEND_WAIT_MS);
      }

      if (outcome.kind === 'gone') {
        sendBtn = null; // compose closed => Gmail accepted the send
        return {
          ok: true, code: 'SENT', draft: info,
          recipients, remaining: remainingAfter(all.length, -1),
          message: 'Sent "' + info.subject + '"' + (recipients.length ? ' to ' + recipients.join(', ') : '') + openNote
        };
      }

      // Ran out of patience. Never guess from that alone - a slow tab looks
      // exactly like a failed send. Close the compose and read the Drafts list:
      // if the draft is gone, it went out and we simply out-waited ourselves.
      // Read Gmail's own complaint before closing anything - a refused send is
      // announced inline, and it disappears with the compose.
      const errText = gmailErrorText(root);
      const diag = diagNote(sendBtn);
      const fallback = errText ? '' : bannerDump();
      const who = '"' + info.subject + '"' + (info.to ? ' to ' + info.to : '');
      if (errText && CRITICAL_TEXT.test(errText)) {
        // Gmail itself is refusing, so this is a stop, not a retry.
        try { saveAndClose(root, sendBtn); } catch (_) {}
        sendBtn = null;
        return {
          ok: false, code: 'BLOCKED',
          alerts: [{
            id: 'compose:' + errText.slice(0, 60),
            subject: errText.slice(0, 120),
            from: 'Gmail compose',
            snippet: errText
          }],
          draft: info,
          message: 'Gmail refused to send ' + who + ': ' + errText + ' ' + diag
        };
      }

      try { saveAndClose(root, sendBtn); } catch (_) {}
      sendBtn = null;
      await sleep(1500);
      const sent = await verifySent(info.id, all.length);
      if (sent === true) {
        return {
          ok: true, code: 'SENT', late: true, draft: info,
          recipients, remaining: remainingAfter(all.length, -1),
          message: 'Sent "' + info.subject + '"' + (recipients.length ? ' to ' + recipients.join(', ') : '') + openNote +
            ' (confirmed after the fact, ' + attempts + ' attempt' + (attempts === 1 ? '' : 's') + ')'
        };
      }
      return {
        ok: false, code: 'SEND_TIMEOUT', draft: info,
        message: (sent === false
          ? 'Send did not take after ' + attempts + ' attempts - ' + who + ' is still in Drafts.'
          : 'Clicked Send ' + attempts + ' times on ' + who + ' but could not confirm either way.') +
          (errText ? ' Gmail said: ' + errText
            : fallback ? ' No error matched, but Gmail is showing: ' + fallback
            : ' Gmail showed nothing at all.') +
          ' ' + diag
      };
    } catch (err) {
      return { ok: false, code: 'ERROR', message: String((err && err.message) || err) };
    } finally {
      // Never leave a compose window we opened hanging around.
      if (sendBtn && sendBtn.isConnected) {
        try { saveAndClose(root, sendBtn); } catch (_) {}
        await sleep(500);
      }
      if (opts.restoreView && originalHash && location.hash !== originalHash) {
        try { location.hash = originalHash; } catch (_) {}
      }
    }
  }

  let emptyByNavStreak = 0;

  async function countDrafts(opts) {
    const originalHash = location.hash;
    try {
      const settled = await goToDrafts();
      if (!onDraftsView()) return { ok: false, code: 'DRAFTS_TIMEOUT' };
      const rows = listRows().length;
      const nav = draftsNavCount();
      // The list shows one page; the nav badge counts the whole folder.
      if (rows) return { ok: true, count: typeof nav === 'number' && nav >= rows ? nav : rows };
      if (settled || nav === 0) return { ok: true, count: 0 };
      return { ok: false, code: 'DRAFTS_TIMEOUT' };
    } finally {
      if (opts && opts.restoreView && originalHash && location.hash !== originalHash) {
        try { location.hash = originalHash; } catch (_) {}
      }
    }
  }

  /* ---------- Who is signed in, and is Gmail usable yet ---------- */

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const asEmail = (s) => {
    const v = String(s || '').trim().toLowerCase();
    return EMAIL_RE.test(v) ? v : '';
  };

  // The signed-in address, from the most dependable source that is present.
  // The account button's label reads "Google Account: Name (x@y.com)"; the
  // document title carries the address too and is there before the header.
  function detectAccountEmail() {
    const fromLabel = (el) => {
      const m = /\(([^()\s]+@[^()\s]+)\)/.exec(el.getAttribute('aria-label') || '');
      return m ? asEmail(m[1]) : '';
    };
    for (const sel of ['a[aria-label*="Google Account"]', 'a.gb_B', 'a.gb_d',
      'a[href^="https://accounts.google.com/SignOutOptions"]']) {
      for (const el of document.querySelectorAll(sel)) {
        const e = fromLabel(el);
        if (e) return e;
      }
    }
    const t = /([^\s@()<>]+@[^\s@()<>]+\.[^\s@()<>]+)/.exec(document.title || '');
    if (t && asEmail(t[1])) return asEmail(t[1]);
    for (const el of document.querySelectorAll('[data-email]')) {
      const e = asEmail(el.getAttribute('data-email'));
      if (e) return e;
    }
    for (const el of document.querySelectorAll('div[role="banner"] img[alt*="@"], div[role="banner"] img[aria-label*="@"]')) {
      const m = /([^\s@()]+@[^\s@()]+)/.exec(el.getAttribute('alt') || el.getAttribute('aria-label') || '');
      if (m && asEmail(m[1])) return asEmail(m[1]);
    }
    return '';
  }

  // Gmail's shell reports "complete" long before the mailbox is on screen.
  function isGmailReady() {
    return !!document.querySelector('div[role="main"]') && !!document.querySelector('div[role="navigation"]');
  }

  // Drafts left after a cycle. The list shows one page of the folder (50
  // rows), so counting rows under-reports a big folder and the number then
  // sat wrong on the dashboard until the next full count; the sidebar badge
  // counts the whole folder, so it wins whenever it is there.
  function remainingAfter(listRowsCount, delta) {
    const nav = draftsNavCount();
    const base = typeof nav === 'number' && nav >= listRowsCount ? nav : listRowsCount;
    return Math.max(0, base + delta);
  }

  const onMessage = (msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'PING') { sendResponse({ ok: true, version: SCRIPT_VERSION }); return; }
    if (msg.type === 'GET_ACCOUNT') {
      sendResponse({ ok: true, email: detectAccountEmail(), title: document.title || '' });
      return;
    }
    if (msg.type === 'GMAIL_READY') {
      sendResponse({ ok: true, ready: isGmailReady(), email: detectAccountEmail() });
      return;
    }
    if (msg.type === 'SEND_ONE_DRAFT') {
      sendOneDraft(msg).then(sendResponse).catch((e) =>
        sendResponse({ ok: false, code: 'ERROR', message: String((e && e.message) || e) }));
      return true;
    }
    if (msg.type === 'COUNT_DRAFTS') {
      countDrafts(msg).then(sendResponse).catch((e) =>
        sendResponse({ ok: false, code: 'ERROR', message: String((e && e.message) || e) }));
      return true;
    }
    if (msg.type === 'DRAFTS_BADGE') {
      // The folder's own count from Gmail's sidebar badge, readable from any
      // view without going anywhere; null while the page cannot be trusted.
      sendResponse({ ok: true, count: draftsNavCount() });
      return;
    }
  };

  chrome.runtime.onMessage.addListener(onMessage);
  window.__GMAIL_DRAFT_DRIP_DISPOSE__ = () => {
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch (_) {}
  };

  // Tell the worker who this tab is as soon as the header has rendered. The
  // extension context can be invalidated by a reload mid-wait, hence the guards.
  waitFor(detectAccountEmail, 30000, 500).then((email) => {
    if (!email) return;
    try {
      chrome.runtime.sendMessage({ type: 'ACCOUNT_DETECTED', email }, () => void chrome.runtime.lastError);
    } catch (_) {}
  }).catch(() => {});
})();
