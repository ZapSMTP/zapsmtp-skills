---
name: zapsmtp-inbound
description: Use when receiving email with ZapSMTP — managed inbound addresses or your own domain with an MX record, inbound routes (webhook, store, forward, reject), the email.received / thread.created / thread.replied webhooks and include_content, fetching received bodies, headers and attachments, conversations (thread_id, GET /threads), replying in the same thread (POST /emails/receiving/{id}/reply), reply tracking and email.replied, spam scores and reports, forward destinations, redelivery and GDPR erasure — for support inboxes, reply-by-email and email-to-ticket flows.
license: MIT
metadata:
  author: zapsmtp
  version: "1.0.0"
---

# Receive email with ZapSMTP

ZapSMTP accepts mail for your addresses, checks SPF, DKIM, DMARC, ARC and spam, strips the
quoted reply, groups messages into conversations and calls your endpoint with a signed
`email.received`. You answer through the API, in the same thread. Payload and object fields:
[references/payloads.md](references/payloads.md). Webhook signature and retries:
`zapsmtp-webhooks` (same system).

Setup calls (inbound domains, routes, forward destinations, webhooks, `PATCH /threads`, spam
reports, redeliver, erase) need a **full-access live key**; a test key gets
`403 test_key_restricted` but can still read and reply (test replies are never delivered).

## 1. Get an address

| Kind | How | Use when |
|---|---|---|
| **Managed** | `POST /inbound/domains {"managed": true}` → `k3f9x2m7q1.in.zapsmtp.com`, ready at once, no DNS | Prototypes, internal parsing addresses. Receive-only: replies need a `from` on your verified sending domain |
| **Your own domain** | `POST /inbound/domains {"name": "support.acme.com"}`, publish the MX record from `records`, then `POST /inbound/domains/{id}/verify` | Customer-facing addresses |

- Your own inbound domain must be a domain you verified **for sending**, or a subdomain of one
  (`403 domain_not_verified` otherwise). ZapSMTP-owned names → `422 reserved_domain`; already
  receiving on ZapSMTP → `409 conflict`.
- The one record: `MX`, name `support.acme.com`, priority `10`, value `mail.zapsmtp.com`
  (use the value the API returns). `mx_verified` becomes `true` when any MX of the name points
  there; `mx_found` shows what DNS returns.
- **An MX record moves all mail of that name to ZapSMTP.** To keep mailboxes on `acme.com`,
  receive on a subdomain (`support.acme.com`, `reply.acme.com`).
- Every local part is accepted (`anything@`, `support+1234@`). Mail for unknown domains is
  refused during SMTP (no backscatter).
- Options: `reject_spam: true` refuses flagged spam at SMTP time; `require_tls: true` refuses
  senders without STARTTLS (`530 5.7.0`). Change later with `PATCH /inbound/domains/{id}`.

```ts
import { ZapSMTP } from 'zapsmtp';

const zap = new ZapSMTP(); // full-access live key
const domain = await zap.inbound.domains.create({ name: 'support.acme.com', reject_spam: true });
console.log(domain.records); // publish the MX record, then:
const check = await zap.inbound.domains.verify(domain.id);
console.log(check.domain.mx_verified, check.mx_found);
```

## 2. Subscribe an endpoint

Create a webhook for `email.received` (and optionally `thread.created`, `thread.replied`). By
default the event carries **metadata only** (so a 40 MB message never hits your request limit);
fetch the body via the API, or set `include_content: true` to get `text`, `html`, `headers` and
24-hour download links in the event (text and HTML share 1 MB, then `truncated: true`; the API
still serves them whole).

```bash
curl -X POST "$ZAP_BASE_URL/webhooks" \
  -H "Authorization: Bearer $ZAP_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://acme.com/hooks/inbound", "events": ["email.received", "thread.created", "thread.replied"], "include_content": true}'
```

## 3. Routes (optional)

