# Gmail Draft Drip Sender

A Chrome extension that works through the drafts sitting in your Gmail Drafts folder,
sending one at a time with a random gap between each (10–50 minutes by default).

It drives the Gmail tab in this Chrome profile — no OAuth, no Google Cloud project.
Whatever account is signed into that profile's Gmail is the account it sends from.

Every install reports to the central dashboard (see [`../dashboard`](../dashboard)): the
dashboard lists the account, shows its status and counters, and owns the interval and
daily cap. The admin can also start and stop it from there.

## Install

1. Copy `config.js` to `config.local.js` in this folder and fill in the dashboard URL and
   API key (`EXTENSION_API_KEY` on the dashboard). `config.local.js` is gitignored, so the
   key never ends up in the repo. The file looks like this:

   ```js
   self.DRIP_CONFIG = { apiBase: 'https://my-dashboard.vercel.app', apiKey: '…' };
   ```

   A key left out of `config.local.js` keeps the value from `config.js`. That includes
   `timeZone`, the clock every account's day follows (`'Asia/Tokyo'` as shipped): when
   "today" starts, when the nightly rest falls, when the new plan is made, and the times
   the popup shows. Machines in different countries therefore roll over together.

   If the dashboard is on a custom domain rather than `*.vercel.app`, also add that
   origin to `host_permissions` in `manifest.json`.
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and pick this folder
5. Pin the blue envelope icon to your toolbar

Within a minute the popup header should read **dashboard ok** and show the signed-in
address, and the account appears on the dashboard on its own.

## Use

1. Make sure this Chrome profile is signed in to Gmail. A Gmail tab does not have to be
   open: the extension opens one if it needs to.
2. Click the extension icon and press **Start** (or press Start on the dashboard). The
   popup closes.

When it is time to send, the extension brings Gmail to the front — whatever you were
looking at, in whichever window, even minimised — opening a Gmail tab if there is none,
and waits until the mailbox is fully loaded before touching anything. Each cycle switches
to Drafts, opens one draft, clicks Send, and (by default) puts the view back where you had
it. Then it waits a random amount of time inside the interval and does it again.

It stops on its own when the Drafts folder is empty.

## Volume and settings

There is no interval to set. You choose a **volume tier** and the extension plans each
day around it:

| Tier | Sends per day |
| --- | --- |
| **Few** | 10–20 |
| **Less** | 20–40 |
| **Normal** | 40–70 |
| **Many** | 70–110 |

The four tier buttons in the popup start the run on that tier; while running, pressing
another tier switches to it without stopping. The dashboard has the same four buttons
per account and for many accounts at once. Whichever side pressed last wins, and the
dashboard always shows the tier an account is actually running.

Everything else is local to the popup:

| Setting | What it does |
| --- | --- |
| **Pick draft** | Random (default), oldest first, or newest first. |
| **Check inbox for blocks before each send** | Scans the inbox before every send and stops the run if Gmail is blocking or limiting you. Ordinary bounces are logged instead. On by default. See below. |
| **Send one right away on start** | Fires the first draft immediately instead of waiting for the first planned time. |
| **Return Gmail to the view I was on** | Restores your previous Gmail view after each send. |
| **Natural pacing and dwell time** | Triangular gaps inside a session, in-page dwell, cursor drift. On by default. |

**Send one now** runs a single send immediately, which is the fastest way to confirm it
works before leaving it running.

## The dashboard link

- **Heartbeat.** Every half minute, and straight after anything notable, the extension
  posts its status to the dashboard: account email, running or not and why it stopped,
  the tier, today's plan (target, sends left, rest window), last send time, exactly how
  many drafts are left as of the last cycle, today's and total counts, bounces. The reply
  carries any start (with a tier) or stop command the admin queued, which is executed
  and acknowledged.
- **Events.** Every send, failure, bounce, block, start and stop is queued locally and
  delivered with the next heartbeat; the dashboard's statistics are built from these.
  The queue survives the worker being torn down and the dashboard being unreachable, and
  each event carries its own id so nothing is counted twice.
