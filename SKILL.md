---
name: zapsmtp
description: Use when code sends, receives or tracks email through ZapSMTP (zapsmtp.com), or when a project mentions ZapSMTP, ZAP_API_KEY, zap_ / zap_test_ keys, the zapsmtp SDK (npm, PyPI, Go), Zap-Signature webhooks or *.zapsmtp.com hosts. Routes to sub-skills for sending, webhooks, templates, inbound email, deliverability and migrating from Resend, SendGrid, Mailgun, Postmark or Amazon SES; covers keys, base URL, SDK install, error shape and retry rules.
license: MIT
metadata:
  author: zapsmtp
  version: "1.0.0"
---

# ZapSMTP

ZapSMTP is an email API and SMTP relay that sends, receives and tracks email: `POST /emails`
and `POST /emails/batch` with `from`, `to`, `reply_to`, `scheduled_at`, `tags` and an
`Idempotency-Key`, typed templates, signed and batched webhooks, click actions, inbound email
with conversations, and a delivery simulator.

## Sub-skills

| Task | Skill | Use when |
|---|---|---|
| Sending | `zapsmtp-send-email` | Any `POST /emails` or `POST /emails/batch`: fields, attachments, tags/metadata, streams, scheduling, idempotency, responses, errors and retries |
| Webhooks | `zapsmtp-webhooks` | Receiving delivery/engagement events: creating endpoints, `Zap-Signature` verification, batches, retries, dedupe, replay, click actions |
| Templates | `zapsmtp-templates` | Stored Mustache templates: syntax, variable schema, global variables, drafts/publish, versions, aliases, previews, sending by template |
| Inbound | `zapsmtp-inbound` | Receiving email: inbound domains and MX, routes, `email.received`, bodies and attachments, conversations, replying, reply tracking, spam |
| Deliverability | `zapsmtp-email-best-practices` | DKIM/SPF/DMARC, Gmail/Yahoo/Microsoft rules, unsubscribe, suppressions, warm-up, testing, monitoring |
| Migration | `zapsmtp-migrate` | Moving from Resend, SendGrid, Mailgun, Postmark or Amazon SES |

Delivery events (`email.sent` … `email.replied`) and inbound events (`email.received`,
`thread.created`, `thread.replied`) share one webhook system: the same endpoints, signature,
retry schedule and `Zap-Event-Id` dedupe. Inbound events have no top-level `id`.

## Quick routing

- "Send an email / a receipt / a password reset" → `zapsmtp-send-email`
- "Send to many people", "newsletter", "batch" → `zapsmtp-send-email` (batch, `broadcast` stream)
- "Attach a PDF", "inline image", "schedule for tomorrow 9:00" → `zapsmtp-send-email`
- "Retry safely", "429", "send exactly once" → `zapsmtp-send-email` (idempotency, retries)
- "Handle bounces / track delivery / opens / clicks" → `zapsmtp-webhooks`
- "Verify the webhook signature", "webhook returns 400" → `zapsmtp-webhooks`
- "Know which button was clicked" → `zapsmtp-webhooks` (click actions)
- "Create / edit / publish a template", "template variable missing" → `zapsmtp-templates`
- "Receive email", "support inbox", "reply by email", "parse replies" → `zapsmtp-inbound`
- "Set up DNS / DKIM / SPF / DMARC", "mail goes to spam", "warm up" → `zapsmtp-email-best-practices`
- "Test without sending real email" → `zapsmtp-send-email` (test keys) and `zapsmtp-email-best-practices` (simulator)
- "Switch from Resend / SendGrid / Mailgun / Postmark / SES" → `zapsmtp-migrate`

## Base URL

Every path in these skills is relative to the API base URL, which ends in `/v1`.

- Production: **`https://api.zapsmtp.com/v1`**, the SDKs' default.
- The SDKs read **`ZAP_BASE_URL`**; set it only for another environment your ZapSMTP docs or
  dashboard show.
- SMTP relay host: `mail.zapsmtp.com`, ports `587`/`2525` (STARTTLS) or `465` (TLS).

Configure both through the environment, never in code:

<!-- check: skip (environment variables) -->
```bash
export ZAP_API_KEY=zap_test_...                  # server-side secret
export ZAP_BASE_URL=https://api.zapsmtp.com/v1   # the default; another environment's URL here
```

## Authentication and keys

`Authorization: Bearer <key>`; JSON in and out. The full key is shown once when created.

