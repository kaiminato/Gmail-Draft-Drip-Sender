import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { isSignedInAdmin } from "@/lib/admin";
import { btnPrimary, Card } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await isSignedInAdmin()) redirect("/");
  const { error } = await searchParams;

  return (
    <div className="mx-auto mt-16 max-w-sm">
      <Card title="Sign in">
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-300">
          This dashboard is private. Sign in with the admin Google account.
        </p>
        {error && (
          <p className="mb-4 rounded-md bg-red-50 p-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {error === "AccessDenied"
              ? "That Google account is not the admin account."
              : "Sign-in failed (" + error + "). Try again."}
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
      </Card>
    </div>
  );
}
