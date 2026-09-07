import { redirect } from "next/navigation";

/**
 * `/member/connect` was folded into `/member/session` (member-portal-v2
 * phase 1 — nav consolidation: Session absorbed Connect). This keeps any
 * bookmarked/shared link working instead of 404ing.
 */
export default function MemberConnectRedirectPage() {
  redirect("/member/session");
}