| Key | Behaviour |
|---|---|
| `zap_…` (live) | Delivers email. The From domain must be verified in the account (`403 domain_not_verified`). |
| `zap_test_…` (test) | Full validation, email log, events and webhooks, but **nothing is delivered** and the monthly quota is not charged (the per-second limit still applies). Any From domain. Events carry `test: true`; list with `GET /emails?mode=test`. Test keys may send, read and render templates; anything that changes the account (domains, webhooks, templates, suppressions, keys, inbound setup) returns `403 test_key_restricted`. |
| `full_access` | Every endpoint. |
| `sending_access` | Only `POST /emails`, `/emails/batch`, `/emails/spam-check`, rescheduling and canceling. Can be limited to one domain and one stream (`403 restricted_api_key` otherwise). |

Rules for agents:

- Keep keys on the server. Never put a ZapSMTP key in browser, mobile or other client code, in
  a repository, or in logs. Read it from `ZAP_API_KEY`.
- Develop and test with a `zap_test_` key; switch to a live key only in production config.
- Give each service its own `sending_access` key, restricted to its domain and stream.

## SDKs

| Language | Install | Client |
|---|---|---|
| Node.js 18+ (also Bun, Deno) | `npm install zapsmtp` | `new ZapSMTP()` |
| Python 3.9+ | `pip install zapsmtp` | `ZapSMTP()` / `AsyncZapSMTP()` |
| Go 1.23+ | `go get github.com/zapsmtp/zapsmtp-go` | `zapsmtp.NewClient("")` |
| PHP 8.1+ | `composer require zapsmtp/zapsmtp-php` | |
| Laravel 10–12 | `composer require zapsmtp/zapsmtp-laravel` | |
| Ruby 3.0+ | `gem install zapsmtp` | |
| Java 11+ | `com.zapsmtp:zapsmtp-java` | |
| .NET 8 / .NET Standard 2.0 | `dotnet add package ZapSMTP` | |

The docs say the packages are being published to their registries. If the install fails, call
the HTTP API directly (every example here has a cURL form) or use the OpenAPI 3.1 description
(`https://zapsmtp.com/openapi.json`). Every SDK reads `ZAP_API_KEY` and `ZAP_BASE_URL`, retries
safely (twice by default), adds an `Idempotency-Key` to every send, walks every page of a list,
raises typed errors and verifies webhook signatures.

<!-- check: skip (package manager commands) -->
```bash
npm install zapsmtp
pip install zapsmtp
go get github.com/zapsmtp/zapsmtp-go
```

### First send

```ts
import { ZapSMTP } from 'zapsmtp';

const zap = new ZapSMTP(); // reads ZAP_API_KEY and ZAP_BASE_URL

const { id } = await zap.emails.send({
  from: 'Acme <hello@acme.com>',
  to: 'delivered@simulator.zapsmtp.com',
  subject: 'Hello from ZapSMTP',
  html: '<p>It works.</p>',
});
console.log(id); // store it: delivery webhooks carry it as data.email_id
```

```python
from zapsmtp import ZapSMTP

client = ZapSMTP()  # reads ZAP_API_KEY and ZAP_BASE_URL

email = client.emails.send(
    from_="Acme <hello@acme.com>",  # `from` is a Python keyword: the SDK sends it as "from"
    to="delivered@simulator.zapsmtp.com",
    subject="Hello from ZapSMTP",
    html="<p>It works.</p>",
)
print(email.id)
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
	client := zapsmtp.NewClient("") // "" reads ZAP_API_KEY; ZAP_BASE_URL is read too
	sent, err := client.Emails.Send(context.Background(), &zapsmtp.SendEmailParams{
		From:    zapsmtp.String("Acme <hello@acme.com>"),
		To:      []string{"delivered@simulator.zapsmtp.com"},
		Subject: zapsmtp.String("Hello from ZapSMTP"),
		HTML:    zapsmtp.String("<p>It works.</p>"),
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(sent.ID)
}
```

```bash
curl -X POST "$ZAP_BASE_URL/emails" \
  -H "Authorization: Bearer $ZAP_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "Acme <hello@acme.com>",
    "to": "delivered@simulator.zapsmtp.com",
    "subject": "Hello from ZapSMTP",
    "html": "<p>It works.</p>"
  }'
```

A `200` means **accepted**, not delivered: the outcome arrives by webhook
(`zapsmtp-webhooks`) or `GET /emails/{id}`.

## Conventions every endpoint shares

- **Unknown fields are rejected** with `400 validation_error`: a misspelled field never passes
  silently. Send only documented field names.
