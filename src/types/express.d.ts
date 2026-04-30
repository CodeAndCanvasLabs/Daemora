// Express Request augmentation. Uses the global `Express` namespace
// (defined inside @types/express-serve-static-core via `declare global`)
// instead of `declare module "..."` so the augmentation attaches
// regardless of where pnpm physically places the express types.
//
// Inline AuthContext (rather than importing it from requireAuth.ts) so
// this file stays a pure ambient declaration with no imports — keeps
// it loaded as a script, never as a module.

declare global {
  namespace Express {
    interface Request {
      auth?: {
        readonly userId: string;
        readonly scopes: readonly string[];
        readonly loopback: boolean;
      };
    }
  }
}

export {};