- **Which account.** The signed-in address is read off the Gmail page (the account
  button's label, or the tab title). Until it has been read the dashboard shows the
  install as *unknown* with its device id; that resolves on the first cycle, or sooner if
  a Gmail tab is open.
- **If the dashboard is down**, sending carries on with the last-known settings, the popup
  header shows *dashboard error* with the reason on hover, and queued events are delivered
  when it comes back.
- **Local Start/Stop still works.** The dashboard always shows the real state; a command
  from the dashboard takes effect on the next heartbeat, within about a minute.

The **copy** button's log header includes the account, device id and dashboard host, so a
pasted log says which install it came from.

## Humanizing: the day plan

A fixed cadence is the giveaway: a message every 20 minutes on the dot, around the clock,
is not a person working through a list. So each day is planned to look like one
(`planner.js`):

- **A daily count** drawn from the tier's range. It is fixed for the day, so a restart
  mid-day only plans what is still owed.
- **A night's rest** of six hours, starting somewhere between 22:30 and 01:30. The start
  minute is fixed per account (derived from the install id) and drifts up to 45 minutes
  each day, so fifty accounts do not all go quiet at the same minute, and none of them
  sends at 4am. Clock times, and "today" itself, follow the `timeZone` in `config.js`
  rather than the machine's own clock.
- **The target is a ceiling.** A "Send one now" or the immediate first send on Start
  counts toward it: the plan drops a time from its end so sent plus planned never exceeds
  the day's target.
- **The new day starts at once.** Just after midnight on the configured clock the next
  heartbeat makes the day's plan, so the dashboard shows the new target within a minute
  rather than after the re-plan alarm.
- **Two to six sessions** across the awake hours, each holding a share of the count,
  placed at random with at least 45 quiet minutes between them.
- **Short gaps inside a session**, 4–12 minutes, drawn from a triangular spread. If the
  count will not fit in the awake time, the gaps are compressed and the log says so.
- **Staggered starts.** A start from the dashboard waits a random 0–20 minutes first,
  so "Start all" on fifty accounts does not open fifty Gmail tabs at once.

The popup's status line shows today's plan ("23 / 56 today · resting 23:40–05:40") and
the activity log records each day's plan when it is made. After the last planned send
the run holds until a new plan is made just after midnight.

Natural pacing also pauses to read each draft for 1.4–4.2 s before sending, drifts the
cursor onto buttons instead of teleporting onto them, and now and then scrolls the list
before picking. The dwell time is not purely cosmetic — it doubles as the beat Gmail
needs to hydrate a draft's recipients and body before a send will take.

### What this does not do

It does not alter your draft text: no invisible characters, no spun phrasing, no
auto-generated variations. Two reasons. Mutating the body would send wording you never
reviewed out under your name, and content mangling aimed at spam classifiers is the one
technique here that is squarely a spammer's tool rather than a sender's.

If you want the messages to differ, write them differently in the drafts themselves. That
is also what actually works: near-identical bodies sent to a large list is the pattern
that draws attention, and a swapped synonym does not change that.

### What actually drives deliverability

Worth being blunt, because pacing is the smaller half of the problem. What mostly
determines whether Gmail trusts your mail: total volume, bounce rate (invalid addresses
hurt quickly), how many recipients reply versus mark it as spam, whether your domain has
SPF/DKIM/DMARC configured, and whether the recipients asked to hear from you. Sending
through the Gmail web UI as yourself already looks like ordinary Gmail use; in bulk
outreach the risk is volume and recipient reaction far more than the automation. Keep
lists clean and small, and prefer the daily cap over a long unattended run.

## The delivery-problem check

Before each send — not after — it searches your inbox for signs that Gmail or a
recipient's server has pushed back. Catching the first block matters more than catching
the tenth.

It sorts what it finds into two tiers.

**Stops the run.** Your account is in trouble and sending more makes it worse:

> message blocked · blocked for spam/abuse · classified as spam · sending limit ·
> sending quota · quota exceeded · rate limited · unsolicited mail · unusual sending
> activity · suspicious activity · temporarily blocked or disabled · account suspended

**Logged, run continues.** One address that did not accept the mail is not a reason to
halt everything:

> message not delivered · delivery status notification · undeliverable · delivery failed ·
> address not found · mailbox full · user unknown

Each bounce is logged once, and the popup keeps a running **bounced** count. Watch that
number: a handful is normal, a climbing one means the list needs cleaning, and bounce rate
is what actually damages sender reputation.

### How it tells them apart

The subject line will not do it — Gmail titles almost every bounce "Message not
delivered", whether the address was wrong or your mail was blocked. The real reason sits
at the top of the message body, which is exactly what the row preview shows, so the two
tiers are matched against subject **and** preview text together.

The search that gathers candidate rows is `in:inbox newer_than:1d` plus bounce senders
(`mailer-daemon`, `postmaster`) and the phrases above. Letting Gmail's own search do the
date filtering is far steadier than parsing localised timestamps out of the rows, and
because Gmail searches full bodies, a block notice surfaces even when its preview is
truncated. Rows are then re-matched inside the extension, so if Google ever changes its
search syntax and the query starts returning the whole inbox, ordinary mail is still
ignored.

The one gap: if a block notice's reason appears *only* deep in the body and never in the
preview, it is logged as an ordinary bounce rather than stopping the run. In practice
Gmail leads with the reason, but the daily cap is still your real backstop.

### When it stops

1. Sending stops. Not paused — stopped.
2. A desktop notification fires and the popup shows a red banner naming the message.
3. The activity log records what tripped it.

**Pressing Start again acknowledges those alerts and continues.** Their ids are remembered
so the same notice cannot stop you twice; a genuinely new one still will. You do not have
to delete or read the offending mail.

If the inbox check itself cannot load, the cycle does not send — it retries in a minute
rather than firing blind. Turn the checkbox off and none of this runs.

## Background tabs and throttling

Chrome slows down tabs you have not looked at for a few minutes: `setTimeout` chains in a
long-hidden page fire roughly **once a minute** instead of on schedule. Gmail's own code
slows down too, so a send that normally completes in two seconds can take much longer.

This bit the extension hard in an early version. It polled for the compose window closing
on a 400ms timer with a 25-second deadline; in a throttled tab the poll resumed a minute
later, well past the deadline, and every send after the first was reported as failed —
while Gmail was in fact still sending them. Five "failures" in a row then tripped the
auto-stop.

Three things now prevent that:

- **Every wait watches the DOM instead of polling it.** `waitFor` and the send detection
  both run on a `MutationObserver`, which fires on the actual change regardless of timer
  throttling. The ceilings are still timers, but throttling only makes a ceiling more
  generous, never less. Under a simulated 60-second timer grid a wait that should take
  500ms still resolves in about 500ms; the old poll loop returned "timed out" instead.
- **A timeout is verified, never assumed.** If the ceiling is reached, the compose is
  closed and the Drafts list is re-read. If the draft is gone *and* the list is shorter,
  the message did go out and it is logged as sent (flagged as confirmed late). Only if the
  draft is still sitting in Drafts is it recorded as a real failure.
- **An empty list is never mistaken for a failed one.** Confirming that a list finished
  loading relies on Gmail's own wording ("No messages matched your search"), which is not
  dependable across locales or Gmail revisions — and an empty result has no rows to prove
  itself with either. So the inbox check no longer demands confirmation: reaching the
  search view is enough, and no rows means all clear. The Drafts list is treated more
  carefully in the other direction, because "empty" stops the run for good: an unconfirmed
  empty Drafts list is reported as a transient timeout and retried, never as "all done".

Those fixes make a throttled tab *correct*, but not fast: the cosmetic dwell between steps
is still made of timers, so a cycle in a long-hidden tab can take several minutes of
wall clock even when everything works.

That is why the extension makes the Gmail tab active for each send and, only if the page
still reports itself hidden after that, brings its window to the front (un-minimising it
if needed). An active tab in a visible window is not throttled, which removes this whole
class of problem rather than working around it. A Gmail window that is already on screen
is never touched, so keeping Gmail in its own window makes sending invisible.

### Profiles on other virtual desktops

Chrome treats a window on another virtual desktop as hidden. Left alone, a profile parked
on desktop 3 is therefore pulled onto whichever desktop you are working on for every send,
and its taskbar button flashes. To keep those windows where they are, start Chrome for
those profiles with occlusion tracking off:

```
chrome.exe --profile-directory="Profile 3" --disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion
```

With those switches a window on another desktop, or behind other windows, still counts
as visible: the page reports itself visible, and the extension never focuses the window.
Two things to know:

- The switches only take effect when Chrome starts fresh for that profile. Close every
  window of the profile first, then launch it through a shortcut carrying them. The
  profile directory name is shown on `chrome://version` as "Profile Path".
- A minimised window is hidden whatever the switches, so leave those windows restored
  (behind other windows is fine).

## Diagnosing a failure

A failure line carries enough to tell the likely causes apart without guessing:

```
Send did not take after 3 attempts - "Let's Collaborate" to matlat@yahoo.com is still
in Drafts. Gmail said: You have reached a limit for sending mail.
[tab hidden; 1 send button; clicked button still live; snackbar absent]
```

- **Which draft**, by subject and recipient. With random order each retry picks a
  different draft, so "the same draft keeps failing" and "every draft fails" are entirely
  different problems — and indistinguishable without this.
- **What Gmail said**, verbatim. If nothing matched the error vocabulary it falls back to
  dumping whatever Gmail's banners currently read, so an unfamiliar wording still shows up
  rather than being reported as "no error".
- **The state snapshot.** `tab hidden` points at throttling; `clicked button still live`
  means the click never took effect; `0 send buttons` means the selectors stopped matching;
  `snackbar shown` means the send was actually under way.

**copy** next to the Activity heading puts the whole log on the clipboard with a header
giving the version, every setting, and the counters — which is what to send along when
comparing several profiles.

## When Gmail itself refuses

A refused send is announced as an inline banner or status line, not as a dialog — so
nothing used to read it, and the run just failed with no explanation. Gmail's error text is
now scraped after a failed send and reported in the log verbatim, after "Gmail said:".

If that text matches the critical list (limit for sending, reached a limit, sending quota,
too many messages, message blocked, and so on) the run **stops immediately** rather than
retrying every minute — the same treatment an inbox block notice gets, and the popup shows
the same red banner.

The scrape deliberately skips the draft's own subject and body. A perfectly ordinary line
like "limited spots available" or "our calendar is blocked out" must never read as a Gmail
error and halt the run; that exclusion is covered by tests.

**A send that fails repeatedly while the draft stays in Drafts is Gmail saying no, not a
detection bug.** The quickest confirmation is to open that draft and press Send yourself.
If it fails by hand too, the account has hit a limit or a block, and no amount of retrying
in here will change that — rest the account rather than hammering it.

## Why a send could fail and then work seconds later

Gmail loads its compose module lazily. Straight after a page load or a long idle, the Send
button can be in the DOM, sized, focusable and looking entirely live — while its click
handler has not been attached yet. The click lands on nothing, the compose just sits there,
and the attempt times out. Try again a moment later and it works, with nothing else having
changed. That is the "sometimes it works" pattern.

So the click is no longer a single shot. Each send gets up to **three attempts**: click,
wait 18 seconds, and if the compose is still open and still live, click again. From the
second attempt it also sends Ctrl-Enter, which reaches Gmail through a different handler
than the button.

The guard against this becoming duplicate mail is Gmail's own snackbar. Before any repeat
click it checks for the "Sending..." / "Message sent" / "Undo" strip; if one is showing,
the send is already on its way and it waits instead of clicking again. That is verified in
the tests: a send that takes 22 seconds to close its compose is clicked exactly once.

## Which build am I running?

The log stamps the version on every start — `Started v1.1.0. Interval 10-30 minutes...`.
If that number does not match `manifest.json`, the tab is running old code.

Reloading at `chrome://extensions` updates the service worker, but the content script
already injected into an open Gmail tab is *not* replaced until that tab reloads. Earlier
versions made this worse: a leftover `window` flag caused re-injection to bail out, so the
tab could stay on dead code indefinitely. Injection now hands over cleanly — it drops the
previous listener and registers a fresh one — but refreshing the Gmail tab after an
extension reload is still the reliable move.

## How it behaves

- **Drafts with no recipient** are skipped and remembered, so it doesn't jam on them. The
  count shows in the popup; **Clear skips** makes it retry them.
- **A compose window you opened yourself** pauses the sender — it will not touch your
  window or fight you for focus. It retries every minute until you close it.
- **Drafts with no subject** are sent; the "send without a subject?" prompt is confirmed.
- **Sends confirmed late** appear in amber rather than green, worded "confirmed after the
  fact". That means the tab was slow, not that anything went wrong.
- **Transient problems** (Gmail tab closed, page still loading, a draft that would not
  open) are retried once a minute for as long as the run is on; a failure never stops it.
  Every fifth failure in a row posts a notification, the log shows the running count, and
  the dashboard shows it too. Only a Gmail block, an empty Drafts folder, or Stop ends a run.
- **Nothing is ever deleted.** If a send can't be completed the draft is saved and closed,
  never discarded.
- **An empty Drafts folder is recognised from the left nav**, which shows a number beside
  "Drafts" while any exist and nothing when there are none, in every locale. The list's
  own "you don't have any saved drafts" wording is used too, but the badge is what makes
  the empty folder certain, so the run stops with "Empty" instead of retrying a list that
  "did not finish loading" every minute, and the drafts-left count reads 0. The badge is
  not trusted on a page open for less than 20 seconds (the counts arrive after the nav),
  a run stops on it only when two cycles in a row read it, and a 0 on a running account
  is re-counted every few minutes until a send confirms it. The folder is also re-counted
  every ten minutes on a stopped account and every half hour on a running one, so the
  dashboard's figure follows drafts you add without waiting for a send.
- **An extension update or a browser restart does not end a run.** Chrome clears every
  alarm when an extension updates, which once left running accounts sitting idle with
  nothing armed and "next any moment" on the dashboard. The extension now re-plans and
  carries on after an update or restart, and every heartbeat re-arms a schedule that went
  missing for any other reason. The dashboard flags a send that is more than half an hour
  overdue in amber.

## Things worth knowing

- **Chrome must stay open and signed in.** A closed Gmail tab is reopened; a discarded
  one is reloaded. But if the profile is signed out, the new tab lands on the Google
  sign-in page, and that is reported as a failure (`NOT_SIGNED_IN`) until someone signs in.
- **You'll see Gmail come to the front** and flick to Drafts for a few seconds during
  each send. That's the automation working — it's driving the real UI, the same as
  clicking yourself.
- **Gmail's sending limits still apply** (roughly 500 messages/day on a personal account,
  2000 on Workspace). Even the "many" tier stays far under them; the risk is reputation,
  not the hard limit.
