import { Card, CardHeader, CardTitle, CardDescription, Badge, Stack, Row, Grid } from "agora/ui";
import { MemberPageHeader } from "@/components/member/member-page-header";

/**
 * Connect — a three-step explainer for the existing QR scan-to-start flow
 * (`/q/[token]`, `POST /public/qr/consume`). Camera-based scanning inside the
 * member area itself is deliberately out of scope (no cross-browser
 * dependency-free path) — the phone's native camera app is the real path,
 * per the plan.
 */
const STEPS = [
  {
    step: 1,
    title: "Find the QR code",
    description: "Every station has a QR code printed on its stand or displayed on its screen.",
  },
  {
    step: 2,
    title: "Scan it with your phone's camera",
    description:
      "Open your phone's native camera app (no app install needed) and point it at the code — no in-app scanner is required.",
  },
  {
    step: 3,
    title: "Confirm and start",
    description:
      "The link opens your account here. Sign in if asked, then tap Start to begin your session on that station.",
  },
] as const;

export default function MemberConnectPage() {
  return (
    <Stack gap={6}>
      <MemberPageHeader
        title="Connect"
        description="Start a session at any station by scanning its QR code."
      />
      <Grid cols={3} gap={4}>
        {STEPS.map((s) => (
          <Card key={s.step} data-testid={`connect-step-${s.step}`}>
            <CardHeader>
              <Row items="center" className="gap-2">
                <Badge>{s.step}</Badge>
                <CardTitle className="text-base">{s.title}</CardTitle>
              </Row>
              <CardDescription>{s.description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </Grid>
      <Card>
        <CardHeader>
          <CardTitle>Already scanned a code?</CardTitle>
          <CardDescription>
            Follow the link your phone opened — it will land you on that station's Start
            page automatically.
          </CardDescription>
        </CardHeader>
      </Card>
    </Stack>
  );
}
