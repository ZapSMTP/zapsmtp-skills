---
name: zapsmtp-email-best-practices
description: Use when setting up or troubleshooting ZapSMTP deliverability — adding and verifying a sending domain (DKIM, SPF, DMARC records, alignment, BIMI), Gmail/Yahoo/Microsoft sender requirements, separating transactional and broadcast streams, one-click unsubscribe (List-Unsubscribe, RFC 8058), suppressions (what adds them, importing, transactional vs broadcast), warm-up of domains and dedicated IPs, testing with test keys, simulator addresses and spam checks, monitoring (metrics, bounce and complaint rates, DMARC reports, blocklists), consent and list hygiene, or when mail bounces or lands in spam.
license: MIT
metadata:
  author: zapsmtp
  version: "1.0.0"
---

# Email best practices with ZapSMTP

What mailbox providers require, what ZapSMTP already does, and what is left to you. DNS record
details and troubleshooting: [references/dns.md](references/dns.md). Bounce classes and
monitoring endpoints: [references/monitoring.md](references/monitoring.md).

## Requirements and who covers them

Gmail and Yahoo enforce sender rules since February 2024 (stricter for bulk senders: Google
counts close to 5,000 messages a day to Gmail addresses), Outlook.com since May 2025 for
senders above 5,000 a day.

| Requirement | ZapSMTP does | You do |
|---|---|---|
| SPF and DKIM (bulk: both) | Signs every message with a 2048-bit DKIM key per domain, `d=` your exact From domain; SPF passes for its own Return-Path | Publish the DKIM record (required) and the SPF include |
| DMARC (bulk; `p=none` is enough) | Suggests a record, collects aggregate reports | Publish `_dmarc` |
| Alignment | DKIM is aligned even with `adkim=s` | Nothing |
| One-click unsubscribe (bulk marketing; honour within 2 days) | Adds `List-Unsubscribe` + `List-Unsubscribe-Post` on `broadcast` single-recipient mail; suppresses on click | Send marketing on `broadcast`, one recipient per email; visible link in the body |
| Spam rate below 0.3% (aim < 0.1%) | Suppresses complainers from feedback loops | Consent, expected content; watch complaint rates |
| PTR, TLS, RFC 5322 | Handled | Nothing (raise TLS with `tls` if needed) |

## 1. Authenticate every From domain

ZapSMTP matches the From domain **exactly**: `news.acme.com` is a separate domain from
`acme.com`. Adding, verifying and changing domains needs a live, full-access key.

```ts
import { ZapSMTP } from 'zapsmtp';

const zap = new ZapSMTP(); // live, full-access key
const domain = await zap.domains.create({ name: 'news.acme.com' });
for (const r of domain.records ?? []) console.log(r.record, r.type, r.name, r.value); // publish these TXT records
const checked = await zap.domains.verify(domain.id); // also checked every minute for 72 hours
console.log(checked.status, checked.dkim_verified, checked.spf_verified, checked.dmarc_verified);
```

| Record | Name | Value | Needed |
|---|---|---|---|
| DKIM (TXT) | `zap._domainkey.<domain>` | `v=DKIM1; k=rsa; p=…` from the API | **Required** to verify |
| SPF (TXT) | `<domain>` | `v=spf1 include:<value from your records> ~all` (docs show `include:_spf.zapsmtp.com`) | Recommended |
| DMARC (TXT) | `_dmarc.<domain>` | Start `v=DMARC1; p=none; rua=<your rua>` | Recommended (bulk: expected) |

- A domain is `verified` once the DKIM record matches; it then stays verified. Keep DKIM
  published or every message fails DKIM and DMARC.
- **One SPF record per name.** Merge the include into the existing record before `~all`/`-all`
  and keep the qualifier; two `v=spf1` records are a permanent error for every service (verify
  returns a `warnings` entry even if SPF shows verified). Stay under 10 DNS lookups.
- A subdomain without its own `_dmarc` inherits the parent's policy.
- Root or subdomain? Use a subdomain (`news.acme.com`, `notify.acme.com`) to keep product or
  marketing reputation apart from staff mail and to avoid SPF merging.
- DMARC rollout: `p=none` with the account's `rua` (`GET /domains/{id}/dmarc`; reports kept 400
  days) for 2–4 weeks → fix every failing source not marked `ours` → `p=quarantine` → `p=reject`.
  If you already publish DMARC, add the `rua` address to it; do not replace your policy.
