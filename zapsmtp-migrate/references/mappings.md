# Field and event mappings

Source: https://zapsmtp.com/docs/migration.md.

## Resend → ZapSMTP

| Resend | ZapSMTP |
|---|---|
| `from`, `to`, `cc`, `bcc`, `subject`, `html`, `text` | Same names and shapes; ≤ 50 recipients across `to`/`cc`/`bcc` |
| `reply_to` (SDK `replyTo`) | `reply_to` |
| `scheduled_at` (SDK `scheduledAt`) | `scheduled_at`: RFC 3339 or `in 30 minutes`, ≤ 7 days |
| `tags [{name, value}]` | Same; names and values `[A-Za-z0-9_-]` |
| `headers`, `attachments` | Same; `filename` + `content` (base64) or `path` (URL); 40 MB per request incl. base64, shared by a batch |
| `Idempotency-Key` | Same header, kept 24 hours per API key |
| `POST /emails/batch` | Same, up to 100 emails |
| `Authorization: Bearer re_…` | `Authorization: Bearer zap_…` |

| Resend event | ZapSMTP event |
|---|---|
| `email.sent`, `email.delivered`, `email.delivery_delayed` | Same |
| `email.bounced`, `email.complained`, `email.failed` | Same; bounces carry `bounce.type`, `bounce.subType` |
| `email.opened`, `email.clicked` | Same |
| `email.received` | Same; metadata only unless `include_content` |
| (none) | `email.suppressed` |

## SendGrid v3 `mail/send` → ZapSMTP

| SendGrid | ZapSMTP |
|---|---|
| `from {email, name}` | `from: "Acme <hello@acme.com>"` |
| `personalizations[].to/cc/bcc` | `to`, `cc`, `bcc`; separate messages → batch items |
| `subject` | `subject` |
| `content [{type: text/plain \| text/html, value}]` | `text`, `html` |
| `reply_to {email, name}` | `reply_to` |
| `attachments [{content, filename, type, content_id}]` | `attachments [{content, filename, content_type, content_id}]` |
| `categories []` | `tags [{name, value}]` |
| `custom_args {}` | `metadata` (≤ 10 string pairs) |
| `send_at` (Unix time) | `scheduled_at` (RFC 3339), ≤ 7 days |
| `template_id` + `dynamic_template_data` | `template: {id, variables}` |
| `tracking_settings` | `tracking: {opens, clicks}` |

| SendGrid event | ZapSMTP |
|---|---|
| `processed` | `email.sent` |
| `delivered` | `email.delivered` |
| `deferred` | `email.delivery_delayed` |
| `bounce` | `email.bounced` |
| `dropped` | `email.suppressed` when suppressed, else `email.failed` |
| `spamreport` | `email.complained` |
| `open`, `click` | `email.opened`, `email.clicked` |
| `unsubscribe` | no event: suppression with reason `unsubscribe` |

## Mailgun `/v3/<domain>/messages` → ZapSMTP

| Mailgun | ZapSMTP |
|---|---|
| `from`, `to`, `cc`, `bcc`, `subject`, `text`, `html` | Same names, JSON instead of form fields |
| `h:Reply-To` | `reply_to` |
| `h:X-My-Header` | `headers: {"X-My-Header": "…"}` |
| `attachment` / `inline` | `attachments`; inline images set `content_id` |
| `o:tag` | `tags [{name, value}]` |
| `v:my-var` | `metadata` |
| `o:deliverytime` | `scheduled_at` |
| `o:tracking-opens`, `o:tracking-clicks` | `tracking: {opens, clicks}` |
| `template` + template variables | `template: {id, variables}` |
| `recipient-variables` | one item per recipient in `POST /emails/batch` |

| Mailgun event | ZapSMTP |
|---|---|
| `accepted` | `email.sent` |
| `delivered` | `email.delivered` |
| `failed` (temporary) | `email.delivery_delayed` |
| `failed` (permanent) | `email.bounced`, or `email.suppressed` for a suppressed address |
| `complained` | `email.complained` |
| `opened`, `clicked` | `email.opened`, `email.clicked` |
| `unsubscribed` | no event: suppression with reason `unsubscribe` |

## Postmark → ZapSMTP

