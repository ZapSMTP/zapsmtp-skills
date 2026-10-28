# ZapSMTP error codes

Every error body: `{"statusCode", "name", "message", "error": {"code", "message", "type"}}`;
`name` equals `error.code`. Branch on the code. Every response carries `X-Request-Id`.

| Code | HTTP | Meaning | Retry |
|---|---|---|---|
| `validation_error` | 400 | Malformed JSON or a field the endpoint does not know (unknown fields are always rejected). In a strict batch: 422 with an `errors` array. | No |
| `invalid_idempotency_key` | 400 | `Idempotency-Key` longer than 256 bytes. | No |
| `missing_api_key` | 401 | No `Authorization` header. | No |
| `invalid_api_key` | 401 | Unknown, revoked or expired key. | No |
| `restricted_api_key` | 403 | The key has sending access only, or is limited to another domain or stream. | No |
| `domain_not_verified` | 403 | A live key sends from a domain not verified in the account (exact name: a subdomain is a separate domain). | No |
| `account_suspended` | 403 | The account is suspended. | No |
| `plan_limit_reached` | 403 | The plan's limit for domains or SMTP credentials is reached. | No |
| `test_key_restricted` | 403 | A `zap_test_` key tried to change the account. Test keys may send test email, render templates and read. | No |
| `key_restricted` | 403 | A restricted key creating or changing keys tried to give them more than it has (a later expiry, another stream). | No |
| `email_unverified` | 403 | Confirm the account email address first. | No |
| `session_required` | 403 | Team and account management needs a dashboard session, not an API key. | No |
| `not_found` | 404 | No such resource in the account (or past the plan's log retention). | No |
| `method_not_allowed` | 405 | The path exists, not with this method. | No |
| `idempotency_key_reused` | 409 | The `Idempotency-Key` was used with a different body. | No: fix the key |
| `idempotency_request_in_progress` | 409 | The first request with this key is still running. | Yes, after a short pause |
| `not_cancellable` | 409 | The scheduled email was already dispatched or canceled (also for unknown ids). | No |
| `conflict` | 409 | The resource already exists (duplicate alias, domain, forward destination…). | No |
| `not_ready` | 409 | The received email is still being stored; retry the erasure in a few seconds (`Retry-After: 5`). | Yes |
| `link_expired` | 410 | A signed download link expired; request a new one from the API. | Get a new link |
| `payload_too_large` | 413 | Body over 40 MB (templates: over 4 MB). | No |
| `misdirected_cell` | 421 | The account is served by another cell; the message names its URL, `Zap-Cell` names the cell. | Send to that URL |
| `missing_required_field` | 422 | A required field is missing. | No |
| `invalid_parameter` | 422 | A field has an invalid value; the message says which. | No |
| `invalid_attachment` | 422 | An attachment could not be decoded or fetched (`attachments[i]: …`). | No |
| `template_render_error` | 422 | A template variable is missing, the template is invalid, or (on save) a tag is not a variable name. | No |
| `template_variables_missing` | 422 | A templated send lacks required variables that have no default; the message lists them. | No |
| `template_variables_invalid` | 422 | A templated send gives variables of the wrong type for the schema; the message lists them. | No |
| `reserved_domain` | 422 | The domain is reserved and cannot be added. | No |
| `invalid_logo` | 422 | The brand logo SVG could not be used (`PUT /domains/{id}/brand`). | No |
| `invalid_certificate` | 422 | The brand certificate (VMC) PEM is not valid. | No |
| `automated_message` | 422 | Replying to an automated email (auto-reply, bounce, list) without `allow_automated: true`. | No |
| `limit_exceeded` | 422 | A per-account limit is reached, such as 20 forward destinations. | No |
| `quota_exceeded` | 422 | The image library is full (2,000 images or 1 GB). | No |
| `invalid_image` | 422 | An uploaded image could not be used. | No |
| `rejected` | 422 | The MTA refused the message; the message gives the reason. | No, not as is |
| `rate_limit_exceeded` | 429 | Over the per-second limit (`Retry-After: 1`), or too many failed authentications. | Yes |
| `monthly_quota_exceeded` | 429 | Free plan or spending cap reached for this month. | No |
| `daily_quota_exceeded` | 429 | Daily limit reached (Free plan: 100 emails a day, resets 00:00 UTC). | After the reset |
| `overloaded` | 429 | Server at capacity (`Retry-After: 1`) or event pipeline backed up (`Retry-After: 5`). Nothing was sent. | Yes, same key |
| `thread_reply_limit` | 429 | More than 20 replies in one conversation in the last hour. `Retry-After: 3600`. | After an hour |
| `internal_error` | 500 | Failure on ZapSMTP's side. | Yes, same key |
| `service_unavailable` | 503 | Temporarily unable to accept (failover `Retry-After: 2`; MTA unavailable, suppression list loading, too many large bodies `Retry-After: 5`). | Yes, same key |
| `scanner_unavailable` | 503 | The spam checkers are temporarily unavailable. | Yes |
| `storage_unavailable` | 503 | Object storage is not configured on this deployment (image upload). | No |
| `inbound_not_configured` | 503 | Inbound email is not enabled on this deployment. | No |

Notes:

- In a batch, per-email failures (validation and send-time ones such as `rate_limit_exceeded`,
  `monthly_quota_exceeded`, `domain_not_verified`) appear in the response's `errors[]` as
  `{index, code, message}` instead of the HTTP status.
- Errors from the send itself (`422`, `403`) are stored under the `Idempotency-Key`: after fixing
  the request, use a new key. Errors found before the key is checked (malformed JSON, unknown
  field, body over 40 MB, invalid batch size or `x-batch-validation`) are not stored. A `429` or
  `5xx` releases the key.
