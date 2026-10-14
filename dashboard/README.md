# Draft Drip Dashboard

Admin-only web app that every Gmail Draft Drip Sender extension reports to. One person
signs in (with Google); extensions authenticate with a shared API key.

What it shows and does:

- **Accounts** — every extension install, added automatically on its first heartbeat:
  email, manager, status (running / stopped / empty / blocked / offline), last send,
  drafts left (None / 1~10 / 10+), today and total sent, interval, daily cap. Start or stop
  each one, set its interval and cap, assign it to a manager, or do any of that for every
  account under a manager at once.
- **Managers** — labels you create and assign accounts to. Managers do not log in.
- **Stats** — sends today / this week / this month / all time, blocks, bounces and failed
  cycles, split by manager and by account, plus a 30-day daily chart.
- **Account page** — the same controls plus that account's event log.

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
   | `ADMIN_EMAIL` | the only Google account allowed in |
   | `EXTENSION_API_KEY` | `openssl rand -hex 32`; same value goes in each extension |
   | `DASHBOARD_TZ` | optional, IANA zone such as `Asia/Seoul`; day/week/month boundaries use it. Default UTC |

4. **Create the tables** — from this folder, with `DATABASE_URL` in a local `.env`:

   ```bash
   npm install
   npx drizzle-kit push
   ```

   `drizzle-kit push` applies the schema in `src/db/schema.ts` directly. Run it again after
   any schema change.

5. Deploy. Open the site, sign in with the admin account. Then put the site URL and the API
   key into each extension's `config.local.js` (see `extension/README.md`).

## Local development

```bash
cp .env.example .env
# fill in .env, then:
npm install
npx drizzle-kit push
npm run dev
```

For Google sign-in locally add `http://localhost:3000/api/auth/callback/google` as a second
redirect URI on the OAuth client.

## How the extension talks to it

`POST /api/ext/heartbeat` with `Authorization: Bearer <EXTENSION_API_KEY>`, once a minute
per extension and immediately after anything notable. The body carries the extension's
status snapshot, any queued events, and acks for commands it executed. The reply carries
the settings the dashboard owns (`desired`) and a pending `command` (start/stop) if there
is one. The route answers CORS preflight so the service worker can call it from an
extension origin.

Events are inserted by the id the extension generated, so a batch that is re-sent after
a network failure is a no-op. Everything on the Stats page is computed from the `events`
table; the counters on the accounts table are what the extension last reported.

Quick check with curl:

```bash
curl -s -X POST https://YOUR-APP.vercel.app/api/ext/heartbeat \
  -H "Authorization: Bearer $EXTENSION_API_KEY" -H "Content-Type: application/json" \
  -d '{"deviceId":"curl-test-0001","email":"test@example.com","running":false,"events":[]}'
```

A `curl-test` account should appear in the table; delete it from its account page.