Without routes every message is stored and sent to every endpoint subscribed to
`email.received`. Routes (up to 100 per account) are tried by `priority` (lowest first, then
oldest); the first enabled route whose conditions all match decides.

| Condition | Matches |
|---|---|
| `match_recipient` | The receiving address, e.g. `support+*@acme.com` |
| `match_sender` | The envelope sender (`MAIL FROM`), which can differ from `From` |
| `match_header` + `match_header_value` | A header (any case) and a pattern for its value; a message without the header does not match |

Patterns: case-insensitive globs (`*`, `?`) or `/regex/` (RE2: no lookarounds or
backreferences), at most 512 bytes; empty matches anything.

| `action` | Effect |
|---|---|
| `webhook` | Stored; `email.received` goes **only** to `webhook_id` (even if it does not subscribe to the event) |
| `store` | Stored, readable by API/dashboard; no webhook, no thread events |
| `forward` | Stored and relayed to the confirmed forward destination `forward_id`; no webhook |
| `reject` | Refused during SMTP with `550 5.7.1`; nothing stored (listed with `status: "rejected"`) |

```ts
import { ZapSMTP } from 'zapsmtp';

const zap = new ZapSMTP();
await zap.inbound.routes.create({
  name: 'Support tickets', priority: 10,
  match_recipient: 'support+*@acme.com',
  action: 'webhook', webhook_id: '019a1f22-6e7f-7091-8a2b-3c4d5e6f7a8b',
});
await zap.inbound.routes.create({
  name: 'Newsletters', priority: 50, match_header: 'List-Id', match_header_value: '*', action: 'store',
});
```

**Forwarding to a mailbox:** `POST /inbound/forward-destinations {"email": "oncall@acme.com"}`
emails a confirmation link; until its owner confirms (`verified_at` set) no route may forward
there. 20 destinations per account (`422 limit_exceeded`); resend the confirmation at most once
a minute (`POST /inbound/forward-destinations/{id}/resend`). A ZapSMTP receiving address cannot
be a destination. The copy is byte for byte (From and DKIM intact), ARC-sealed, with
`X-ZapSMTP-Forwarded-For`; it counts as one sent email. Spam is never forwarded.

## 4. Handle `email.received`

One event per received message **and receiving address** (mail to two of your addresses is two
emails). Key `data` fields: `email_id`, `from`, `from_name`, `to`, `cc`, `received_for` (your
address this copy was for), `subject`, `message_id`, `mailbox_hash` (the part after `+`:
`support+1234@` → `1234`), `reply_text` (only the new text), `in_reply_to_email_id` (your sent
email it answers, or `null`), `thread_id`, `automated` (`null` or `{type, reason}`),
`authentication` (`spf`, `dkim`, `dmarc`, `arc`), `spam` (`score`, `is_spam`), `attachments`
(metadata), `route_id`, `size`. **No top-level `id`: dedupe on `Zap-Event-Id`.**

Rules for the handler:

- Verify the signature on the raw body (`zapsmtp-webhooks`).
- Trust the From address only when `authentication.dmarc` is `pass`.
- Skip or file `spam.is_spam: true`.
- **Never auto-answer `automated` mail** (bounces, out-of-office, auto-replies, notifications):
  that is how mail loops start. `bulk` (mailing lists) may be answered.
- Put a ticket or order id in the Reply-To of what you send (`support+1234@acme.com`); it comes
  back as `mailbox_hash`.

