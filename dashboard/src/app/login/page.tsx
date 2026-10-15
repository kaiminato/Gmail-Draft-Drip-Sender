import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { currentAdmin } from "@/lib/admin";
import { APP_NAME, BrandMark } from "@/components/Brand";
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
    <div className="mx-auto mt-20 max-w-sm space-y-4">
      <div className="flex items-center justify-center gap-3">
        <BrandMark size={40} />
        <div>
          <div className="text-lg font-semibold tracking-tight">{APP_NAME}</div>
          <div className="text-xs text-muted">Admin sign-in</div>
        </div>
      </div>
      <Card>
        {message && (
          <p className="mb-4 rounded-md bg-danger/10 p-2 text-sm text-danger">{message}</p>
        )}
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button className={btnPrimary + " h-9 w-full justify-center text-sm"}>Continue with Google</button>
        </form>

        <div className="my-4 flex items-center gap-3 text-xs text-muted">
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
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
            className={input + " h-9 w-full"}
          />
          <button className={btn + " h-9 w-full justify-center text-sm"}>Sign in with password</button>
        </form>
      </Card>
      <p className="text-center text-xs text-muted">
        The password can only be changed by an admin signed in with Google.
      </p>
    </div>
  );
}
