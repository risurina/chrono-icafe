"use client";

// Customer (tenant_member) auth for the browser. The transport client and the
// session hook both live in the foundation now — this module stays as the app's
// single import point so pages don't reach into two subpaths.
export { memberAuth, type MemberUser } from "agora/client";
export { useMemberSession } from "agora/client/react";
