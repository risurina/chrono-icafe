/**
 * Reads a real, just-sent invite email back via Guerrilla Mail
 * (https://www.guerrillamail.com) — a free, keyless disposable-inbox API.
 * Plain HTTP polling, no browser/session needed — unlike a real mailbox
 * (e.g. Gmail), which detects and blocks session replay from automation.
 */
const API = "https://api.guerrillamail.com/ajax.php";

type MailItem = { mail_id: number };
type GetAddressResponse = { email_addr: string; sid_token: string };
type CheckEmailResponse = { list: MailItem[] };
type FetchEmailResponse = { mail_body?: string };

export type TempInbox = { email: string; sidToken: string };

/** A fresh disposable inbox from Guerrilla Mail's pool. */
export async function newTempInbox(): Promise<TempInbox> {
  const res = await fetch(`${API}?f=get_email_address`);
  const data = (await res.json()) as GetAddressResponse;
  return { email: data.email_addr, sidToken: data.sid_token };
}

/**
 * Polls the inbox until a message containing an accept-invite link arrives
 * (real delivery can lag a few seconds), then returns that link. The list
 * endpoint only returns a preview, so each candidate message's full body is
 * fetched separately.
 */
export async function findInviteLinkInTempInbox(inbox: TempInbox): Promise<string> {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const listRes = await fetch(
      `${API}?f=check_email&seq=0&sid_token=${encodeURIComponent(inbox.sidToken)}`,
    );
    const listData = (await listRes.json()) as CheckEmailResponse;

    for (const item of listData.list) {
      const mailRes = await fetch(
        `${API}?f=fetch_email&sid_token=${encodeURIComponent(inbox.sidToken)}&email_id=${item.mail_id}`,
      );
      const mail = (await mailRes.json()) as FetchEmailResponse;
      if (!mail.mail_body) continue;
      const match = mail.mail_body.match(/href="([^"]*\/accept-invite\?token=[^"]+)"/);
      if (match?.[1]) return match[1].replace(/&amp;/g, "&");
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  throw new Error(`No invite email found in temp inbox for ${inbox.email} within 60s`);
}
