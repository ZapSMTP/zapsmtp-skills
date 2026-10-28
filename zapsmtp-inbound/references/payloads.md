# Inbound payloads and objects

Source: https://zapsmtp.com/docs/inbound-guide.md and the Received emails / Inbound setup API.

## `email.received`

```json
{
  "type": "email.received",
  "created_at": "2026-10-21T15:10:03.418Z",
  "data": {
    "email_id": "019a1f30-1d4e-7a6b-8c2d-3e4f5a6b7c8d",
    "created_at": "2026-10-21T15:10:02.904Z",
    "from": "jane@example.org",
    "from_name": "Jane Doe",
    "to": ["support+1234@acme.com"],
    "cc": [],
    "bcc": [],
    "reply_to": [],
    "received_for": ["support+1234@acme.com"],
    "message_id": "<CAF=abc123@mail.example.org>",
    "subject": "Re: Ticket #1234",
    "attachments": [
      { "id": "5b0f8f7e-2a1c-5d3e-9f4a-6b7c8d9e0f1a", "filename": "screenshot.png", "content_type": "image/png",
        "content_disposition": "attachment", "content_id": null, "size": 48213 }
    ],
    "envelope": { "from": "jane@example.org", "to": "support+1234@acme.com" },
    "mailbox_hash": "1234",
    "reply_text": "Thanks, that fixed it!",
    "in_reply_to_email_id": "019a1f2e-7c3b-7d41-9a52-0c4b8e6f1a23",
    "thread_id": "3f1c9a52-6b0e-5d4f-8a71-2c9e0b4d6f13",
    "automated": null,
    "authentication": { "spf": "pass", "dkim": "pass", "dmarc": "pass", "arc": "gray" },
    "spam": { "score": 1.2, "is_spam": false },
    "route_id": "019a1f31-0b2c-7d3e-8f4a-5b6c7d8e9f01",
    "size": 61877
  }
}
```

| Field | Meaning |
|---|---|
| `email_id` | The received email: `GET /emails/receiving/{id}` |
| `from`, `from_name` | The From header's address and display name |
| `to`, `cc`, `reply_to` | As written in the headers. `bcc` is always empty |
| `received_for` | Your address this copy was delivered to (may be absent from `to`: Bcc, lists) |
| `envelope` | SMTP envelope: `from` is the return path, `to` the receiving address |
| `mailbox_hash` | The part after `+` in the receiving address |
| `reply_text` | The new text only, without quote and signature (≤ 16 KB in the webhook) |
| `in_reply_to_email_id` | The email you sent through ZapSMTP that this answers, or `null` |
| `thread_id` | The conversation |
| `automated` | `null` when a person wrote it, else `{type, reason}` |
| `authentication` | `spf`, `dkim`, `dmarc`, `arc` verdicts |
| `spam` | `score`, `is_spam` |
| `attachments` | Every part that is not the text or HTML body, inline images included |
| `route_id`, `size` | The matching route (empty for none) and the size in bytes |

No top-level `id`: the event id is the `Zap-Event-Id` header, stable across retries.

### With `include_content: true`

Adds `text`, `html`, `headers` (lower-case names), `truncated` (text and HTML share 1 MB after
the headers), `download_url` and `expires_at` on each attachment (24 hours), `raw:
{download_url, expires_at}` (the original `.eml`), and `content_error` when the message could
not be read at delivery time (fetch it from the API instead). Such events always arrive alone,
even on a batch endpoint.

## `thread.created` / `thread.replied`

`thread.created`: a new conversation (a received email that answers nothing). `thread.replied`:
a customer answered in an existing one. Both skip bounces, out-of-office notices, auto-replies
and notifications, are not sent on redelivery, and go to the same endpoints as
`email.received` (none for `store`, `forward` or `reject` routes; only the route's endpoint for
a `webhook` route, if it subscribes).

```json
{
  "type": "thread.replied",
  "created_at": "2026-10-21T15:10:03.420Z",
  "data": {
    "thread_id": "3f1c9a52-6b0e-5d4f-8a71-2c9e0b4d6f13",
    "email_id": "019a1f30-1d4e-7a6b-8c2d-3e4f5a6b7c8d",
    "created_at": "2026-10-21T15:10:02.904Z",
    "from": "jane@example.org",
    "from_name": "Jane Doe",
    "to": ["support+1234@acme.com"],
    "subject": "Re: Ticket #1234",
    "received_for": ["support+1234@acme.com"],
    "mailbox_hash": "1234",
    "reply_text": "Thanks, that fixed it!",
    "in_reply_to_email_id": "019a1f2e-7c3b-7d41-9a52-0c4b8e6f1a23",
    "automated": null
  }
}
```

