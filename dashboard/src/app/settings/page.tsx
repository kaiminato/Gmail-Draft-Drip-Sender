import { requireAdmin } from "@/lib/admin";
import { BUILTIN_ADMIN_EMAILS, extraAdminEmails, norm, passwordIsDefault } from "@/lib/admins";
import { btn, btnDanger, btnPrimary, Card, input, PageHeader, td, th } from "@/components/ui";
import { DesktopAlertsSetting } from "@/components/AlertWatcher";
import { addAdmin, changePassword, removeAdmin } from "./actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; denied?: string }>;
}) {
  const me = await requireAdmin();
  const { error, ok, denied } = await searchParams;
  const canEdit = me.method === "google";
  const [extras, usingDefault] = await Promise.all([extraAdminEmails(), passwordIsDefault()]);

  const envAdmin = norm(process.env.ADMIN_EMAIL);
  const builtins = [...BUILTIN_ADMIN_EMAILS, ...(envAdmin && !BUILTIN_ADMIN_EMAILS.includes(envAdmin) ? [envAdmin] : [])];

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader
        title="Settings"
        description={"Signed in " + (me.method === "google" ? "with Google as " + me.email : "with the admin password") + "."}
      />

      {!canEdit && (
        <p className="rounded-md bg-warn/10 p-3 text-sm text-warn">
          {denied ? "That change needs a Google sign-in. " : ""}
          Changing the password or the admin list requires signing in with one of the admin Google accounts.
        </p>
      )}
      {ok === "password" && (
        <p className="rounded-md bg-accent/10 p-3 text-sm text-accent">
          Password updated. Sessions that signed in with the old password stay signed in until they expire.
        </p>
      )}
      {error && (
        <p className="rounded-md bg-danger/10 p-3 text-sm text-danger">{error}</p>
      )}

      <Card title="Notifications">
        <DesktopAlertsSetting />
      </Card>

      <Card title="Admin password">
        {usingDefault && (
          <p className="mb-3 rounded-md bg-warn/10 p-2 text-xs text-warn">
            The temporary password from the setup is still in use. Set a new one.
          </p>
        )}
        <form action={changePassword} className="space-y-2">
          <input name="password" type="password" autoComplete="new-password" placeholder="New password" required minLength={8} disabled={!canEdit} className={input + " w-full"} />
          <input name="confirm" type="password" autoComplete="new-password" placeholder="Repeat it" required minLength={8} disabled={!canEdit} className={input + " w-full"} />
          <button className={btnPrimary} disabled={!canEdit}>Change password</button>
        </form>
        <p className="mt-2 text-xs text-muted">One shared password, at least 8 characters. Whoever has it gets the same access as a Google admin, except for this page.</p>
      </Card>

      <Card title="Google accounts allowed to sign in">
        <table className="w-full border-collapse">
          <thead className="border-b border-line">
            <tr>
              <th className={th}>Email</th>
              <th className={th}>Added</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {builtins.map((e) => (
              <tr key={e} className="border-b border-line/60 last:border-0">
                <td className={td}>{e}</td>
                <td className={td + " text-xs text-muted"}>built in</td>
                <td className={td}></td>
              </tr>
            ))}
            {extras.map((r) => (
              <tr key={r.email} className="border-b border-line/60 last:border-0">
                <td className={td}>{r.email}</td>
                <td className={td + " text-xs text-muted"}>{r.addedBy ? "by " + r.addedBy : "from settings"}</td>
                <td className={td + " text-right"}>
                  <form action={removeAdmin}>
                    <input type="hidden" name="email" value={r.email} />
                    <button className={btnDanger} disabled={!canEdit}>Remove</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={addAdmin} className="mt-3 flex gap-2">
          <input name="email" type="email" placeholder="another.admin@gmail.com" required disabled={!canEdit} className={input + " flex-1"} />
          <button className={btn} disabled={!canEdit}>Add</button>
        </form>
        <p className="mt-2 text-xs text-muted">
          Built-in addresses are fixed in the code (and ADMIN_EMAIL, if set). Addresses added here can be removed again.
        </p>
      </Card>
    </div>
  );
}
