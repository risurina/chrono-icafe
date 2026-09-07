import { randomBytes } from "node:crypto";
import { eq, and, not } from "agora/db";
import type { TenantTx } from "agora/db";
import { HttpError } from "agora/server";
import { chronoMemberProfile } from "./schema";

export type ChronoMemberProfileRow = typeof chronoMemberProfile.$inferSelect;

// Unambiguous uppercase alphabet — excludes 0/O and 1/I/L, which are easily
// confused when a member reads their code aloud to staff at the counter
// (same rationale as device/routes.ts's PAIRING_CODE_ALPHABET, minus "L").
const MEMBER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MEMBER_CODE_LENGTH = 6;
const MEMBER_CODE_MAX_ATTEMPTS = 5;

/** Cryptographically random 6-char member code, no visually ambiguous glyphs. */
export function generateMemberCode(): string {
  const bytes = randomBytes(MEMBER_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < MEMBER_CODE_LENGTH; i++) {
    out += MEMBER_CODE_ALPHABET[bytes[i]! % MEMBER_CODE_ALPHABET.length];
  }
  return out;
}

/**
 * True if `err` is a Postgres unique-violation (SQLSTATE 23505) specifically
 * on the per-tenant member-code uniqueness constraint — never swallows an
 * unrelated conflict (same dual code/cause.code shape as the other modules'
 * `isUniqueViolation` helpers, plus a constraint-name check since this one
 * error path must retry rather than surface).
 */
function isMemberCodeCollision(err: unknown): boolean {
  const matches = (v: unknown): boolean =>
    typeof v === "object" &&
    v !== null &&
    "code" in v &&
    (v as { code: unknown }).code === "23505" &&
    (!("constraint" in v) ||
      (v as { constraint?: unknown }).constraint === "chrono_member_profile_code_uq");
  if (matches(err)) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  return matches(cause);
}

export async function approveMemberProfile(
  tx: TenantTx,
  args: { tenantId: string; memberId: string },
): Promise<{ row: ChronoMemberProfileRow; previousStatus: string }> {
  const [pre] = await tx
    .select({
      applicationStatus: chronoMemberProfile.applicationStatus,
      memberCode: chronoMemberProfile.memberCode,
    })
    .from(chronoMemberProfile)
    .where(
      and(
        eq(chronoMemberProfile.tenantId, args.tenantId),
        eq(chronoMemberProfile.memberId, args.memberId),
      ),
    )
    .limit(1);

  // A code is generated once, on the first-ever approval — an
  // already-approved row hitting this function 409s below before any of
  // this matters, so in practice this only ever fires when `pre.memberCode`
  // is null. Collisions are retried with a fresh code, never surfaced to the
  // caller as an error (member-code plan, Pass 1 "Failure cases").
  const needsCode = !pre || pre.memberCode === null;

  let row: ChronoMemberProfileRow | undefined;
  for (let attempt = 1; attempt <= MEMBER_CODE_MAX_ATTEMPTS; attempt++) {
    try {
      [row] = await tx
        .update(chronoMemberProfile)
        .set({
          applicationStatus: "approved",
          approvedAt: new Date(),
          updatedAt: new Date(),
          ...(needsCode ? { memberCode: generateMemberCode() } : {}),
        })
        .where(
          and(
            eq(chronoMemberProfile.tenantId, args.tenantId),
            eq(chronoMemberProfile.memberId, args.memberId),
            not(eq(chronoMemberProfile.applicationStatus, "approved")),
          ),
        )
        .returning();
      break;
    } catch (err) {
      if (needsCode && isMemberCodeCollision(err) && attempt < MEMBER_CODE_MAX_ATTEMPTS) {
        continue;
      }
      if (needsCode && isMemberCodeCollision(err)) {
        // HttpError's status union tops out at 429 (agora/server) — this is
        // a genuine 500, so a plain Error is thrown instead and falls
        // through to app.ts's generic onError handler (logged + captured,
        // "Internal Server Error").
        throw new Error(
          "Could not generate a unique member code after several attempts.",
        );
      }
      throw err;
    }
  }

  if (!row) {
    const [current] = await tx
      .select({ applicationStatus: chronoMemberProfile.applicationStatus })
      .from(chronoMemberProfile)
      .where(
        and(
          eq(chronoMemberProfile.tenantId, args.tenantId),
          eq(chronoMemberProfile.memberId, args.memberId),
        ),
      )
      .limit(1);

    if (!current) {
      throw new HttpError(404, "Member profile not found.");
    }
    throw new HttpError(
      409,
      "This application has already been approved.",
    );
  }

  return { row, previousStatus: pre?.applicationStatus ?? "pending" };
}

export async function rejectMemberProfile(
  tx: TenantTx,
  args: { tenantId: string; memberId: string },
): Promise<{ row: ChronoMemberProfileRow; previousStatus: string }> {
  const [pre] = await tx
    .select({ applicationStatus: chronoMemberProfile.applicationStatus })
    .from(chronoMemberProfile)
    .where(
      and(
        eq(chronoMemberProfile.tenantId, args.tenantId),
        eq(chronoMemberProfile.memberId, args.memberId),
      ),
    )
    .limit(1);

  const [row] = await tx
    .update(chronoMemberProfile)
    .set({
      applicationStatus: "rejected",
      rejectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chronoMemberProfile.tenantId, args.tenantId),
        eq(chronoMemberProfile.memberId, args.memberId),
        not(eq(chronoMemberProfile.applicationStatus, "rejected")),
      ),
    )
    .returning();

  if (!row) {
    const [current] = await tx
      .select({ applicationStatus: chronoMemberProfile.applicationStatus })
      .from(chronoMemberProfile)
      .where(
        and(
          eq(chronoMemberProfile.tenantId, args.tenantId),
          eq(chronoMemberProfile.memberId, args.memberId),
        ),
      )
      .limit(1);

    if (!current) {
      throw new HttpError(404, "Member profile not found.");
    }
    throw new HttpError(
      409,
      "This application has already been rejected.",
    );
  }

  return { row, previousStatus: pre?.applicationStatus ?? "pending" };
}