## Verdicts

`spf`, `dkim`, `dmarc`, `arc`:

| Value | Meaning |
|---|---|
| `pass` | Passed |
| `fail` | Failed (for DMARC: the sender's policy said reject, quarantine or fail) |
| `gray` | No verdict: SPF softfail/neutral, or nothing to check |
| `processing_failed` | A DNS error stopped the check |
| `unknown` | The message could not be scanned; accepted anyway |

A From address is only trustworthy when DMARC is `pass`. The API returns `arc` next to
`authentication`; the webhook has it inside.

`automated.type`: `bounce` (delivery status notification), `out_of_office`, `auto_reply`,
`auto_generated` (notifications, null envelope sender), `bulk` (mailing lists; may be answered
without `allow_automated`, and opens or continues conversations). `reason` names the evidence,
e.g. `Auto-Submitted: auto-replied`.

`spam.action` (API only): `no action`, `add header`, `rewrite subject`, `reject`, `unknown`.

## Received email (`GET /emails/receiving/{id}`)

`object`, `id`, `created_at`, `from`, `from_name`, `to`, `cc`, `bcc`, `reply_to`,
`received_for`, `subject`, `message_id`, `html`, `html_format` (`data_uri` | `cid`), `text`,
`headers`, `authentication`, `arc`, `raw` (`download_url`, `expires_at`: 1 hour), `attachments`,
`reply_text`, `mailbox_hash`, `in_reply_to_email_id`, `thread_id`, `automated`, `envelope`,
`spam` (`score`, `is_spam`, `action`), `route_id`, `action` (`default`, `webhook`, `store`,
`reject`, `spam_reject`), `status` (`received` | `rejected`), `size`, `tls`, `peer_ip`, `helo`.

## Thread (`GET /threads/{id}`)

`id`, `subject`, `participants`, `message_count`, `inbound_count`, `outbound_count`,
`has_attachments`, `first_message_at`, `last_message_at`, `last_inbound_at`, `last_message`
(`id`, `direction`, `from`, `subject`), `awaiting_reply`, `unread`, `read_at`, `metadata`, and
`data`: its emails oldest first, each with `direction` (`inbound` | `outbound`). Refused
messages are not part of a thread. Emails received before 2026-10-23 have a thread id but are
not listed.

## Endpoints

| Method | Path | SDK (Node) |
|---|---|---|
| `GET`/`POST` | `/inbound/domains` | `inbound.domains.list` / `create` |
| `GET`/`PATCH`/`DELETE` | `/inbound/domains/{id}` | `inbound.domains.get` / `update` / `delete` |
| `POST` | `/inbound/domains/{id}/verify` | `inbound.domains.verify` |
| `GET`/`POST` | `/inbound/routes` | `inbound.routes.list` / `create` |
| `GET`/`PATCH`/`DELETE` | `/inbound/routes/{id}` | `inbound.routes.get` / `update` / `delete` |
| `GET`/`POST` | `/inbound/forward-destinations` | `inbound.forwardDestinations.list` / `create` |
| `POST` | `/inbound/forward-destinations/{id}/resend` | `inbound.forwardDestinations.resendConfirmation` |
| `DELETE` | `/inbound/forward-destinations/{id}` | `inbound.forwardDestinations.delete` |
| `GET` | `/inbound/stats` | `inbound.getStats` (last 24 hours) |
| `GET` | `/emails/receiving` | `emails.receiving.list` |
| `GET`/`DELETE` | `/emails/receiving/{id}` | `emails.receiving.get` / `delete` |
| `GET` | `/emails/receiving/{id}/attachments` | `emails.receiving.attachments.list` |
| `GET` | `/emails/receiving/{id}/attachments/{aid}` | `emails.receiving.attachments.get` |
| `POST` | `/emails/receiving/{id}/reply` | `emails.receiving.reply` |
| `POST` | `/emails/receiving/{id}/spam` | `emails.receiving.reportSpam` |
| `POST` | `/emails/receiving/{id}/redeliver` | `emails.receiving.redeliver` |
| `GET` | `/threads` | `threads.list` |
| `GET`/`PATCH` | `/threads/{id}` | `threads.get` / `update` |

Route errors: `422 invalid_parameter` ("action must be webhook, store, reject or forward",
"webhook_id is required for action webhook", "forward_id … is not confirmed yet", "at most 100
routes per account"). Forward destinations: `409 conflict`, `422 limit_exceeded` (20),
`429 rate_limit_exceeded` (at most 20 added a day), `503 service_unavailable` (added, but the
confirmation email could not be sent: resend it).
