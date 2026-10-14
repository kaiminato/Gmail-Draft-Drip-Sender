import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { auth, signOut, isAdminEmail } from "@/auth";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Draft Drip Dashboard",
  description: "Status and control for every Gmail Draft Drip Sender extension.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const signedIn = !!session && isAdminEmail(session.user?.email);

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
            <div className="flex items-center gap-6">
              <Link href="/" className="font-semibold">Draft Drip</Link>
              {signedIn && (
                <nav className="flex gap-4 text-sm text-zinc-600 dark:text-zinc-300">
                  <Link href="/" className="hover:text-zinc-900 dark:hover:text-white">Accounts</Link>
                  <Link href="/managers" className="hover:text-zinc-900 dark:hover:text-white">Managers</Link>
                  <Link href="/stats" className="hover:text-zinc-900 dark:hover:text-white">Stats</Link>
                </nav>
              )}
            </div>
            {signedIn && (
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/login" });
                }}
                className="flex items-center gap-3 text-sm text-zinc-500"
              >
                <span className="hidden sm:inline">{session?.user?.email}</span>
                <button className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
                  Sign out
                </button>
              </form>
            )}
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