- **Holds are visible.** While it waits out a night or a weekend the popup shows the
  countdown in hours and the activity log says why.
- **Gmail's HTML is obfuscated and changes.** Selectors have fallbacks, but if Google
  reshapes compose, `content.js` is the file to adjust — `findSendButtons()` and
  `listRows()` are where the brittleness lives.
- **Gmail renders a dead twin of the Send button.** Right beside the live one sits a node
  with the same classes and the same "Send (Ctrl-Enter)" tooltip, but `role=""`,
  `tabindex="-1"`, and inline `opacity:0; pointer-events:none; width:0; height:0`.
  Clicking it does nothing at all. `isLiveButton()` is what tells them apart, and
  `composeFinished()` treats a button demoted *into* that state as a closed compose —
  four ways a compose can end (removed, zero-sized, demoted, or container torn down)
  rather than just one.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `config.js` | Dashboard URL and API key placeholders; override in gitignored `config.local.js` |
| `planner.js` | The day planner: tiers, rest block, sessions, gaps. Pure functions; `node extension/test/planner.test.js` checks them |
| `background.js` | Service worker: follows the plan, retries, counters, log, heartbeat and event queue, dashboard commands, bringing Gmail to the front |
| `content.js` | Runs inside Gmail: checks the inbox, finds a draft, opens it, clicks Send; reads the signed-in address |
| `popup.html` / `.css` / `.js` | The Start/Stop panel |
