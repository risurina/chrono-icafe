// Tenant public branding helpers are foundation server logic and live in
// `agora/next`; re-exported here so existing app call sites keep importing from
// `@/lib/branding`.
export {
  getPublicBranding,
  brandingCss,
  hexToHslChannels,
  type PublicBranding,
} from "agora/next";
