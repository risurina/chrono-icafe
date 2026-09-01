/**
 * Registers Chrono's permission resources before anything else in this
 * process imports `agora/auth` (which freezes the shared permission
 * registry on first read to build Better Auth's `ac` and system roles).
 *
 * This file imports ONLY from `agora/auth/permissions` — never `agora/auth`
 * itself — so importing it cannot itself trigger that freeze. It must be
 * the first import in `src/index.ts`, before `./app` (which imports
 * `agora/auth`). See `.ai/rules/business-app.md` and
 * `packages/agora/src/auth/permission-registry.ts`.
 */
import { registerChronoPermissions } from "./auth/permissions";

registerChronoPermissions();
