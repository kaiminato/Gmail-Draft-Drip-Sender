# Email Watchdog

Admin-only web app that every Gmail Draft Drip Sender extension reports to. Admins sign
in with an allow-listed Google account or with a shared admin password; extensions
authenticate with a shared API key.

## Signing in

Two ways in, both giving full admin access:

- **Google** — only for the addresses on the allow-list. Four are built into
  `src/lib/admins.ts`; `ADMIN_EMAIL` (env) adds one more; the Settings page adds and
  removes further seats without a redeploy.
- **Password** — one shared admin password. Until it is changed it is the temporary value
  in `src/lib/admins.ts` (`DEFAULT_ADMIN_PASSWORD`). **Change it on the Settings page
  right after the first deploy.**

Only a Google-signed-in admin can change the password or the allow-list, so a leaked
password cannot be used to lock the real admins out. Changing the password does not end
sessions that already signed in with the old one; they expire on their own (30 days).

What it shows and does:

- **Accounts** — every extension install, added automatically on its first heartbeat:
  email, manager, the volume tier it is running on with today's progress, status
  (running / stopped / empty / blocked / offline), exact drafts left (rows with fewer
  than 5 are tinted, zero is red), last send, totals, extension version. Tick rows and
  use the floating bar to start them on a tier (**few** 10–20, **less** 20–40, **normal**
  40–70, **many** 70–110 a day) or stop them; with nothing ticked the same buttons act on
  the whole filtered list. Each row also has its own Start ▾ / Switch ▾ and Stop.
- **Managers** — labels you create and assign accounts to. Managers do not log in.
- **Stats** — sends today / this week / this month / all time, blocks, bounces and failed
  cycles, split by manager and by account, plus a 30-day daily chart.
- **Account page** — the same controls plus that account's event log.
- **Alerts** — while the dashboard is open on any page, a toast appears when an account
  goes offline, is blocked, or drops under 5 drafts (and again when it runs out). The
  sidebar's bell turns on desktop notifications for the same events in that browser, so
  they reach you with the dashboard in a background tab. The watcher polls every half
  minute and compares against the last picture it saw; nothing is stored server-side.

## Stack

Next.js (App Router), Tailwind, Drizzle ORM on Neon Postgres, Auth.js with Google.

## Deploy

1. **Database** — create a Neon project (Vercel Marketplace → Neon, or neon.tech). Copy
   the pooled connection string.
2. **Google OAuth** — Google Cloud Console → APIs & Services → Credentials → OAuth client
   ID (Web application). Authorised redirect URI:
   `https://YOUR-APP.vercel.app/api/auth/callback/google`. Add your own Google account as a
   test user if the consent screen is in testing mode.
3. **Vercel** — import this repo, set **Root Directory** to `dashboard`, and add the
   environment variables from [.env.example](.env.example):

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | the Neon connection string |
   | `AUTH_SECRET` | `openssl rand -base64 32` |
   | `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | from the OAuth client |
   | `ADMIN_EMAIL` | optional, one extra Google account allowed in |
   | `EXTENSION_API_KEY` | `openssl rand -hex 32`; same value goes in each extension |
   | `DASHBOARD_TZ` | optional, IANA zone such as `Asia/Seoul`; day/week/month boundaries use it. Default UTC |

4. Deploy. The build applies the SQL migrations in `drizzle/` to `DATABASE_URL` before
   `next build` runs (see [Database migrations](#database-migrations)), so an empty Neon
   database gets its tables on the first deploy and nothing has to be run by hand.

5. Open the site, sign in with one of the admin Google accounts, open **Settings** and
   set a new admin password. Then put the site URL and the API key into each extension's
   `config.local.js` (see `extension/README.md`).

## Database migrations

The schema lives in `src/db/schema.ts`; the database is changed only through the
migration files in `drizzle/`, which `npm run build` applies (via `scripts/migrate.mjs`)
before Next builds. Every deploy therefore carries its own schema change, and a build
whose migration fails stops instead of shipping code the database cannot serve. With no
`DATABASE_URL` the step logs a line and skips, so the build also works without a database.

To change the schema:

1. Edit `src/db/schema.ts`.
2. Generate the migration:

   ```bash
   npx drizzle-kit generate
   ```

   This adds `drizzle/NNNN_<name>.sql` plus a snapshot under `drizzle/meta/`. Read the
   SQL; if drizzle-kit asks whether a column was renamed or created, answer truthfully.
3. Commit the migration together with the schema change, and deploy.

Applied migrations are recorded in the `drizzle.__drizzle_migrations` table, so each one
runs exactly once per database. Never edit a migration that has already been deployed;
add a new one instead. Do not use `drizzle-kit push` against the production database any
more: it bypasses the migration log, and the next deploy would then try to apply changes
that are already there.

The first migration (`0000_init.sql`) is written with `IF NOT EXISTS` guards because the
original database was created with `drizzle-kit push` before migrations existed; it is a
no-op there and creates everything on a fresh database.

## Local development

```bash
cp .env.example .env
# fill in .env, then:
npm install
node scripts/migrate.mjs   # creates or updates the tables in DATABASE_URL
npm run dev
```

For Google sign-in locally add `http://localhost:3000/api/auth/callback/google` as a second
redirect URI on the OAuth client.

## How the extension talks to it

`POST /api/ext/heartbeat` with `Authorization: Bearer <EXTENSION_API_KEY>`, every half
minute per extension and immediately after anything notable. The body carries the
extension's status snapshot (including the tier it runs on and today's plan), any queued
events, and acks for commands it executed. The reply carries a pending `command` if there
is one: `{ id, type: "start", tier }` or `{ id, type: "stop" }`. The dashboard pushes no
settings; the extension is the source of truth for everything it reports. The route
answers CORS preflight so the service worker can call it from an extension origin.

Events are inserted by the id the extension generated, so a batch that is re-sent after
a network failure is a no-op. An account is keyed by the install's device id; when an
extension is removed and installed again it reports under a new id, and once the old
row has been silent for the offline threshold (three minutes) the next heartbeat folds it
into the new one, moving its events and keeping its manager, so the address appears once. Everything on the Stats page is computed from the `events`
table; the counters on the accounts table are what the extension last reported.

Quick check with curl:

```bash
curl -s -X POST https://YOUR-APP.vercel.app/api/ext/heartbeat \
  -H "Authorization: Bearer $EXTENSION_API_KEY" -H "Content-Type: application/json" \
  -d '{"deviceId":"curl-test-0001","email":"test@example.com","running":false,"events":[]}'
```

A `curl-test` account should appear in the table; delete it from its account page.
