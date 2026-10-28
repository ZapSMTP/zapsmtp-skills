# Bounce classification and monitoring

Source: https://zapsmtp.com/docs/testing.md, analytics.md, deliverability.md.

## Bounce classification

Bounced, delayed, failed and suppressed events carry `bounce`: `type` (`Permanent`,
`Transient`, `Undetermined`), `subType`, `message` (the receiver's reply) and `suppressed`.

| `subType` | Meaning | Suppresses the recipient |
|---|---|---|
| `MailboxDoesNotExist` | The address does not exist | Yes |
| `DomainDoesNotExist` | The domain has no mail server | Yes |
| `MailboxInactive` | The mailbox is disabled | Yes |
| `MailboxFull` | Over quota | No |
| `MessageTooLarge` | Rejected for size | No |
| `ContentRejected` | Rejected for content | No |
| `AttachmentRejected` | Rejected for an attachment | No |
| `SpamBlocked` | Filtered as spam | No |
| `IPBlocked` | Provider refuses the sending IP (e.g. Yahoo TSS, Microsoft S3150); the IP is paused | No |
| `PolicyRejected` | Sender policy (SPF, DMARC, PTR) | No |
| `RelayDenied` | Receiver refused to relay | No |
| `DNSFailure` | DNS lookup failed | No |
| `ConnectionFailed` | Could not connect | No |
| `Expired` | Retries ran out | No |
| `Suppressed` | Skipped: on your suppression list | (already) |
| `AutoReply` | Out-of-office or similar | No |
| `General` | Anything else | No |

Complaints (`email.complained`) also suppress the address.

## Simulator addresses (`@simulator.zapsmtp.com`)

| Address | Events |
|---|---|
| `delivered@` | `email.delivered` (250) |
| `bounced@` | `email.bounced` 550 5.1.1 Permanent / MailboxDoesNotExist |
| `full@` | `email.bounced` 552 5.2.2 Permanent / MailboxFull |
| `blocked@` | `email.bounced` 554 5.7.1 Permanent / SpamBlocked |
| `delayed@` | `email.delivery_delayed` → `email.delivered` (~20 s later) |
| `complained@` | `email.delivered` → `email.complained` |
| `suppressed@` | `email.suppressed` |
| `bounce+<code>[+<x.y.z>][+<words-with-dashes>]@` | Any reply, e.g. `bounce+421+4.7.0+try-later@` → `email.delivery_delayed` |

They accept `+labels`, work with live and test keys, and never touch suppressions or
reputation. `GET /simulator` lists them.

## Metrics (`GET /metrics`)

Live mail only, kept 400 days. Parameters: `from`, `to` (RFC 3339, `to` exclusive, ≤ 400 days
apart; default the last 7 days), `granularity` (`hour` for ranges up to 31 days, or `day`),
`dimension` (`domain`, `stream`, `tag`, `provider`), filters `domain`, `stream`, `provider`
(Gmail, Microsoft, Yahoo, Apple, Other) and `tag` (`name=value`, not combinable with the other
filters, groups only by tag). Returns `totals`, `series`, and `groups` (≤ 1,000 rows, busiest
first).

| Count / rate | Definition |
|---|---|
| `sent` | Recipients accepted |
| `delivered`, `bounced`, `complained`, `suppressed`, `failed` | Recipients with that event |
| `delayed`, `opened`, `clicked` | Unique emails with at least one such event |
| `delivery_rate`, `bounce_rate` | of `sent` |
| `complaint_rate`, `open_rate`, `human_open_rate`, `click_rate` | of `delivered` |

Rates are fractions cut to four decimals (`0.0077` = 0.77%). Events count in the hour they
happen, so short windows can drift (even above 1).

## Quick stats

`GET /stats?hours=24`, `GET /stats/timeseries?hours=6` (events, not unique emails; 1–720 hours,
within the plan's retention), `GET /stats/breakdown` (per provider, bounce classes,
engagement with `human_unique_opens` and `machine_opens`, top links).

## Thresholds

| Signal | Target |
|---|---|
| `complaint_rate` | below 0.1%; never 0.3% (Gmail/Yahoo limit) |
| `bounce_rate` | below 2%; above 5% = list problem |
| DMARC pass for `ours` sources | close to 100% |
| Blocklists | empty |
