import "next-auth";
import "next-auth/jwt";

// How the admin got in. "google" sessions may change the password and the
// admin list; "password" sessions may not.
export type SignInMethod = "google" | "password";

declare module "next-auth" {
  interface Session {
    isAdmin?: boolean;
    method?: SignInMethod;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    isAdmin?: boolean;
    method?: SignInMethod;
  }
}