<!-- check: webhook path=/hooks/inbound event=received -->
```ts
import express from 'express';
import { ZapSMTP, verifyWebhook, WebhookVerificationError } from 'zapsmtp';

const zap = new ZapSMTP();
const app = express(); // db stands for your storage

app.post('/hooks/inbound', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = verifyWebhook(req.body, req.headers, process.env.ZAP_WEBHOOK_SECRET!);
  } catch (err) {
    if (err instanceof WebhookVerificationError) return res.sendStatus(400);
    throw err;
  }
  const eventId = req.get('Zap-Event-Id')!;
  if (event.type !== 'email.received' || (await db.seen(eventId))) return res.sendStatus(200);
  const m = event.data;
  if (m.spam?.is_spam) return res.sendStatus(200);
  res.sendStatus(200); // answer first; the rest may take time

  let ticket = await db.ticketByThread(m.thread_id);
  const isNew = !ticket;
  if (isNew) ticket = await db.createTicket({ threadId: m.thread_id, customer: m.from, subject: m.subject });
  const email = await zap.emails.receiving.get(m.email_id); // full text, html, headers
  await db.addMessage(ticket, { text: m.reply_text || email.text, html: email.html });
  if (isNew && !m.automated) {
    await zap.emails.receiving.reply(m.email_id, {
      from: 'Acme Support <support@acme.com>',
      text: 'Thanks, we got your message and will answer soon.',
      auto_reply: true, // marks it Auto-Submitted so other auto-responders stay quiet
    }, { idempotencyKey: `ack-${m.email_id}` });
  }
  await db.markSeen(eventId);
});

app.listen(3000);
```

## 5. Read the message and attachments

| Call | Returns |
|---|---|
| `GET /emails/receiving/{id}` | Bodies (`html`, `text`), all `headers` (lower-case names; repeats joined with `", "`), `authentication`, `arc`, `spam` (`score`, `is_spam`, `action`), `tls`, `peer_ip`, `helo`, `raw.download_url`, attachments. `?html_format=cid` keeps `cid:` references; default `data_uri` inlines images (unless they exceed 2 MB together) |
| `GET /emails/receiving/{id}/attachments` | Each attachment with a signed `download_url` (no API key needed, valid **1 hour**; 24 hours in a webhook). Inline images are attachments too (`content_id`) |
| `GET /emails/receiving/{id}/attachments/{aid}` | One attachment with a fresh link |
| `GET /emails/receiving` | Newest first; filters `q`, `status` (`received`/`rejected`), `domain`, `thread_id`, `automated` (`false`, `true` or a type); `limit` 1–100, `before`/`after` |

`reply_text` is a heuristic (quote headers in several languages, `>` lines, `-- ` signatures);
`text` and `html` always hold the full message. `raw.download_url` is the original `.eml`.
Expired links answer `410 link_expired`: list again. Received mail is kept for the plan's log
retention (3 days Free, 30 Pro, 90 Scale), then `404`.

<!-- check: typecheck (downloads real files) -->
```python
import pathlib

import httpx
from zapsmtp import ZapSMTP

client = ZapSMTP()
email_id = "019a1f30-1d4e-7a6b-8c2d-3e4f5a6b7c8d"
received = client.emails.receiving.get(email_id)
print(received.subject, received.reply_text)
for a in client.emails.receiving.attachments.list(email_id).data:
    data = httpx.get(a.download_url).content  # signed link: no API key
    pathlib.Path(a.filename).write_bytes(data)
```

## 6. Conversations

`thread_id` comes from `Message-ID`, `In-Reply-To` and `References`: nothing to set up. Your
replies join the thread (their Message-ID names it), and a conversation you start by sending
appears in the inbox once the customer answers.

- `GET /threads?awaiting_reply=true` (also `unread`, `participant`, `limit`; page with
  `before` = last `last_message_at` and `before_id` = its id): a helpdesk inbox, most recent
  first. `awaiting_reply` is `true` when the latest non-automated email came in.
- `GET /threads/{id}`: state plus received and sent emails, oldest first (at most 500).
- `PATCH /threads/{id}` `{"read": true, "metadata": {"ticket": "T-1042"}}`: read mark and your
  own metadata (≤ 20 keys `[A-Za-z0-9_-]{1,40}`, values ≤ 500 bytes; replaces all).

## 7. Reply

`POST /emails/receiving/{id}/reply` fills in what a mail client would:

