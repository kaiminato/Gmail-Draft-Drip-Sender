import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono, Lora } from "next/font/google";
import { auth, signOut } from "@/auth";
import { APP_NAME, BrandMark } from "@/components/Brand";
import { NavLinks } from "@/components/NavLinks";
import { AlertWatcher } from "@/components/AlertWatcher";
import { RESTORE_NAV_SCRIPT, SidebarBehavior } from "@/components/SidebarToggle";
import { ThemeFavicon } from "@/components/ThemeFavicon";
import { themeCss } from "@/lib/themes";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// The serif face a few themes use (Paper and friends).
const lora = Lora({ variable: "--font-lora", subsets: ["latin"] });

// Every theme's rule, generated once per build from the gallery data.
const THEME_CSS = themeCss();

export const metadata: Metadata = {
  title: { default: APP_NAME, template: "%s · " + APP_NAME },
  description: "Status, volume and control for every Gmail Draft Drip Sender install.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const signedIn = session?.isAdmin === true;
  const who = session?.method === "google" ? session.user?.email : "password admin";

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${lora.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/* The theme gallery's rules; the chosen one is matched by data-theme. */}
        <style id="themes" dangerouslySetInnerHTML={{ __html: THEME_CSS }} />
      </head>
      <body className="min-h-full bg-bg text-fg">
        {/* Collapses the sidebar and applies the saved theme before anything is drawn. */}
        <script dangerouslySetInnerHTML={{ __html: RESTORE_NAV_SCRIPT }} />
        <ThemeFavicon />
        {signedIn ? (
          <div className="flex min-h-screen">
            <aside
              className="sidebar sticky top-0 flex h-screen w-14 shrink-0 flex-col border-r border-line bg-panel px-2 py-3 transition-[width,padding] duration-150 md:w-56 md:px-3"
              title="Click to open the menu; click anywhere else to close it"
            >
              <Link href="/" className="mb-5 flex items-center gap-2.5 px-1" title={APP_NAME}>
                <BrandMark size={30} />
                <span className="nav-label hidden text-[15px] font-semibold tracking-tight md:inline">{APP_NAME}</span>
              </Link>
              <NavLinks />
              <SidebarBehavior />
              <div className="mt-auto border-t border-line pt-3">
                <form
                  action={async () => {
                    "use server";
                    await signOut({ redirectTo: "/login" });
                  }}
                  className="flex flex-col gap-2 px-1"
                >
                  <span className="nav-label hidden truncate text-xs text-muted md:block" title={who || ""}>{who}</span>
                  <button className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-panel-2 hover:text-fg" title="Sign out">
                    <span className="nav-icon md:hidden" aria-label="Sign out">⎋</span>
                    <span className="nav-label hidden md:inline">Sign out</span>
                  </button>
                </form>
              </div>
            </aside>
            <main className="min-w-0 flex-1 px-4 py-5 md:px-7">{children}</main>
            <AlertWatcher />
          </div>
        ) : (
          <main className="min-h-screen px-4 py-6">{children}</main>
        )}
      </body>
    </html>
  );
}
