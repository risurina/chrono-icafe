/**
 * Reads a real, just-sent invite email back via Mailtrap's Email Testing
 * (sandbox) API (https://mailtrap.io) — sandbox sends are captured for
 * inspection only and never delivered, so there's no real, externally-reachable
 * inbox to provision per test; every spec shares one sandbox inbox and
 * correlates by exact recipient email, the same convention every other spec
 * uses to grep one shared dev-server log by `to=<uniqueEmail>`.
 *
 * Reads `MAILTRAP_API_TOKEN` and `MAILTRAP_TEST_INBOX_ID` from `process.env`
 * (test-runner-only, not in any `.env.example` — same precedent as
 * `DEV_LOG_PATH` in `members.spec.ts`'s `findInviteLink()`). The chrono-api
 * dev server needs the same two vars, plus `EMAIL_PROVIDER=mailtrap`, to
 * actually send through Mailtrap in the first place.
 */
const BASE = "https://mailtrap.io/api/sandboxes";

type SandboxMessage = { id: number; to_email: string };

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to read invite emails back from Mailtrap.`);
  }
  return value;
}

async function mailtrapFetch(path: string): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Api-Token": env("MAILTRAP_API_TOKEN") },
  });
  if (!res.ok) {
    throw new Error(`Mailtrap API request failed (${res.status}): ${path}`);
  }
  return res;
}

/**
 * Polls the shared sandbox inbox until a message addressed to `toEmail`
 * arrives (delivery into the sandbox can lag a few seconds), then returns
 * its accept-invite link extracted from the message's HTML body.
 */
export async function waitForMailtrapInviteLink(toEmail: string): Promise<string> {
  const inboxId = env("MAILTRAP_TEST_INBOX_ID");
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const listRes = await mailtrapFetch(
      `/${inboxId}/messages?search=${encodeURIComponent(toEmail)}`,
    );
    const messages = (await listRes.json()) as SandboxMessage[];
    const match = messages.find((m) => m.to_email === toEmail);

    if (match) {
      const htmlRes = await mailtrapFetch(`/${inboxId}/messages/${match.id}/body.html`);
      const html = await htmlRes.text();
      const linkMatch = html.match(/href="([^"]*\/accept-invite\?token=[^"]+)"/);
      if (linkMatch?.[1]) return linkMatch[1].replace(/&amp;/g, "&");
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  throw new Error(`No invite email found in Mailtrap sandbox inbox for ${toEmail} within 60s`);
}
