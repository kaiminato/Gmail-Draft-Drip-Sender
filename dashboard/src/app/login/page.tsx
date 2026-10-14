import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { currentAdmin } from "@/lib/admin";
import { btn, btnPrimary, Card, input } from "@/components/ui";

export const dynamic = "force-dynamic";

function errorText(code: string | undefined): string | null {
  switch (code) {
    case undefined:
    case "":
      return null;
    case "AccessDenied":
      return "That Google account is not on the admin list.";
    case "CredentialsSignin":
      return "Wrong password.";
    default:
      return "Sign-in failed (" + code + "). Try again.";
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentAdmin()) redirect("/");
  const { error } = await searchParams;
  const message = errorText(error);

  return (
    <div className="mx-auto mt-16 max-w-sm space-y-4">
      <Card title="Sign in">
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-300">
          This dashboard is private. Use an admin Google account, or the admin password.
        </p>
        {message && (
          <p className="mb-4 rounded-md bg-red-50 p-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {message}
          </p>
        )}
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button className={btnPrimary + " w-full justify-center py-2 text-sm"}>Continue with Google</button>
        </form>

        <div className="my-4 flex items-center gap-3 text-xs text-zinc-400">
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          or
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        </div>

        <form
          action={async (form: FormData) => {
            "use server";
            const password = form.get("password");
            await signIn("password", {
              password: typeof password === "string" ? password : "",
              redirectTo: "/",
            });
          }}
          className="space-y-2"
        >
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="Admin password"
            required
            className={input + " w-full"}
          />
          <button className={btn + " w-full justify-center py-2 text-sm"}>Sign in with password</button>
        </form>
      </Card>
      <p className="text-center text-xs text-zinc-500">
        The password can only be changed by an admin signed in with Google.
      </p>
    </div>
  );
}
