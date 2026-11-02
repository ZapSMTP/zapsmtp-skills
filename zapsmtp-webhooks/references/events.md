# ZapSMTP webhook payloads

Source: https://zapsmtp.com/docs/webhook-events.md, click-actions.md, inbound-guide.md.
Every request body is one event (or, with `batch: true`, a JSON array of events):

```json
{
  "id": "evt_5f0c2a9b7d1e4c3a8b6f2e10",
  "type": "email.bounced",
  "created_at": "2026-10-21T15:04:12.381Z",
  "data": {
    "email_id": "019a1f2e-7c3b-7d41-9a52-0c4b8e6f1a23",
    "from": "Acme <hello@acme.com>",
    "to": "jane@example.org",
    "subject": "Your receipt",
    "tags": { "category": "receipt" },
    "metadata": { "order_id": "A-1042" },
    "stream": "transactional",
    "thread_id": "3f1c9a52-6b0e-5d4f-8a71-2c9e0b4d6f13",
    "attempts": 1,
    "response": { "code": 550, "message": "5.1.1 The email account that you tried to reach does not exist" },
    "bounce": {
      "type": "Permanent",
      "subType": "MailboxDoesNotExist",
      "message": "5.1.1 The email account that you tried to reach does not exist",
      "suppressed": true
    }
  }
}
```

## Delivery and engagement events: `data`

| Field | On | Meaning |
|---|---|---|
| `email_id` | all | The id returned by the send |
| `from`, `subject` | all (click events: `from` holds only the sending domain, e.g. `<@acme.com>`, and there is no `subject`) | |
| `to` | all | **One** recipient address per event |
| `tags` | all delivery events; `email.opened`/`email.clicked` only when the encoded tags fit in 200 bytes | Object `{name: value}` |
| `metadata` | all delivery events; opens/clicks only when its JSON fits in 200 bytes; **not** on reply events | Your send's metadata |
| `stream` | | `transactional` or `broadcast` |
| `thread_id` | | The conversation |
| `attempts`, `response` | delivery attempts | `response: {code, message}`: the receiving server's reply |
| `bounce` | `email.bounced`, `email.delivery_delayed`, `email.failed`, `email.suppressed` | `{type, subType, message, suppressed}` |
| `tls` | when the attempt used TLS | `{version, cipher}`, e.g. `TLSv1_3` |
| `open` | `email.opened` | `{ip_address, user_agent, machine}`; `machine: true` when Apple Mail Privacy Protection loaded the pixel |
| `click` | `email.clicked` | `{link, action, unique, ip_address, user_agent}` (`action` absent for links without one; `unique` always present) |
| `reply` | `email.replied` | See below |
| `test` | | `true` for events of test keys |

`bounce.type`: `Permanent`, `Transient` or `Undetermined`. `bounce.subType`:
`MailboxDoesNotExist`, `DomainDoesNotExist`, `MailboxInactive` (these suppress the address),
`MailboxFull`, `MessageTooLarge`, `ContentRejected`, `AttachmentRejected`, `SpamBlocked`,
`IPBlocked`, `PolicyRejected`, `RelayDenied`, `DNSFailure`, `ConnectionFailed`, `Expired`,
`Suppressed`, `AutoReply`, `General`. `bounce.suppressed` tells whether the address was added to
your suppressions. Sender-side rejections (`SpamBlocked`, `IPBlocked`, `PolicyRejected`) never
suppress the recipient.

### `email.clicked`

```json
{
  "id": "evt_7a1d0c3e9b2f4a6c8e5d1b07",
  "type": "email.clicked",
  "created_at": "2026-10-27T08:41:05.214Z",
  "data": {
    "email_id": "019a1f2e-7c3b-7d41-9a52-0c4b8e6f1a23",
    "from": "<@acme.com>",
    "to": "jane@example.org",
    "tags": { "category": "receipt" },
    "metadata": { "order_id": "A-1042" },
    "stream": "transactional",
    "click": {
      "link": "https://acme.com/orders/A-1042/confirm",
      "action": "confirm_order",
      "unique": true,
      "ip_address": "203.0.113.24",
      "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"
    }
  }
}
```

### `email.replied` (reply tracking)

`data` has the usual email fields (`email_id` is the email that was answered, `from`,
`subject`, `tags`) and `to` names the replier only when they were one of the email's To/Cc
recipients (otherwise empty). `data.reply`:

