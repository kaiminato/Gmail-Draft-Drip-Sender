# Gmail Draft Drip Sender

Two parts in one repository:

| Folder | What it is |
| --- | --- |
| [`extension/`](extension/) | The Chrome extension. Runs in each Chrome profile, sends the drafts in that profile's Gmail one at a time, and reports to the dashboard. |
| [`dashboard/`](dashboard/) | **Email Watchdog**, the admin dashboard, a Next.js app deployed on Vercel. Shows every account's status and volume tier, groups accounts under managers, aggregates statistics, and starts/stops accounts on a chosen tier, singly or in bulk. |

Start with [`dashboard/README.md`](dashboard/README.md) to deploy the dashboard, then
[`extension/README.md`](extension/README.md) to point the extension at it.
