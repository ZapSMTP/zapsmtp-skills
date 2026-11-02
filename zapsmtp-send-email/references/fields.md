# POST /emails: every field, limit and error

Source: https://zapsmtp.com/docs/emails/send-email.md and https://zapsmtp.com/docs/sending.md.
Unknown fields are rejected (`400 validation_error`).

## Request headers

| Header | Rule |
|---|---|
| `Authorization` | `Bearer <key>`: full-access or sending-access key |
| `Content-Type` | `application/json` |
| `Idempotency-Key` | Optional, 1–256 bytes (`400 invalid_idempotency_key` when longer); kept 24 h per API key |
| `x-batch-validation` | Batch only: `strict` (default) or `permissive`, case-insensitive; anything else → `400 validation_error` |

## Body fields

| Field | Type | Rules and errors |
|---|---|---|
| `from` | string | RFC 5322 address. Live keys: domain verified in the account, exact name (`403 domain_not_verified`). Bare address → the domain's brand `from_name` is the display name. May be omitted when the template defines `from`. Missing → `422 missing_required_field`; unparsable → `422 invalid_parameter` "invalid from address". |
| `to` | string \| string[] | Required, at least one; each must parse (`422 invalid_parameter` "invalid to address …"). |
| `cc`, `bcc` | string \| string[] | Bcc is never written into headers. |
| `reply_to` | string \| string[] | Replaced by the tracked address when reply tracking is on. |
| (recipients) | | At most 50 across `to` + `cc` + `bcc` ("too many recipients (max 50)"); lowercased, deduplicated. |
| `subject` | string | Required unless the template has one; blank → `422 missing_required_field`. With a template it overrides the template's subject and is not rendered. |
| `html` | string | At least one of `html`/`text` (unless `template`): "html or text is required". Cannot be combined with `template` (`422 invalid_parameter`). |
| `text` | string | Generated from `html` when omitted. |
| `headers` | object of strings | Reserved headers → `422 invalid_parameter` "header … cannot be set" (list below). Names: printable ASCII without spaces or `:`. |
| `attachments` | object[] | See below. `422 invalid_attachment`. |
| `tags` | `{name, value}[]` | At most 20; both match `^[A-Za-z0-9_-]{1,256}$`. |
| `metadata` | object of strings | At most 10 keys `^[A-Za-z0-9_-]{1,40}$`; values ≤ 500 bytes UTF-8. |
| `scheduled_at` | string | RFC 3339, or `in <n> <unit>` (unit `min`, `mins`, `minute`, `minutes`, `h`, `hour`, `hours`, `d`, `day`, `days`). Past → sent now. Unparsable → 422; > 7 days → "scheduled_at must be within 7 days". At most 10,000 emails / 256 MB waiting per account. |
| `stream` | `transactional` \| `broadcast` | Default `transactional` (or the key's stream). Other values → 422; conflicting with the key's stream → `403 restricted_api_key`. |
| `tracking` | object | `opens`, `clicks`, `replies` (booleans) override the From domain's defaults. `replies: true` without a reply domain on the sending domain → `422 invalid_parameter`. |
| `template` | object | `id` (template id or alias, required: "template.id is required") and `variables`. Must be published. See `zapsmtp-templates`. |
| `tls` | `required` \| `verified` | Raises the domain's TLS policy for this email, never lowers it. |

### Attachment object

| Field | Rule |
|---|---|
| `filename` | Required ("filename is required"), except with `path` (then the URL's last segment). |
| `content` | Standard base64 with padding ("content must be base64"). |
| `path` | `http(s)` URL downloaded at send time; must answer 200 within 20 s; private/internal addresses refused ("path must be an http(s) URL", "fetching path returned HTTP <n>"). |
| `content_type` | Optional; from the file extension, or the server's `Content-Type` for `path`. |
| `content_id` | Inline: reference as `cid:<content_id>` in the HTML; in an email without `html` it is an ordinary attachment. |

Exactly one of `content` and `path` ("set either content or path, not both", "content or path
is required"). Total 40 MB per request ("attachments exceed 40MB in total"). Sent attachments
can be read back with `GET /emails/{id}/attachments` (download links valid one hour).

### Headers that cannot be set

`From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Date`, `Message-ID`, `MIME-Version`,
`Content-Type`, `Content-Transfer-Encoding`, `DKIM-Signature`, `Return-Path`, `Received`,
`Sender`, `Authentication-Results`, `ARC-Seal`, `ARC-Message-Signature`,
`ARC-Authentication-Results`, `Received-SPF`, `Resent-*`, `X-ZapRef`, and any `X-Zap-*`.

## Responses

`200`:

```json
{
  "id": "019a1f2e-7c3b-7d41-9a52-0c4b8e6f1a23",
  "thread_id": "3f1c9a52-6b0e-5d4f-8a71-2c9e0b4d6f13"
}
```

Optional fields: `suppressed` (string[]), `failed_recipients` (string[]), `unconfirmed`
(true), `reply_to` (reply tracking).

Batch `200`:

```json
{
  "data": [
    { "index": 0, "id": "019a1f2e-7c3b-7d41-9a52-0c4b8e6f1a23" },
    { "index": 2, "id": "019a1f2e-7c3c-7a10-8b21-4d5e6f7a8b9c", "suppressed": ["suppressed@simulator.zapsmtp.com"] }
  ],
  "errors": [
    { "index": 1, "code": "missing_required_field", "message": "subject is required" }
  ]
}
```

Batch errors: `400 validation_error` (invalid JSON, bad `x-batch-validation`),
`422 invalid_parameter` "batch must contain 1 to 100 emails", strict mode
`422 validation_error` with `errors[]`.

## Errors of POST /emails

| Code | HTTP |
|---|---|
| `validation_error` (invalid JSON / unknown field), `invalid_idempotency_key` | 400 |
| `domain_not_verified`, `restricted_api_key`, `account_suspended`, `account_closing` | 403 |
| `idempotency_key_reused`, `idempotency_request_in_progress` | 409 |
| `payload_too_large` (over 40 MB) | 413 |
| `misdirected_cell` | 421 |
| `missing_required_field`, `invalid_parameter`, `invalid_attachment`, `template_render_error`, `template_variables_invalid`, `template_variables_missing`, `rejected` | 422 |
| `rate_limit_exceeded`, `monthly_quota_exceeded`, `daily_quota_exceeded`, `overloaded` | 429 |
| `service_unavailable` | 503 |

## Related endpoints

| Endpoint | Purpose |
|---|---|
| `GET /emails` | List, newest first: `limit` (1–100), `before`/`after`, `status`, `q`, `days` (1–90, default 30), `stream`, `mode` (`live`/`test`), `metadata[<key>]` |
| `GET /emails/{id}` | Per-recipient status, the receiving server's reply, the event timeline |
| `GET /emails/{id}/content` | Archived HTML/text/raw within the plan's log retention |
| `GET /emails/{id}/attachments`, `GET /emails/{id}/attachments/{aid}` | Sent attachments with one-hour download links |
| `PATCH /emails/{id}` | Reschedule (`scheduled_at` only) |
| `POST /emails/{id}/cancel` | Cancel a scheduled email |
| `POST /emails/spam-check` | Score a draft (`from`, `to`, `subject`, `html`, `text`, `stream` only); nothing is sent |
| `POST /emails/{id}/spam-check` | Score a sent email |

Email statuses: `queued`, `delivered`, `delivery_delayed`, `bounced`, `complained`, `failed`,
`opened`, `clicked`, `replied`, `suppressed`; scheduled emails show `scheduled` or `canceled`.
A status is the recipient's latest event, not the best one.
