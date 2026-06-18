/**
 * Better Auth — email/password + magic link + (optional) OAuth.
 *
 * The drizzle adapter writes into the schema in apps/api/src/db/schema.ts
 * (users/sessions/accounts/verifications tables match Better Auth's
 * expected shape).
 *
 * Email sending wires through Resend in production. In tests we inject
 * a no-op handler so signup/verify flows work without a network.
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";

import type { DB } from "../db/client.js";
import * as schema from "../db/schema.js";
import { sendVerificationEmail, sendMagicLinkEmail, type EmailSender } from "../services/email.js";

export interface BuildAuthOpts {
  readonly db: DB;
  readonly secret: string;                     // SESSION_COOKIE_SECRET
  readonly apiUrl: string;                     // PUBLIC_API_URL — where Better Auth endpoints live (verify/magic-link URLs in emails point here)
  readonly appUrl: string;                     // PUBLIC_APP_URL — UI origin for post-auth redirects
  readonly email: EmailSender;
  readonly trustedOrigins?: readonly string[];
}

export function buildAuth(opts: BuildAuthOpts) {
  return betterAuth({
    appName: "Daemora",
    baseURL: opts.apiUrl,
    basePath: "/api/auth",
    secret: opts.secret,

    database: drizzleAdapter(opts.db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: false,                      // user must verify email first
    },

    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,                // 24 hours
      sendVerificationEmail: async ({ user, url }) => {
        // Better Auth uses body.callbackURL || '/' when building the link.
        // The UI may not pass one — force a redirect to the UI's /welcome
        // so users always land back on the SPA after the API processes the token.
        const dest = encodeURIComponent(`${opts.appUrl}/welcome`);
        const fixed = url.replace(/callbackURL=[^&]*/, `callbackURL=${dest}`);
        await sendVerificationEmail(opts.email, { to: user.email, url: fixed });
      },
    },

    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          const dest = encodeURIComponent(`${opts.appUrl}/welcome`);
          const fixed = url.includes("callbackURL=")
            ? url.replace(/callbackURL=[^&]*/, `callbackURL=${dest}`)
            : `${url}${url.includes("?") ? "&" : "?"}callbackURL=${dest}`;
          await sendMagicLinkEmail(opts.email, { to: email, url: fixed });
        },
        expiresIn: 60 * 15,                   // 15 minutes
      }),
    ],

    session: {
      expiresIn: 60 * 60 * 24 * 30,           // 30 days
      updateAge: 60 * 60 * 24,                // re-issue cookie if older than 1 day
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5,                       // 5-min in-memory cache
      },
    },

    advanced: {
      cookiePrefix: "daemora",
      useSecureCookies: opts.apiUrl.startsWith("https://"),
      database: { generateId: "uuid" },              // schema uses pg uuid type
      defaultCookieAttributes: {
        sameSite: "lax",
        httpOnly: true,
        secure: opts.apiUrl.startsWith("https://"),
      },
    },

    ...(opts.trustedOrigins ? { trustedOrigins: [...opts.trustedOrigins] } : {}),
  });
}

export type Auth = ReturnType<typeof buildAuth>;
