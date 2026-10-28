---
name: zapsmtp-migrate
description: Use when moving an application's email from Resend, SendGrid, Mailgun, Postmark or Amazon SES to ZapSMTP — mapping request fields and webhook events, swapping a Resend base URL and key, converting Handlebars templates to Mustache, replacing webhook signature checks with Zap-Signature, importing suppressions, publishing DNS side by side, and rolling out by percentage with a rollback plan.
license: MIT
metadata:
  author: zapsmtp
  version: "1.0.0"
---

# Migrate to ZapSMTP

Move without a big-bang switch: map fields and events, convert templates, import suppressions,
publish DNS next to the current provider, then move traffic a percentage at a time. Full
per-provider field and event tables: [references/mappings.md](references/mappings.md).

## Order of work

1. Add the sending domain (`POST /domains`, live full-access key) and publish ZapSMTP's DKIM
   under its own `zap` selector **next to** the old provider's key; add the SPF include to the
   existing SPF record (one record per name). Keep DMARC as it is.
2. Create a test key (`zap_test_…`) and port the send call (sections below).
3. Convert templates; subscribe a webhook endpoint; replace signature verification.
4. **Import suppressions before the first live email.**
5. Shadow with the test key, roll out by percentage, cut over, keep rollback open.

Setup calls (domains, templates, webhooks, suppressions, keys) need a **full-access live key**;
test keys get `403 test_key_restricted`. Sends, batches, reads and template rendering work with
a test key.

## Zero-code path: SMTP