| Field | Default |
|---|---|
| `to` | The email's Reply-To, else its From. `reply_all: true` also copies its To and Cc, except the receiving address, the `from` you reply from, the original sender and anyone already addressed |
| `from` | The receiving address; its **exact** domain must be verified for sending. **Required** for managed addresses |
| `reply_to` | The receiving address, when you reply from another address |
| `subject` | `Re: ` + the subject (unless it starts with Re:) |
| `In-Reply-To`, `References` | From the email (a value in `headers` wins) |

Everything else of `POST /emails` works (`html`/`text` or `template`, attachments, tags,
metadata, `scheduled_at`, tracking, suppressions, test keys). The response is `{id, thread_id}`.
Send an `Idempotency-Key` (the SDKs add one). Loop protection: replying to automated mail fails
with `422 automated_message` unless `allow_automated: true`; at most **20 replies per
conversation per hour** (`429 thread_reply_limit`, `Retry-After: 3600`). Mark acknowledgements
`auto_reply: true` (adds `Auto-Submitted: auto-replied` and `X-Auto-Response-Suppress: All`).

```python
from zapsmtp import ZapSMTP

client = ZapSMTP()
sent = client.emails.receiving.reply(
    "019a1f30-1d4e-7a6b-8c2d-3e4f5a6b7c8d",
    from_="Acme Support <support@acme.com>",
    text="Hi Jane,\n\nGlad it works now. Your order ships today.\n\nAnn, Acme Support",
    idempotency_key="reply-T-1042-1",
)
print(sent.id, sent.thread_id)
```

To answer from your own code without the reply endpoint, set `headers.In-Reply-To` and
`headers.References` to the received `message_id` on `POST /emails`.

## 8. Reply tracking (answers to what you send)

Give each email from a domain its own signed Reply-To on your inbound domain
(`r1-<email id>.<signature>@reply.acme.com`), so every answer is tied to the exact email:

1. Add an inbound domain such as `reply.acme.com` (MX-verified, same account, equal to the
   sending domain or a subdomain of it).
2. `PATCH /domains/{id}` `{"reply_domain": "reply.acme.com", "reply_tracking": true}`;
   optionally `reply_forward_to` (an address on a verified domain or a confirmed forward
   destination) for replies a person wrote; empty forwards to the email's first Reply-To, else
   its From.
3. Per email: `tracking: {"replies": true|false}`; over SMTP `X-Zap-Reply-Tracking: on|off`.

Each answer arrives as a received email (routes are skipped), fires `email.received` and the
thread events, and adds `email.replied` on the original email with `data.reply` (`type`:
`human`, `unsubscribe`, `out_of_office`, `auto_reply`, `auto_generated`, `bounce`, `bulk`; the
text without quote, ≤ 2,000 characters; `forward` status). A reply address works for 30 days and
takes 100 replies a day. `type: "unsubscribe"` is reported, not applied: suppress the address
yourself. The send response carries the tracked `reply_to`.

## 9. Spam, redelivery, erasure

- Score ≥ 15: refused at SMTP (`550 5.7.1`). From 6: accepted with `is_spam: true`, or refused
  when the domain has `reject_spam`. Spam is never forwarded.
- `POST /emails/receiving/{id}/spam` `{"spam": true|false}` trains the account's own filter
  (it starts scoring after 20 learned messages of each kind; `learned: false` = too few words).
- `POST /emails/receiving/{id}/redeliver` re-queues `email.received` (`202`; no thread events,
  no new forward).
- `DELETE /emails/receiving/{id}` erases content and metadata for good (GDPR); `409 not_ready`
  while still being stored (`Retry-After: 5`).

## Limits

Message 40 MB; ≤ 1,000 MIME parts and 100 multipart sections (else `550 5.6.0`); 100 routes;
patterns 512 bytes; 20 forward destinations; webhook content 1 MB, `reply_text` 16 KB in the
webhook; download links 1 hour (API) / 24 hours (webhook); 20 replies per conversation per
hour; reply addresses 30 days, 100 replies a day.