- Brand logo (BIMI): DMARC at `quarantine`/`reject` with `pct=100`, a square SVG ≤ 32 KB,
  `default._bimi.<domain>`; Gmail and Apple Mail also need a VMC or CMC
  (`GET`/`PUT /domains/{id}/brand`).

## 2. Separate transactional and marketing mail

- **Stream**: `stream: "transactional"` (default) for receipts, resets, alerts;
  `stream: "broadcast"` for newsletters and promotions (SMTP: `X-Zap-Stream: broadcast`). On
  shared IPs each stream has its own pool.
- **Subdomain**: marketing from `news.acme.com`, transactional from `acme.com` or
  `notify.acme.com`.
- **Keys**: one `sending_access` key per system, restricted to its domain and stream.

## 3. Unsubscribe

- On `broadcast`, an email with exactly **one** recipient (after suppressed ones are dropped) and
  no `List-Unsubscribe` of yours gets RFC 8058 headers signed for that recipient. Batch up to 100
  single-recipient emails per call.
- Put `{{{zap:unsubscribe_url}}}` in the body: replaced with the recipient's signed link on any
  stream (never wrapped by click tracking). A browser visit shows a confirmation button, so link
  scanners cannot unsubscribe anyone.
- A one-click POST adds the address with reason `unsubscribe`: later **broadcast** mail to it is
  suppressed; transactional mail still goes out. Unsubscribes are account-wide; for per-list
  preferences set your own `List-Unsubscribe` and `List-Unsubscribe-Post` headers pointing at your
  endpoint (ZapSMTP then adds nothing) and keep the preference yourself.
- SMTP relay adds no headers and does not replace the tag: set the headers in your mailer.

## 4. Suppressions

A suppressed address is skipped, reported as `email.suppressed`, and not charged.

| Reason | Added when | Stops |
|---|---|---|
| `hard_bounce` | Permanent bounce `MailboxDoesNotExist`, `DomainDoesNotExist`, `MailboxInactive` | Every stream |
| `complaint` | Spam report through a feedback loop | Every stream |
| `unsubscribe` | One-click unsubscribe / confirmation button, or added by you with this reason | `broadcast` only |
| `manual` | Added by you (default reason) | Every stream |

Never suppressed: full mailboxes, temporary failures, sender-side rejections (`SpamBlocked`,
`IPBlocked`, `PolicyRejected`). A stronger reason replaces `unsubscribe`, never the reverse.
Gmail does not report individual complaints: watch Google Postmaster Tools. A reply that only
says "unsubscribe" (reply tracking, `reply.type: "unsubscribe"`) is reported, not applied.

**Before the first live send, import the old provider's bounces and unsubscribes** (up to 1,000
per call; re-running is safe):

```ts
import { ZapSMTP } from 'zapsmtp';

const zap = new ZapSMTP(); // full-access live key
const bounced = ['ann@example.com', 'bob@example.com'];      // hard bounces and complaints
const unsubscribed = ['cy@example.com'];                     // marketing opt-outs
for (let i = 0; i < bounced.length; i += 1000) {
  await zap.suppressions.createBatch({ emails: bounced.slice(i, i + 1000), reason: 'manual' });
}
await zap.suppressions.createBatch({ emails: unsubscribed, reason: 'unsubscribe' });
```

Single address: `POST /suppressions {"email", "reason"}`; check one: `GET /suppressions/{email}`;
remove (only when the person asked, e.g. re-subscribed): `DELETE /suppressions/{email}` or
`POST /suppressions/batch/remove`. Also mirror `email.bounced` (with `bounce.suppressed: true`),
`email.complained` and `email.suppressed` into your own database so your app stops queueing.

## 5. Warm up

- **New domain on shared IPs** (not capped by ZapSMTP; pace it yourself), e.g. a 100,000 list:
  days 1–3: 500–1,000/day to recipients active in 30 days; days 4–7: 2,000–5,000 (60 days);
  week 2: 10,000–20,000 (90 days); week 3: 30,000–50,000; week 4: full list if clean. Hold or
  step back at the first wave of deferrals.