- Ids are time-ordered UUIDv7 strings; timestamps are RFC 3339 in UTC.
- Request body limit: 40 MB, attachments included (`413 payload_too_large`).
- Lists return `{"object": "list", "has_more": …, "data": [...]}`. `GET /emails` and
  `GET /emails/receiving` page with `limit` (1–100, default 20) and `before`/`after` (an id or
  RFC 3339 time); `GET /suppressions` pages with `next_cursor` passed back as `after`
  (`limit` 1–1000, default 100). Most other lists return everything in one response. SDK list
  methods return one page; iterate them (`for await`, `for`, `ListAutoPaging`) to walk all pages.
- Every response has `X-Request-Id`: log it, and quote it to support.

## Errors

Every error carries a flat shape (`statusCode`, `name`, `message`) and a nested one; `name` equals
`error.code`:

```json
{
  "statusCode": 422,
  "name": "missing_required_field",
  "message": "subject is required",
  "error": { "code": "missing_required_field", "message": "subject is required", "type": "invalid_request_error" }
}
```

Branch on the code (`name`), never on the message text. All codes:
[references/errors.md](references/errors.md).

### Retry or not

| Answer | Retry? |
|---|---|
| `429 rate_limit_exceeded` | Yes, after `Retry-After` (1 s). |
| `429 overloaded` | Yes, after `Retry-After` (1 or 5 s). Nothing was sent. |
| `500 internal_error`, `503 service_unavailable` | Yes, with backoff (`Retry-After` 2–5 s on 503), same `Idempotency-Key`. |
| `409 idempotency_request_in_progress` | Yes, after a short pause. |
| No response (network error, timeout) | Yes, with the **same** `Idempotency-Key`: you cannot tell whether it was accepted. |
| `429 daily_quota_exceeded` | Not until 00:00 UTC (Free plan: 100 a day). |
| `429 monthly_quota_exceeded` | No: plan or spending cap reached for the month. |
| `429 thread_reply_limit` | Not for an hour (`Retry-After: 3600`): a loop guard on replies. |
| `421 misdirected_cell` | Not here: send to the URL named in the message (`Zap-Cell` header names the cell). |
| `409 idempotency_key_reused` | No: same key, different body. Fix the key. |
| Other `400`, `401`, `403`, `404`, `413`, `422` | No: the request must change. |

The SDKs already retry network errors, 408, 429 (`rate_limit_exceeded`, `overloaded`), 409
`idempotency_request_in_progress`, 500, 502, 503 and 504 twice, honouring `Retry-After` up to
60 s (else exponential backoff from 0.5 s, capped at 8 s), and never retry quota errors. They
retry only what is safe to repeat: reads, `PUT`, `DELETE` and sends (which carry an
`Idempotency-Key`); other `POST`/`PATCH` calls only on 429. Error classes: `AuthenticationError` (401), `PermissionError` (403),
`NotFoundError` (404), `ConflictError` (409), `ValidationError` (400, 413, 422),
`RateLimitError` (429, with `retryAfter` / `retry_after`), `ServerError` (5xx),
`ConnectionError` (no answer); Go uses one `*zapsmtp.Error` with `zapsmtp.IsRateLimit(err)` and
friends.

## Rate limits and quotas

Immediate sends usually return `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`
(recipients per second, refilled every second) and `Zap-Quota-Monthly-Limit` /
`Zap-Quota-Monthly-Remaining` (`unlimited`, with no Remaining header, on paid plans without a
spending cap). Scheduled sends, and accounts without a per-second limit, carry none of these.
The per-second limit counts recipients across all your requests: pace bursts with
`RateLimit-Remaining` instead of waiting for `429`s.

| Limit | Value |
|---|---|
| Recipients per email (`to` + `cc` + `bcc`) | 50 |
| Emails per batch | 100 |
| Request size | 40 MB, attachments included |
| Free plan | 3,000 emails a month, at most 100 a day |
| Spam checks | 30 a minute per account |

## Resources

- Docs: https://zapsmtp.com/docs/ (every page also as Markdown, e.g.
  https://zapsmtp.com/docs/sending.md or https://zapsmtp.com/docs/emails/send-email.md); index
  for agents: https://zapsmtp.com/llms.txt, everything in one file: https://zapsmtp.com/llms-full.txt
- OpenAPI 3.1: https://zapsmtp.com/openapi.json
- SDK guide: https://zapsmtp.com/docs/sdks.md