| Postmark | ZapSMTP |
|---|---|
| `From`, `To`, `Cc`, `Bcc`, `Subject` | `from`, `to`, `cc`, `bcc`, `subject` (comma-separated lists → arrays) |
| `ReplyTo` | `reply_to` |
| `HtmlBody`, `TextBody` | `html`, `text` |
| `Headers [{Name, Value}]` | `headers: {"Name": "Value"}` |
| `Attachments [{Name, Content, ContentType, ContentID}]` | `attachments [{filename, content, content_type, content_id}]` |
| `Tag` | `tags: [{name: "tag", value: "…"}]` (letters, digits, `_`, `-`) |
| `Metadata` | `metadata` (≤ 10 keys) |
| `MessageStream` | `stream`: `transactional` or `broadcast` |
| `TrackOpens`, `TrackLinks` | `tracking: {opens, clicks}` |
| `TemplateAlias` / `TemplateId` + `TemplateModel` | `template: {id, variables}` |
| `X-Postmark-Server-Token` | `Authorization: Bearer zap_…` |

| Postmark `RecordType` | ZapSMTP |
|---|---|
| `Delivery` | `email.delivered` |
| `Bounce` (hard) | `email.bounced` with `bounce.type: "Permanent"` |
| `Bounce` (soft / transient) | `email.delivery_delayed` while retrying; `email.bounced` when retries run out |
| `SpamComplaint` | `email.complained` |
| `Open`, `Click` | `email.opened`, `email.clicked` |
| `SubscriptionChange` | no event: suppression with reason `unsubscribe` |

## Amazon SES v2 `SendEmail` → ZapSMTP

| SES v2 | ZapSMTP |
|---|---|
| `FromEmailAddress` | `from` |
| `Destination.ToAddresses / CcAddresses / BccAddresses` | `to`, `cc`, `bcc` |
| `ReplyToAddresses` | `reply_to` |
| `Content.Simple.Subject / Body.Html / Body.Text` | `subject`, `html`, `text` |
| `Content.Raw` (MIME) | no API field: SMTP relay |
| `Content.Template (TemplateName, TemplateData)` | `template: {id, variables}`; `variables` is an object, not a JSON string |
| `EmailTags [{Name, Value}]` | `tags [{name, value}]` |
| `ConfigurationSetName` | not needed |

| SES event | ZapSMTP |
|---|---|
| `Send` | `email.sent` |
| `Delivery` | `email.delivered` |
| `DeliveryDelay` | `email.delivery_delayed` |
| `Bounce` | `email.bounced` |
| `Complaint` | `email.complained` |
| `Reject`, `Rendering Failure` | `email.failed`; template errors are a synchronous `422 template_render_error` |
| `Open`, `Click` | `email.opened`, `email.clicked` |

## Handlebars → ZapSMTP Mustache

| Handlebars-style | ZapSMTP |
|---|---|
| `{{name}}` / `{{{html}}}` | Same: escaped and raw |
| `{{user.first_name}}` | Same |
| `{{#if vip}}…{{/if}}` | `{{#vip}}…{{/vip}}` |
| `{{else}}` / `{{#unless x}}` | `{{^x}}…{{/x}}` |
| `{{#each items}}{{this.name}}{{/each}}` | `{{#items}}{{name}}{{/items}}`; `{{.}}` for a list of strings |
| Helpers (`{{formatDate …}}`, `{{#equals}}`) | None: format before sending |
| `%recipient.name%` (Mailgun batch) | `{{name}}`, one batch item per recipient |
| Unsubscribe placeholders | `{{{zap:unsubscribe_url}}}` |

## Webhook signatures

| Provider | Old check | ZapSMTP |
|---|---|---|
| Resend | Svix headers, base64 signature, base64-decoded secret | `Zap-Signature: t=…,v1=<hex>`, HMAC-SHA256 over `<t>.<raw body>`, key = whole `whsec_…` string |
| SendGrid | ECDSA, `X-Twilio-Email-Event-Webhook-Signature`, arrays of events | HMAC header; one event per request unless `batch: true` |
| Mailgun | `signature` object in the body | HMAC header; event fields in `data` |
| Postmark | URL credentials | HMAC header; `type` instead of `RecordType` |
| SES | SNS subscription and message signatures | HMAC header, no SNS |

## DNS through the migration

<!-- check: skip (DNS zone file) -->
```text
; during migration: one SPF record with both includes, both DKIM keys, DMARC unchanged
acme.com.                TXT    "v=spf1 include:<old provider> include:_spf.zapsmtp.com ~all"
<old selector>._domainkey.acme.com.  CNAME/TXT  <old provider's DKIM key>
zap._domainkey.acme.com. TXT    "v=DKIM1; k=rsa; p=MIIBIjANBgkq…"
_dmarc.acme.com.         TXT    "v=DMARC1; p=quarantine; rua=mailto:dmarc@acme.com"
```

After cutover remove the old include and the old DKIM record. Use the SPF include and DKIM
value the ZapSMTP API returns for your domain.
