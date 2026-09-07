import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmailChromeOverride } from "agora/server";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = join(__dirname, "../assets/email/chrono-logo-header.png");
const LOGO_DATA_URI = `data:image/png;base64,${readFileSync(LOGO_PATH).toString("base64")}`;

/** Single-layer dot grid, echoing `.premium-dots` (apps/chrono-web/src/app/globals.css)
 * without porting it: kept to one radial-gradient layer (not three) because
 * email-client background-image support is inconsistent for stacked
 * gradients, and a fixed gold tone is used instead of `.premium-dots`'s
 * `color-mix(var(--primary), ...)` since email CSS has no
 * custom-property/color-mix support. */
const DOTTED_BACKGROUND =
  "background-color:#080806;" +
  "background-image:radial-gradient(rgba(214,168,79,0.14) 1px, transparent 1px);" +
  "background-size:24px 24px;";

export const CHRONO_EMAIL_CHROME: EmailChromeOverride = {
  headerHtml: `<img src="${LOGO_DATA_URI}" alt="Chrono by IZUR" width="184" height="50" style="display:block;margin:0 auto;max-width:184px;width:100%;height:auto" />`,
  outerBodyStyle: DOTTED_BACKGROUND,
};
