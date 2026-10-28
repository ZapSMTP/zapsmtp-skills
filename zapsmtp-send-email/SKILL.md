---
name: zapsmtp-send-email
description: Use when sending email through ZapSMTP (POST /emails or /emails/batch, or the zapsmtp SDK's emails.send / sendBatch) — single or batch sends, display names, cc/bcc/reply_to, HTML and text, attachments and inline images, tags vs metadata, custom headers, transactional vs broadcast streams, scheduling and canceling, idempotency keys, test keys and simulator addresses, reading the response (thread_id, suppressed, failed_recipients, unconfirmed), errors, retries and rate limits.
license: MIT
metadata:
  author: zapsmtp
  version: "1.0.0"
---

# Send email with ZapSMTP

`POST /emails` sends one message (to up to 50 recipients); `POST /emails/batch` sends 1–100
separate messages. Base URL, keys and SDK setup: see the `zapsmtp` skill. Every field, limit
and error: [references/fields.md](references/fields.md).

## Decide first

| Situation | Do this |
|---|---|
| One message, recipients may see each other | `POST /emails` with `to` (+ `cc`/`bcc`), at most 50 addresses in total |
| Each person gets their own copy (newsletter, notifications, personalised mail) | `POST /emails/batch`, **one recipient per email**, up to 100 per call |
| Marketing / bulk / anything with an unsubscribe | `stream: "broadcast"`, one recipient per email |
| Receipts, password resets, alerts | `stream: "transactional"` (the default) |
| Content lives in a stored template | `template: {id, variables}` instead of `subject`/`html`/`text` (`zapsmtp-templates`) |
| Development, CI, staging | A `zap_test_` key and `…@simulator.zapsmtp.com` recipients |
| Must never send twice | An `Idempotency-Key` derived from your own record (`order-1042-receipt`) |
| App already speaks SMTP | SMTP relay (`mail.zapsmtp.com:587`); the API is needed for attachments by URL, templates, tags/metadata, scheduling, batches and idempotency |

## A complete send

```ts
import { ZapSMTP } from 'zapsmtp';

const zap = new ZapSMTP(); // ZAP_API_KEY, ZAP_BASE_URL

const sent = await zap.emails.send(
  {
    from: 'Acme <hello@acme.com>',
    to: ['Jane Doe <delivered+jane@simulator.zapsmtp.com>'],
    cc: '"Doe, John" <delivered+john@simulator.zapsmtp.com>', // quote names with punctuation
    bcc: ['delivered+audit@simulator.zapsmtp.com'],          // never written into headers
    reply_to: 'Acme Support <support@acme.com>',
    subject: 'Your receipt for order A-1042',
    html: '<p>Thanks for your order.</p>',
    text: 'Thanks for your order.',
    tags: [{ name: 'category', value: 'receipt' }],
    metadata: { order_id: 'A-1042', customer_id: 'cus_8812' },
  },
  { idempotencyKey: 'order-A-1042-receipt' },
);
console.log(sent.id, sent.thread_id, sent.suppressed ?? []);
```

```python
from zapsmtp import ZapSMTP

client = ZapSMTP()

sent = client.emails.send(
    from_="Acme <hello@acme.com>",
    to=["Jane Doe <delivered+jane@simulator.zapsmtp.com>"],
    reply_to="Acme Support <support@acme.com>",
    subject="Your receipt for order A-1042",
    html="<p>Thanks for your order.</p>",
    text="Thanks for your order.",
    tags=[{"name": "category", "value": "receipt"}],
    metadata={"order_id": "A-1042"},
    idempotency_key="order-A-1042-receipt",
)
print(sent.id, sent.thread_id)
```

```go
package main

import (
	"context"
	"fmt"
	"log"

	"github.com/zapsmtp/zapsmtp-go"
)

func main() {
	client := zapsmtp.NewClient("")
	sent, err := client.Emails.Send(context.Background(), &zapsmtp.SendEmailParams{
		From:     zapsmtp.String("Acme <hello@acme.com>"),
		To:       []string{"Jane Doe <delivered+jane@simulator.zapsmtp.com>"},
		ReplyTo:  []string{"Acme Support <support@acme.com>"},
		Subject:  zapsmtp.String("Your receipt for order A-1042"),
		HTML:     zapsmtp.String("<p>Thanks for your order.</p>"),
		Text:     zapsmtp.String("Thanks for your order."),
		Tags:     []zapsmtp.Tag{{Name: "category", Value: "receipt"}},
		Metadata: map[string]string{"order_id": "A-1042"},
	}, zapsmtp.WithIdempotencyKey("order-A-1042-receipt"))
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(sent.ID, sent.ThreadID)
}
```

```bash
curl -X POST "$ZAP_BASE_URL/emails" \
  -H "Authorization: Bearer $ZAP_API_KEY" \
  -H 'Idempotency-Key: order-A-1042-receipt' \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "Acme <hello@acme.com>",
    "to": ["Jane Doe <delivered+jane@simulator.zapsmtp.com>"],
    "reply_to": "Acme Support <support@acme.com>",
    "subject": "Your receipt for order A-1042",
    "html": "<p>Thanks for your order.</p>",
    "text": "Thanks for your order.",
    "tags": [{"name": "category", "value": "receipt"}],
    "metadata": {"order_id": "A-1042"}
  }'
```

## Addresses

- `from` (one address) is required unless the template defines a sender. With a live key its
  domain must be verified **exactly** (`acme.com` does not cover `mail.acme.com`):
  `403 domain_not_verified`. Test keys accept any domain. With a bare address, the domain's
  brand `from_name` becomes the display name.
- `to` (required), `cc`, `bcc`, `reply_to`: a string or an array. RFC 5322 form:
  `jane@example.org` or `Jane Doe <jane@example.org>`; put a name containing a comma or other
  punctuation in double quotes. Non-ASCII names are encoded for you.
- At most **50** addresses across `to`, `cc` and `bcc` (`422 invalid_parameter`, "too many
  recipients (max 50)"). Recipients are lowercased and duplicates are sent once.
- One email to several recipients is one message: everyone sees the same `To` and `Cc`. To
  give each person their own copy, use a batch with one recipient per email.

## Bodies

`subject` is required (not blank) unless a template supplies it; `html`, `text` or both are
required (`422 missing_required_field`, "html or text is required").

- `text` only → one `text/plain` part.
- `html` only → `multipart/alternative` with a text part **generated from the HTML** (links
  become "text (url)"; preheader, styles and scripts are left out). Send your own `text` to
  control the wording.
- Both → `multipart/alternative`, text first.
- Keep HTML under about 102 KB: Gmail clips larger messages.

## Attachments

Each item has `filename` and **either** `content` (standard base64 with padding) **or** `path`
(an `http(s)` URL ZapSMTP downloads when you send; it must answer `200` within 20 seconds;
private and internal addresses are refused). `content_type` is optional (from the extension,
or the server's `Content-Type` for `path`). `content_id` makes the file inline: reference it as
`cid:<content_id>` in the HTML. With `path`, `filename` may be omitted (the URL's last segment).

- The whole request is limited to 40 MB (`413 payload_too_large`); base64 adds about a third,
  so plan on about 30 MB of files. Files fetched by `path` may add up to 40 MB per request.
- Receiving servers often refuse messages over 20–25 MB: send a link for large files.
- Errors: `422 invalid_attachment` with the index, e.g. `attachments[0]: content must be base64`.

```ts
import { ZapSMTP, attachment, attachmentFromFile } from 'zapsmtp';

const zap = new ZapSMTP();
const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // your PNG bytes

await zap.emails.send({
  from: 'Acme <billing@acme.com>',
  to: 'delivered@simulator.zapsmtp.com',
  subject: 'Invoice A-1042',
  html: '<p><img src="cid:logo" alt="Acme" width="120"></p><p>Your invoice is attached.</p>',
  attachments: [
    await attachmentFromFile('./invoice.pdf'),             // base64, content type from the extension
    attachment('logo.png', logo, { contentId: 'logo' }),   // inline image
    { path: 'https://acme.com/terms.pdf', filename: 'terms.pdf' }, // fetched at send time
  ],
});
```

Python: `from zapsmtp import attachment, attachment_from_file` (`attachment("logo.png", data,
content_id="logo")`). Go: `zapsmtp.AttachmentFromFile(path)`, `zapsmtp.AttachmentFromBytes(name, b)`.

## Tags or metadata?

| | `tags` | `metadata` |
|---|---|---|
| Shape | `[{"name", "value"}]`, both `^[A-Za-z0-9_-]{1,256}$`, at most 20 | object of strings: at most 10 keys `^[A-Za-z0-9_-]{1,40}$`, values up to 500 bytes |
| Use for | categories you report on (`category=receipt`, `plan=pro`) | your own ids (`order_id`, `customer_id`) |
| Comes back | webhooks as an object `data.tags`; filters `GET /metrics?tag=category=receipt` | delivery webhooks as `data.metadata`, `GET /emails/{id}`, filter `GET /emails?metadata[order_id]=A-1042` |
| On opens/clicks | only when the encoded tags fit in 200 bytes | only when its JSON fits in 200 bytes; not on reply events |

Invalid tags or metadata return `422 invalid_parameter`. Keep the ids you need on opens and
clicks short.

## Custom headers

`headers` maps header names to string values. These cannot be set (`422 invalid_parameter`,
"header … cannot be set"): `From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Date`,
`Message-ID`, `MIME-Version`, `Content-Type`, `Content-Transfer-Encoding`, `DKIM-Signature`,
`Return-Path`, `Received`, `Sender`, `Authentication-Results`, `ARC-Seal`,
`ARC-Message-Signature`, `ARC-Authentication-Results`, `Received-SPF`, `Resent-*`, `X-ZapRef`
and any `X-Zap-*`. Use the body fields instead.

- Set `In-Reply-To` and `References` to the `Message-ID` you answer to keep a conversation
  together; the response's `thread_id` then names it.
- On the broadcast stream, your own `List-Unsubscribe` replaces the one ZapSMTP adds.

## Streams, unsubscribe, tracking, TLS

- `stream`: `transactional` (default) or `broadcast`; on shared IPs they leave from separate
  pools. A key restricted to one stream sends on it by default and gets `403 restricted_api_key`
  for the other.
- A **broadcast** email to a **single** recipient gets RFC 8058 one-click unsubscribe headers
  (`List-Unsubscribe`, `List-Unsubscribe-Post`) unless you set your own. An unsubscribe
  suppresses the address for broadcast mail only; transactional mail still goes out.
- `{{{zap:unsubscribe_url}}}` in `html` or `text` (any stream, with or without a template)
  becomes the recipient's signed unsubscribe link. With several recipients it belongs to the
  first one.
- `tracking: {"opens", "clicks", "replies"}` overrides the From domain's defaults for this
  email (`replies` needs a reply domain: `zapsmtp-inbound`).
- `tls: "required"` (TLS or no delivery) or `"verified"` (TLS with a valid certificate) raises
  the domain's policy, never lowers it.

```ts
import { ZapSMTP } from 'zapsmtp';

const zap = new ZapSMTP();
await zap.emails.send({
  from: 'Acme News <news@acme.com>',
  to: 'delivered@simulator.zapsmtp.com', // exactly one recipient: one-click headers are added
  subject: 'What shipped in October',
  stream: 'broadcast',
  html: '<p>Three new features.</p><p><a href="{{{zap:unsubscribe_url}}}">Unsubscribe</a></p>',
  tracking: { opens: true, clicks: true },
});
```

## Scheduling

Add `scheduled_at`: RFC 3339 (`2026-10-28T09:00:00Z`, `2026-10-28T11:00:00+02:00`) or
`in <n> <unit>` with unit `min`, `mins`, `minute`, `minutes`, `h`, `hour`, `hours`, `d`, `day`,
`days` (`in 30 minutes`). Nothing else ("tomorrow at 9am") is understood. A past time sends now.

- At most **7 days** ahead (`422`, "scheduled_at must be within 7 days"); at most **10,000**
  emails (256 MB) may wait per account.
- Validation (addresses, content, template rendering, sender domain) happens when you call;
  rate limits, quotas and suppressions apply at dispatch. A failure at dispatch (exhausted
  quota, suspended account, revoked or expired key) marks the email `failed`; a rate-limited
  dispatch is retried later.
- While waiting: `GET /emails/{id}` shows `status: "scheduled"`; `GET /emails?status=scheduled`
  lists the soonest waiting emails (`has_more` is always `false`).
- Move: `PATCH /emails/{id}` with only `scheduled_at`. Cancel: `POST /emails/{id}/cancel`
  (status becomes `canceled`). Both answer `409 not_cancellable` once dispatched (and for
  unknown ids). `sending_access` keys may do both; a key restricted to a domain or stream
  manages only its own scheduled emails, and a test key cannot touch live ones
  (`403 restricted_api_key`).

```ts
import { ZapSMTP } from 'zapsmtp';

const zap = new ZapSMTP();
const { id } = await zap.emails.send({
  from: 'Acme <hello@acme.com>',
  to: 'delivered@simulator.zapsmtp.com',
  subject: 'Your trial ends tomorrow',
  text: 'Upgrade any time from Settings.',
  scheduled_at: 'in 1 hour',
});
await zap.emails.update(id, { scheduled_at: '2026-10-28T09:00:00Z' }); // reschedule
await zap.emails.cancel(id);                                          // or cancel
```

## Batch

`POST /emails/batch` takes a JSON **array** of 1–100 emails, each with the fields of a single
send (its own `from`, `stream`, `scheduled_at`, template…). The 40 MB limit covers the whole
batch; one `Idempotency-Key` covers the whole request.

- Header `x-batch-validation: strict` (default): if any email is invalid, nothing is sent:
  `422 validation_error` with `errors: [{index, code, message}]`.
- `permissive`: valid emails are sent, invalid ones are listed in `errors`, status `200`.
- `200` body: `data` (one `{index, id, …}` per accepted email, plus `suppressed`,
  `failed_recipients`, `unconfirmed`, `reply_to`, `thread_id` as for a single send) and
  `errors`. **Send-time failures (`rate_limit_exceeded`, `monthly_quota_exceeded`, …) appear in
  `errors` in both modes, not as the HTTP status: always read `errors`.**
- Retry only the failed items, in a **new** batch with a **new** key (the old key replays the
  old response).

```ts
import { ZapSMTP } from 'zapsmtp';

const zap = new ZapSMTP();
const users = [{ email: 'delivered+ann@simulator.zapsmtp.com', name: 'Ann' },
               { email: 'delivered+bob@simulator.zapsmtp.com', name: 'Bob' }];

const { data, errors } = await zap.emails.sendBatch(
  users.map((u) => ({
    from: 'Acme <hello@acme.com>',
    to: u.email,
    subject: 'Your weekly digest',
    text: `Hi ${u.name}, here is your week.`,
    tags: [{ name: 'category', value: 'digest' }],
  })),
  { validation: 'permissive', idempotencyKey: 'digest-2026-10-26-chunk-1' },
);
for (const e of errors) console.error(`email ${e.index} not sent: ${e.code} ${e.message}`);
console.log(data.map((d) => d.id));
```

```python
from zapsmtp import ZapSMTP

client = ZapSMTP()
result = client.emails.send_batch(
    [  # batch items are plain dicts with the API's own key "from"
        {"from": "Acme <hello@acme.com>", "to": "delivered+ann@simulator.zapsmtp.com", "subject": "Hi Ann", "text": "..."},
        {"from": "Acme <hello@acme.com>", "to": "delivered+bob@simulator.zapsmtp.com", "subject": "Hi Bob", "text": "..."},
    ],
    validation="permissive",
    idempotency_key="digest-2026-10-26-chunk-1",
)
for err in result.errors:
    print(err.index, err.code, err.message)
```

## Idempotency

A timeout does not tell you whether the email was accepted. Send `Idempotency-Key` (1–256
bytes) on `POST /emails` and `/emails/batch`; a repeat within **24 hours** returns the first
result instead of sending again. Keys are scoped to the API key.

- Same key, same body, finished → the original status and body, header `Idempotent-Replayed: true`.
- Same key, different body → `409 idempotency_key_reused`.
- First request still running → `409 idempotency_request_in_progress`: wait briefly, retry.
- First request got `429` or `5xx` → key released; retrying with it is processed as new.
- `422`/`403` from the send are stored under the key: after fixing the request, use a new key.

The SDKs add a random key to every send, so their own retries never duplicate. **Pass your own
key derived from your record** (`order-1042-receipt`) so retries of *your* job are safe too:
`{ idempotencyKey }` (Node), `idempotency_key=` (Python), `zapsmtp.WithIdempotencyKey` (Go).

## The response: what to store and do

| Field | Meaning | Do |
|---|---|---|
| `id` | The email, UUIDv7; part of its `Message-ID` | Store it with your record; webhooks carry it as `data.email_id` |
| `thread_id` | The conversation; replies carry the same id | Store it if you handle replies |
| `suppressed` | Recipients skipped: on your suppression list (each gets `email.suppressed`) | Do not retry. If every recipient is suppressed the request still succeeds |
| `failed_recipients` | Recipients the mail server refused while it took the others; not sent, not charged | Fix or drop those addresses; do not resend to the others |
| `unconfirmed: true` | Handed over but the confirmation was lost; **counts as sent** | Never retry; its events tell the outcome |
| `reply_to` | With reply tracking: the tracked Reply-To the email carries | Informational |

`200` means accepted, not delivered: outcomes arrive by webhook (`zapsmtp-webhooks`) or
`GET /emails/{id}` (per-recipient status, the receiving server's reply, the full timeline).

## Errors and retries

| Error | Action |
|---|---|
| `429 rate_limit_exceeded`, `429 overloaded`, `500`, `503`, no response | Retry with the same key, waiting `Retry-After` (SDKs do this twice by default) |
| `409 idempotency_request_in_progress` | Retry after a short pause |
| `429 monthly_quota_exceeded` | Stop: plan or spending cap reached |
| `429 daily_quota_exceeded` | Wait for 00:00 UTC |
| `403 domain_not_verified` | Verify the exact From domain (`zapsmtp-email-best-practices`) or use a test key |
| `403 restricted_api_key` | The key is limited to another domain/stream or to sending |
| `422 invalid_parameter` / `missing_required_field` / `invalid_attachment` / `template_*` | Fix the request; never retry unchanged |
| `400 validation_error` | Malformed JSON or an unknown field name |

```ts
import { ZapSMTP, RateLimitError, ValidationError, PermissionError } from 'zapsmtp';

const zap = new ZapSMTP({ maxRetries: 4 });
try {
  await zap.emails.send({ from: 'Acme <hello@acme.com>', to: 'delivered@simulator.zapsmtp.com',
    subject: 'Hi', text: 'Hello' }, { idempotencyKey: 'welcome-user-42' });
} catch (err) {
  if (err instanceof ValidationError) console.error('fix the request:', err.code, err.message);
  else if (err instanceof PermissionError) console.error('key or domain:', err.code);
  else if (err instanceof RateLimitError) console.error('still limited; retry in', err.retryAfter, 's');
  else throw err; // ServerError / ConnectionError after retries: re-queue with the same key
}
```

Responses to immediate sends usually carry `RateLimit-Limit`, `RateLimit-Remaining`,
`RateLimit-Reset` and `Zap-Quota-Monthly-Limit` / `Zap-Quota-Monthly-Remaining`; read them with
`.withResponse()` (Node), `client.emails.with_response.send(...)` (Python) or
`zapsmtp.WithResponse(&resp)` (Go). The per-second limit counts recipients across all requests.

## Test keys and the simulator

`zap_test_` keys run validation, the email log, events and webhooks exactly like live keys,
accept any From domain, deliver nothing and are not charged. Addresses at
`simulator.zapsmtp.com` act out outcomes with live and test keys alike, accept `+labels`, and
never touch your suppressions or reputation:

| Address | Result |
|---|---|
| `delivered@` | `email.delivered` (250) |
| `bounced@` | `email.bounced`, 550 5.1.1 `MailboxDoesNotExist` |
| `full@` | `email.bounced`, 552 5.2.2 `MailboxFull` |
| `blocked@` | `email.bounced`, 554 5.7.1 `SpamBlocked` |
| `delayed@` | `email.delivery_delayed`, then `email.delivered` about 20 s later |
| `complained@` | `email.delivered`, then `email.complained` |
| `suppressed@` | `email.suppressed` (treated as on your list) |
| `bounce+<code>[+<x.y.z>][+<words-with-dashes>]@` | any reply, e.g. `bounce+421+4.7.0+try-later@` → `email.delivery_delayed` |

## Sending by template

```ts
import { ZapSMTP } from 'zapsmtp';

const zap = new ZapSMTP();
await zap.emails.send({
  to: 'delivered@simulator.zapsmtp.com',          // from and subject come from the template
  template: { id: 'receipt', variables: { order_id: 'A-1042', total: '$113.00' } },
});
```

`template.id` takes the template id or its alias; sends use the **published** version.
`template` cannot be combined with `html`/`text` (`422 invalid_parameter`); a request `from` or
`subject` overrides the template's (the subject is used as written, not rendered). Missing or
wrongly typed variables fail the send (`template_variables_missing`,
`template_variables_invalid`, `template_render_error`). Details: `zapsmtp-templates`.

## Checklist

- Key from `ZAP_API_KEY`, base URL from `ZAP_BASE_URL`; server-side only.
- Exact From domain verified for live keys.
- One recipient per email for broadcast and personalised mail; batches of ≤ 100.
- Your own `Idempotency-Key` per logical email; reuse it on every retry of that email.
- Store `id`; handle `suppressed`, `failed_recipients` and `unconfirmed`; read batch `errors`.
- Retry only 429/5xx/network/in-progress; never retry 4xx unchanged.
- Delivery results via webhooks, not by polling.
