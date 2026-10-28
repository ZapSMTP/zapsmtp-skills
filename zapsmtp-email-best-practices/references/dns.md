# Domain records, verification and troubleshooting

Source: https://zapsmtp.com/docs/domain-setup.md and deliverability.md. Always copy names and
values from `POST /domains` / `GET /domains/{id}` (`records[]`: `record`, `type`, `name`,
`value`, `required`, `status`); the values below are for `acme.com` as the docs show them.

<!-- check: skip (DNS zone file) -->
```text
zap._domainkey.acme.com.  TXT  "v=DKIM1; k=rsa; p=MIIBIjANBg…IDAQAB"      ; required
acme.com.                 TXT  "v=spf1 include:_spf.zapsmtp.com ~all"      ; recommended, merge into an existing record
_dmarc.acme.com.          TXT  "v=DMARC1; p=none;"                         ; recommended; add rua from GET /domains/{id}/dmarc
```

For a subdomain the records go in the parent zone; the response's `zone` names it (for
`mail.acme.co.uk` it is `acme.co.uk`). Host to type at most providers: `zap._domainkey.mail`,
`mail`, `_dmarc.mail`.

## Verification

- `status`: `pending` until the DKIM record contains the generated public key, then `verified`
  (`verified_at`). SPF and DMARC never block verification; they are reported as
  `spf_verified`, `dmarc_verified` and `records[].status`.
- Checked automatically every minute for 72 hours after the domain is added; after that call
  `POST /domains/{id}/verify` (returns `found`: what is published under each name, and
  `warnings`).
- DKIM is compared ignoring whitespace; SPF passes when a `v=spf1` record contains the include;
  DMARC passes when `_dmarc.<domain>` or the parent's starts with `v=DMARC1`.
- One account at a time: verifying a domain that another account verified → `409 conflict`.
- Plan domain limit → `403 plan_limit_reached`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| DKIM pending; `dig` finds nothing | Provider appended the domain (`zap._domainkey.acme.com.acme.com`) | Enter only `zap._domainkey` as host |
| DKIM pending; different key | Domain deleted and added again (new key), or wrong value | Copy the value from `GET /domains/{id}` again |
| DKIM pending; value cut off | Provider truncated at 255 characters | Several quoted strings in one record |
| Records correct, nothing resolves | Added at a non-authoritative provider | `dig NS`, add them there |
| Added days ago, never verified | Automatic checks stop after 72 hours | Fix, then call verify |
| "Multiple SPF records found" | Two `v=spf1` records | Merge into one |
| SPF permerror at receivers | More than 10 DNS lookups | Trim includes or use a subdomain |
| `403 domain_not_verified` when sending | Live key, From domain not verified **exactly** | Verify that exact name, or use a test key |
| Bounces `PolicyRejected` mentioning DMARC/SPF | Unverified domain, missing DKIM, or a strict DMARC rejecting an unset-up source | Verify, read DMARC `sources` with `ours: false` |
| Gmail `421 4.7.28` / `550 5.7.28`, Yahoo `TSS04` | Volume rising faster than reputation, or complaints | Slow down, follow the warm-up ramp, engaged recipients only |
| `IPBlocked` bounces | Provider refuses the IP | Not suppressed; the IP is paused and mail moves to other IPs |
| `SpamBlocked` / `ContentRejected` | Content or a linked domain filtered | Spam-check the sent email, remove listed/shortened links, add a text part |
| Delivered but in spam | Content, low engagement or new domain | Spam-check; `new_domain` fades with steady clean volume |
| "[Message clipped]" in Gmail | HTML over about 102 KB | Inline less CSS, link to long content |
| "invalid unsubscribe link" | The link was altered | Use `{{{zap:unsubscribe_url}}}` unchanged |

## DMARC reports

`GET /domains/{id}/dmarc?days=<1–180>` returns `rua` (`mailto:dmarc-<token>@mail.zapsmtp.com`
in the docs' example), a starter `record` (`p=none` + `rua`; publish it only when you have no
DMARC record), totals, a daily series, `sources` (each sending IP, `ours` marks ZapSMTP IPs) and
reporting organisations. Providers send one aggregate report a day; reports are kept 400 days.

## Reputation

`GET /domains/{id}/reputation` (blocklist status), `POST /domains/{id}/reputation/check` (check
now, e.g. right after a delisting). `GET /dedicated-ips` lists dedicated IPs with warm-up state
and listings.