If the app sends over SMTP, change configuration only: host `mail.zapsmtp.com`, port `587`
(STARTTLS; also `2525`) or `465` (TLS), AUTH `PLAIN`/`LOGIN` after TLS, an SMTP credential per
application (username `smtp_…`, password shown once; sending only). Choose the stream per
message with `X-Zap-Stream: broadcast`. SMTP is also the route for prebuilt MIME (SES
`SendRawEmail`, Mailgun's MIME endpoint): the API has no raw MIME field.

## From Resend

Fields, `POST /emails/batch`, `Idempotency-Key` and event names match; error bodies carry
Resend's flat `statusCode`, `name`, `message`, so Resend SDKs parse ZapSMTP errors.

<!-- check: skip (environment file) -->
```bash
# Server environment: with the Resend Node SDK only these two values change
RESEND_BASE_URL=https://api.zapsmtp.com/v1   # the ZapSMTP API base URL
RESEND_API_KEY=zap_your_api_key
```

- Test the SDK features you use (scheduling, templates, attachments) with a test key first.
- Differences: ≤ 50 recipients across `to`/`cc`/`bcc`; tags match `[A-Za-z0-9_-]`; the 40 MB
  request limit includes base64 attachments and covers a whole batch; `scheduled_at` up to 7
  days ahead (RFC 3339 or `in 30 minutes`).
- New in ZapSMTP: `email.suppressed` (no Resend equivalent), typed stored templates, click
  actions, reply tracking (`email.replied`), inbound conversations, batched webhooks, the
  simulator, `metadata` filters.
- **Webhooks change**: Resend signs with Svix (`svix-id`, `svix-timestamp`, `svix-signature`,
  base64 signatures, base64-decoded secret). ZapSMTP sends `Zap-Signature: t=…,v1=<hex>`:
  HMAC-SHA256 over `<t>.<raw body>` keyed with the **whole `whsec_…` string, not decoded**.
  Replace the verification step (`zapsmtp-webhooks`); payload handling (`type`, `data`) can stay.
  Dedupe on `Zap-Event-Id`.

## From SendGrid

| SendGrid | ZapSMTP |
|---|---|
| `from {email, name}` | `from: "Acme <hello@acme.com>"` |
| `personalizations[].to/cc/bcc` | `to`, `cc`, `bcc`; each personalization that is a separate email → one item of `POST /emails/batch` |
| `content [{type, value}]` | `text`, `html` |
| `reply_to {email, name}` | `reply_to` |
| `attachments [{content, filename, type, content_id}]` | `attachments [{content, filename, content_type, content_id}]` |
| `categories` | `tags [{name: "category", value: "receipt"}]` |
| `custom_args` | `metadata` (≤ 10 string pairs; back as `data.metadata`) |
| `send_at` (Unix) | `scheduled_at` (RFC 3339), ≤ 7 days |
| `template_id` + `dynamic_template_data` | `template: {id, variables}` (convert Handlebars) |
| `tracking_settings` | `tracking: {opens, clicks}` |

Events: `processed` → `email.sent`, `delivered` → `email.delivered`, `deferred` →
`email.delivery_delayed`, `bounce` → `email.bounced`, `dropped` → `email.suppressed` (suppressed
address) or `email.failed`, `spamreport` → `email.complained`, `open`/`click` →
`email.opened`/`email.clicked`, `unsubscribe` → no event (suppression with reason
`unsubscribe`). SendGrid posts arrays signed with ECDSA; ZapSMTP posts one event per request
(or arrays with `batch: true`) signed with HMAC-SHA256. Suppression groups have no equivalent:
an unsubscribe applies to the account's whole `broadcast` stream.

## From Mailgun

Form fields with `o:`/`h:`/`v:` prefixes and basic auth become JSON with a bearer key; the
sending domain comes from `from`, not the URL. `h:Reply-To` → `reply_to`; `h:X-My-Header` →
`headers`; `attachment`/`inline` → `attachments` (inline: `content_id`); `o:tag` → `tags`;
`v:my-var` → `metadata`; `o:deliverytime` → `scheduled_at`; `o:tracking-opens/clicks` →
`tracking`; `template` + variables → `template: {id, variables}`; `recipient-variables` → one
batch item per recipient. Events: `accepted` → `email.sent`, `delivered` → `email.delivered`, `failed` (temporary) →
`email.delivery_delayed`, `failed` (permanent) → `email.bounced` (or `email.suppressed` for a
suppressed address), `complained` → `email.complained`, `opened`/`clicked` →
`email.opened`/`email.clicked`, `unsubscribed` → no event (suppression with reason `unsubscribe`). Mailgun's `signature` object inside
the body becomes the `Zap-Signature` header; event fields move from `event-data` to `data`.

## From Postmark

PascalCase → snake_case: `From`, `To`, `Cc`, `Bcc`, `Subject` → same names in lower case
(comma-separated lists become arrays); `ReplyTo` → `reply_to`; `HtmlBody`/`TextBody` →
`html`/`text`; `Headers [{Name, Value}]` → `headers {Name: Value}`; `Attachments [{Name,
Content, ContentType, ContentID}]` → `attachments [{filename, content, content_type,
content_id}]`; `Tag` → `tags [{name: "tag", value}]`; `Metadata` → `metadata` (≤ 10 keys);
`MessageStream` → `stream` (`transactional` | `broadcast`); `TrackOpens`/`TrackLinks` →
`tracking`; `TemplateAlias`/`TemplateId` + `TemplateModel` → `template: {id, variables}` (`id`
takes an id or alias); `X-Postmark-Server-Token` → `Authorization: Bearer zap_…`. Templates are
Mustache in both and usually move unchanged. Webhooks: `RecordType` → `type`; `Delivery` →
`email.delivered`; hard `Bounce` → `email.bounced` (`bounce.type: "Permanent"`); soft bounce →
`email.delivery_delayed` while retrying, `email.bounced` when retries run out; `SpamComplaint` →
`email.complained`; `Open`/`Click` → `email.opened`/`email.clicked`; `SubscriptionChange` → no
event (suppression with reason `unsubscribe`). Verify `Zap-Signature`
instead of URL credentials.

## From Amazon SES (v2)

`FromEmailAddress` → `from`; `Destination.To/Cc/BccAddresses` → `to`/`cc`/`bcc`;
`ReplyToAddresses` → `reply_to`; `Content.Simple` → `subject`, `html`, `text`;
`Content.Raw` → SMTP relay; `Content.Template` (`TemplateName`, `TemplateData` as a JSON
string) → `template: {id, variables}` with `variables` as an **object**; `EmailTags` → `tags`;
`ConfigurationSetName` → not needed (webhooks, per-domain tracking). Events arrive as signed
webhooks directly (no SNS): `Send` → `email.sent`, `Delivery` → `email.delivered`,
`DeliveryDelay` → `email.delivery_delayed`, `Bounce` → `email.bounced`, `Complaint` →
`email.complained`, `Reject`/`Rendering Failure` → `email.failed` (template errors come back
synchronously as `422 template_render_error`), `Open`/`Click` → `email.opened`/`email.clicked`. `bounce.bounceType`/`bounceSubType` →
`data.bounce.type` (`Permanent`, `Transient`, `Undetermined`) / `data.bounce.subType`.

## Templates

ZapSMTP templates are logic-less Mustache with a draft and a published version (`publish: true`
or `POST /templates/{id}/publish`). Handlebars tags are refused on save with
`422 template_render_error` and their line and column: rewrite `{{#if x}}` → `{{#x}}`,
`{{else}}`/`{{#unless}}` → `{{^x}}`, `{{#each items}}{{this.name}}` → `{{#items}}{{name}}`,
helpers → precomputed values. A missing **required** variable fails the send
(`422 template_variables_missing`) instead of rendering empty. Validate with
`POST /templates/render` (test key works). Details: `zapsmtp-templates`.

## Webhooks during the transition

Run both providers' endpoints side by side and normalise events into the shape your app uses.
ZapSMTP sends one event per recipient (`data.to` is one address), retries for about 28 hours,
keeps `Zap-Event-Id` stable. Delivery events (`email.sent` … `email.suppressed`) carry the
send's `tags` and `metadata`; `email.replied` carries tags, not metadata.

```ts
type Normalized = { provider: 'zapsmtp'; messageId: string; recipient: string;
  status: 'sent' | 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed' | 'opened' | 'clicked' | 'suppressed';
  permanent: boolean; metadata: Record<string, string> };

const STATUS: Record<string, Normalized['status']> = {
  'email.sent': 'sent', 'email.delivered': 'delivered', 'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced', 'email.complained': 'complained', 'email.failed': 'failed',
  'email.opened': 'opened', 'email.clicked': 'clicked', 'email.suppressed': 'suppressed',
};

// call after verifying Zap-Signature; returns null for event types you do not track here
export function normalize(event: { type: string; data: Record<string, any> }): Normalized | null {
  const status = STATUS[event.type];
  if (!status) return null;
  return {
    provider: 'zapsmtp', messageId: event.data.email_id, recipient: event.data.to, status,
    permanent: event.data.bounce?.type === 'Permanent',
    metadata: event.data.metadata ?? {},
  };
}

console.log(normalize({ type: 'email.bounced', data: { email_id: '019a', to: 'jane@example.org', bounce: { type: 'Permanent' } } }));
```

## Suppressions

Export hard bounces, complaints and unsubscribes from the old provider and import them before
the first live email: `POST /suppressions/batch` (1–1,000 addresses per call, idempotent).
Use `reason: "manual"` for bounces and complaints (stops every stream) and
`reason: "unsubscribe"` for marketing opt-outs (stops `broadcast` only); `hard_bounce` and
`complaint` are set only by ZapSMTP itself. Code: `zapsmtp-email-best-practices`.

## Rollout

1. **Shadow**: mirror production sends with a test key to simulator or real addresses (test
   keys never deliver); filter with `GET /emails?mode=test` and the request log.
2. **Percentage**: 1% → 10% → 50% → 100% of recipients on a live key, bucketed **by recipient**
   so each address stays on one provider (its events and suppressions in one place). Compare
   delivery, bounce and complaint rates between steps.

```ts
import { createHash } from 'node:crypto';
import { ZapSMTP } from 'zapsmtp';

const zap = new ZapSMTP();
const ROLLOUT_PERCENT = Number(process.env.ZAPSMTP_ROLLOUT_PERCENT ?? '10');

function onZapSMTP(recipient: string): boolean {
  const bucket = createHash('sha256').update(recipient.toLowerCase()).digest().readUInt16BE(0) % 100;
  return bucket < ROLLOUT_PERCENT;
}

export async function sendReceipt(order: { id: string; email: string; html: string }) {
  if (!onZapSMTP(order.email)) return oldProvider.send(order); // your current provider
  return zap.emails.send(
    { from: 'Acme <billing@acme.com>', to: order.email, subject: `Receipt ${order.id}`, html: order.html },
    { idempotencyKey: `receipt-${order.id}` }, // a 429/5xx means nothing was accepted: retry or fall back
  );
}

await sendReceipt({ id: 'A-1042', email: 'delivered@simulator.zapsmtp.com', html: '<p>Thanks.</p>' });
```

A `200` with `unconfirmed: true` counts as sent: never fall back or retry it.

3. **Cut over** when: DKIM verified, SPF includes ZapSMTP, DMARC reports show ZapSMTP mail
   passing; live keys per app and environment; every template converted, rendered with real data
   and published; webhook verified and deduped, a test event received; suppressions imported
   (including any added on the old provider during rollout); error handling covers `422`, `429`
   with `Retry-After`, and quota errors; 100% for a full sending cycle with stable rates. Then
   remove the old provider's SPF include and DKIM record and revoke its keys.
4. **Rollback** (until the old DNS and keys are removed): set the percentage to 0 (or point SMTP
   back). First copy ZapSMTP's suppressions to the old provider: page `GET /suppressions` with
   `after=next_cursor` (`reason`: `hard_bounce`, `complaint`, `unsubscribe`, `manual`). Keep the
   ZapSMTP webhook endpoint running until its retries finish.