- **Dedicated IPs** are warmed by ZapSMTP over 30 days with a daily cap (50 on day 1 … 300,000
  on day 30); overflow goes through the shared pool. During warm-up an IP is paused when, over its last
  6 hours (once it has 50 attempts), more than 5% bounce or more than 30% are deferred. Watch `GET /dedicated-ips` (`status` `warming`/`active`/`paused`,
  `warmup_day`, `daily_cap`, `blocklists`).

## 6. Test before you send

- `zap_test_` keys: full pipeline, nothing delivered, not charged. Simulator addresses
  (`delivered@`, `bounced@`, `full@`, `blocked@`, `delayed@`, `complained@`, `suppressed@`,
  `bounce+<code>…@` at `simulator.zapsmtp.com`) produce each outcome and its webhooks within
  seconds, with live or test keys, without touching your suppressions or reputation.
- Spam-check drafts: `POST /emails/spam-check` (fields `from`, `to`, `subject`, `html`, `text`,
  `stream` only; nothing is sent; 30 checks a minute). The message is DKIM-signed with your key
  and scored from a representative IP against live blocklists. `verdict`: `good`, `needs_work`,
  `spam`, `rejected`; `issues[].kind`: `not_signed`, `ip_listed`, `domain_listed`,
  `new_domain`. Sent emails: `POST /emails/{id}/spam-check`.

```python
from zapsmtp import ZapSMTP

client = ZapSMTP()
check = client.emails.spam_check(
    from_="Acme News <news@news.acme.com>",
    subject="October product update",
    stream="broadcast",
    html='<p>Hi Ann, here is what shipped.</p><p><a href="https://acme.com/changelog">Changelog</a></p>',
    text="Hi Ann, here is what shipped.\n\nChangelog: https://acme.com/changelog",
)
print(check.verdict, check.score, [i.kind for i in check.issues or []])
```

## 7. Content

- Always include a text part (API sends generate one from HTML; SMTP sends go out as given).
- Keep HTML under 102 KB (Gmail clips, hiding the unsubscribe link and the open pixel).
- Give images `alt` text; do not send a single big image with little text.
- Link to your own domains; no public URL shorteners. Turn click tracking off
  (`tracking.clicks: false`, or `data-zap-notrack` on a link) where the exact URL matters,
  e.g. password resets and magic links.
- Recognisable From name, honest subject. Marketing footers: physical address and unsubscribe link.
- Prefer links to large attachments; executables and macro documents are often rejected.

## 8. Monitor

| Signal | Healthy | Act |
|---|---|---|
| `complaint_rate` (of delivered) | < 0.1% | > 0.1%: pause, send only to recent engagers; never reach 0.3% |
| `bounce_rate` (of sent) | < 2% | > 5% means a list problem |
| `delayed` at one provider | stable | sudden rise = throttling: slow down there |
| DMARC `passed` | ~100% for `ours` sources | unknown failing sources: unconfigured service or spoofing |
| Blocklists | empty | IPs checked every 15 min, domains every 6 h |

```bash
curl "$ZAP_BASE_URL/metrics?dimension=provider&stream=broadcast" \
  -H "Authorization: Bearer $ZAP_API_KEY"
```

Use `human_open_rate` (Apple Mail Privacy Protection opens are flagged `open.machine: true`) or
clicks for engagement decisions. Register your domains in Google Postmaster Tools.

## Consent and list hygiene

- Double opt-in for marketing lists; never buy or rent lists.
- Sunset recipients with no opens or clicks in 6–12 months (or send one re-engagement email).
- Honour unsubscribes at once (ZapSMTP does for its link) and import opt-outs from other systems.
- Never remove hard bounces or complaints from suppressions to "retry" them.
- Received mail can be erased for privacy requests: `DELETE /emails/receiving/{id}`.

## Pre-launch checklist

- Every From domain `verified`; verify shows no `warnings`.
- One SPF record per name with the ZapSMTP include, under 10 lookups; DMARC published with `rua`.
- Marketing on `broadcast` from its own subdomain, one recipient per email, visible unsubscribe.
- Keys restricted per stream and domain; old provider's suppressions imported.
- A webhook records `email.bounced`, `email.complained`, `email.suppressed`.
- Campaign draft scores `good` with empty `issues`, has a text part, is under 102 KB.
- First sends follow the warm-up ramp; someone watches rates and blocklists.