| Field | Meaning |
|---|---|
| `email_id` | The received reply: `GET /emails/receiving/{id}` |
| `from`, `from_name`, `subject` | Of the reply |
| `text` | The reply without the quoted email, at most 2,000 characters |
| `type` | `human`, `unsubscribe`, `out_of_office`, `auto_reply`, `auto_generated`, `bounce`, `bulk` |
| `is_spam` | Spam verdict |
| `sender_matches_recipient` | The replier was one of the email's To or Cc recipients |
| `forward` | `{to, status, reason}`: `status` `queued` or `skipped`; `reason` `spam`, `automated`, `unsubscribe`, `not_allowed`, `no_destination` |

A reply of type `unsubscribe` is reported, not applied: add the address to suppressions yourself.

## Inbound events

No top-level `id` (dedupe on `Zap-Event-Id`; in a batch on `type` + `data.email_id`).

`email.received` `data`: `email_id`, `created_at`, `from`, `from_name`, `to`, `cc`, `bcc`
(always empty), `reply_to`, `received_for`, `message_id`, `subject`, `attachments` (metadata:
`id`, `filename`, `content_type`, `content_disposition`, `content_id`, `size`), `envelope`
(`from`, `to`), `mailbox_hash`, `reply_text`, `in_reply_to_email_id`, `thread_id`, `automated`
(`null` or `{type, reason}`), `authentication` (`spf`, `dkim`, `dmarc`, `arc`), `spam`
(`score`, `is_spam`), `route_id`, `size`. With `include_content`: also `text`, `html`,
`headers`, `truncated`, attachment `download_url`/`expires_at` (24 hours), `raw.download_url`,
and `content_error` when the message could not be read at delivery time.

`thread.created` / `thread.replied` `data`: `thread_id`, `email_id`, `created_at`, `from`,
`from_name`, `to`, `subject`, `received_for`, `mailbox_hash`, `reply_text`,
`in_reply_to_email_id`, `automated`.

Details and examples: `zapsmtp-inbound`.

## Event to status

| Event | Email log status | Timeline `type` | Ends delivery |
|---|---|---|---|
| `email.sent` | `queued` | `Reception` | No |
| `email.delivery_delayed` | `delivery_delayed` | `TransientFailure` | No |
| `email.delivered` | `delivered` | `Delivery` | Yes |
| `email.bounced` | `bounced` | `Bounce`, `Expiration`, `OOB`, `AdminBounce` | Yes |
| `email.failed` | `failed` | `Rejection` | Yes |
| `email.suppressed` | `suppressed` | `Suppressed` | Yes |
| `email.complained` | `complained` | `Feedback` | After delivery |
| `email.opened` | `opened` | `Open` | After delivery |
| `email.clicked` | `clicked` | `Click` | After delivery |
| `email.replied` | `replied` | | After delivery |

After `delivered` a late `bounced` can still arrive (an out-of-band bounce email).

## More events (2026-11)

| Type | When | `data` |
|---|---|---|
| `email.opened_unique` | The first open of an email by its recipient | As `email.opened`; sent once. Not in the default list: choose it |
| `email.clicked_unique` | The first click in an email by its recipient (any link) | As `email.clicked`; sent once. Not in the default list |
| `email.unsubscribed` | A recipient unsubscribed (link or one-click); now suppressed | `email_id`, `to`, `tags`, `metadata`, `stream` |
| `email.forward_failed` | A received email could not be forwarded | `email_id` (received), `to`, `forward_id`, `reason` (`destination`, `gone`, `loop`, `seal`, `retries`), `error` |
| `domain.verified` | A sending domain passed verification the first time | `domain_id`, `domain`, `dkim_verified`, `spf_verified`, `dmarc_verified` |
| `domain.reputation_changed` | A sending domain was listed on / removed from a blocklist | `domain_id`, `domain`, `list`, `listed`, `severity`, `removal_url` |
| `email.scheduled` | An email was scheduled (or moved) for later, per recipient | `email_id`, `from`, `to`, `subject`, `tags`, `metadata`, `stream`, `scheduled_at` |
| `suppression.added` | An address went on the suppression list | `email`, `reason` (`hard_bounce`, `complaint`, `unsubscribe`, `manual`), `source_id` |
| `suppression.removed` | An address came off the suppression list | `email` |
| `domain.created` / `domain.deleted` | A sending domain was added / removed | `domain_id`, `domain` |

`email.complained` carries `complaint`: `type` (the ARF feedback type, `abuse` …) and `source`
(the mailbox provider's feedback loop that reported it).

`filter.domains` narrows an endpoint to some domains: the From domain of sent mail, the
receiving domain of received mail, the domain of `domain.*` events. `PATCH` keeps a filter list
it does not name. An endpoint disabled automatically (5 events out of retries in 24 h) is
reported by email to the account's owners and admins.
