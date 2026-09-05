// Auth-page chrome context resolution is foundation server logic and lives in
// `agora/next`; re-exported here so app call sites import from `@/lib/auth-chrome`,
// matching the existing `@/lib/branding` / `@/lib/tenant` convention (and
// `apps/agora-web`'s own equivalent file).
export { resolveAuthChromeContext, type AuthChromeContext } from "agora/next";
