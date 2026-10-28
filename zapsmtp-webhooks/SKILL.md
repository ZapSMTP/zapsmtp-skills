---
name: zapsmtp-webhooks
description: Use when receiving ZapSMTP events over webhooks — creating or updating endpoints (POST /webhooks), choosing event types (email.sent, email.delivered, email.bounced, email.complained, email.opened, email.clicked, email.suppressed, email.replied, email.received, thread.*), verifying the Zap-Signature HMAC header, batch delivery, deduplicating on Zap-Event-Id, retries and disabled endpoints, test events, replay, secret rotation, and click actions (data-zap-action, filter.actions, click.unique).
license: MIT
metadata:
  author: zapsmtp
  version: "1.0.0"
---

# ZapSMTP webhooks

ZapSMTP POSTs a signed JSON event to your HTTPS endpoint for every recipient and every change.
One system carries delivery events, engagement, reply tracking and inbound mail. Payload fields
per event: [references/events.md](references/events.md). Inbound payloads in depth:
`zapsmtp-inbound`.

## The handler contract

1. Read the **raw body** (bytes, before any JSON parsing): the signature covers the exact bytes.
2. Verify `Zap-Signature` with the endpoint's `whsec_…` secret; reject with `400` when invalid.
3. Skip events you already processed (dedupe, below).
4. Answer any **2xx within a few seconds**; do the slow work afterwards (a queue/job).
5. Never trust a payload you did not verify.

## Create an endpoint

`POST /webhooks` needs a **full-access live key** (test keys: `403 test_key_restricted`). It
returns `201` with the `secret` (also readable later with `GET /webhooks/{id}`).

| Field | Rule |
|---|---|
| `url` | Required, absolute `https://` URL ("url must be an absolute https:// URL") |
| `events` | Event types; default **all** types; unknown type → `422 invalid_parameter` |
| `include_content` | `email.received` carries text, html, headers and 24-hour download links (default `false`) |
| `batch` | Up to 100 events per request as a JSON array (default `false`) |
| `filter.actions` | Narrows `email.clicked` to these click actions (≤ 50 names); other types unaffected |

```ts
import { ZapSMTP } from 'zapsmtp';

const zap = new ZapSMTP(); // full-access live key in ZAP_API_KEY
const hook = await zap.webhooks.create({
  url: 'https://acme.com/webhooks/zapsmtp',
  events: ['email.delivered', 'email.bounced', 'email.complained', 'email.suppressed'],
});
console.log(hook.id); // store hook.secret in your secret manager as ZAP_WEBHOOK_SECRET
```

```bash
curl -X POST "$ZAP_BASE_URL/webhooks" \
  -H "Authorization: Bearer $ZAP_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://acme.com/webhooks/zapsmtp", "events": ["email.delivered", "email.bounced", "email.complained", "email.suppressed"]}'
```

Update with `PATCH /webhooks/{id}` (`url`, `events` (not empty), `enabled`, `include_content`,
`batch`, `filter`). `filter` is replaced as a whole; `{"actions": []}` removes it. Disabling an
endpoint drops its pending deliveries.

## Event types

| Type | When |
|---|---|
| `email.sent` | Accepted for delivery (status `queued`) |
| `email.delivered` | The receiving server accepted the message |
| `email.delivery_delayed` | Temporary failure; ZapSMTP keeps retrying (can repeat) |
| `email.bounced` | Permanently rejected, or retries ran out, or a later bounce email |
| `email.complained` | The recipient marked it as spam (address suppressed) |
| `email.failed` | Rejected before sending (also a scheduled email whose key/account is no longer valid) |
| `email.opened` | Tracking pixel loaded (open tracking on); can repeat |
| `email.clicked` | Tracked link clicked (click tracking on, or a link with a click action); can repeat |
| `email.suppressed` | Not sent: the recipient is on your suppression list |
| `email.replied` | Someone answered an email sent with reply tracking (automated replies included; `data.reply.type` tells them apart) |
| `email.received` | Inbound email arrived (metadata only unless `include_content`) |
| `thread.created` | A new conversation: a received email that answers nothing (not for automated mail) |
| `thread.replied` | A customer answered in a conversation (not for auto-replies, bounces, notifications) |

Delivery events are **one per recipient**: `data.to` is a single address. Store the send's `id`
and match on `data.email_id`.

## Verify with the SDK (recommended)

Pass the raw body and the headers; the call returns the event or throws. It checks every `v1`
signature in constant time, rejects signatures older than five minutes and accepts both secrets
during a rotation.

<!-- check: webhook path=/webhooks/zapsmtp -->
```ts
import express from 'express';
import { verifyWebhook, WebhookVerificationError, type WebhookEvent } from 'zapsmtp';

// db and jobs stand for your storage and job queue
const app = express();

app.post('/webhooks/zapsmtp', express.raw({ type: 'application/json' }), async (req, res) => {
  let event: WebhookEvent;
  try {
    event = verifyWebhook(req.body, req.headers, process.env.ZAP_WEBHOOK_SECRET!);
  } catch (err) {
    if (err instanceof WebhookVerificationError) return res.sendStatus(400);
    throw err;
  }
  const eventId = req.get('Zap-Event-Id')!; // stable across retries and replays
  if (await db.alreadyProcessed(eventId)) return res.sendStatus(200);
  await jobs.enqueue(event.type, event.data); // the slow work happens outside the request
  await db.markProcessed(eventId);
  res.sendStatus(200);
});

app.listen(3000);
```

<!-- check: webhook path=/webhooks/zapsmtp -->
```python
import os

from flask import Flask, request
from zapsmtp import WebhookVerificationError, verify_webhook

app = Flask(__name__)  # db and jobs stand for your storage and job queue


@app.post("/webhooks/zapsmtp")
def zapsmtp_webhook():
    try:
        event = verify_webhook(request.get_data(), request.headers, os.environ["ZAP_WEBHOOK_SECRET"])
    except WebhookVerificationError:
        return "", 400
    event_id = request.headers["Zap-Event-Id"]
    if db.already_processed(event_id):
        return "", 200
    jobs.enqueue(event.type, event.data)
    db.mark_processed(event_id)
    return "", 200
```

<!-- check: webhook path=/webhooks/zapsmtp handler=handleWebhook -->
```go
package main

import (
	"io"
	"log"
	"net/http"
	"os"

	"github.com/zapsmtp/zapsmtp-go"
)

func handleWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
		return
	}
	event, err := zapsmtp.VerifyWebhook(body, r.Header.Get("Zap-Signature"), os.Getenv("ZAP_WEBHOOK_SECRET"))
	if err != nil { // every error is errors.Is(err, zapsmtp.ErrWebhookSignature)
		http.Error(w, "invalid signature", http.StatusBadRequest)
		return
	}
	eventID := r.Header.Get("Zap-Event-Id") // dedupe on it in your storage
	log.Printf("event %s: %s", eventID, event.Type)
	if event.Type == string(zapsmtp.WebhookEventTypeEmailBounced) {
		// event.Data is a map; decode event.Raw into your own struct for a typed view
	}
	w.WriteHeader(http.StatusOK)
}

func main() {
	http.HandleFunc("POST /webhooks/zapsmtp", handleWebhook)
	log.Fatal(http.ListenAndServe(":8080", nil))
}
```

Framework notes: Express needs `express.raw({ type: 'application/json' })` on this route (not
`express.json()`); Flask `request.get_data()`; FastAPI `await request.body()`; Django
`request.body` with `@csrf_exempt`. Python's `verify_webhook` takes any header mapping or the
`Zap-Signature` value; Go's takes the header value.

## Verify without the SDK

`Zap-Signature: t=<unix seconds>,v1=<hex>` where `v1` is **HMAC-SHA256 over `"<t>." + raw
body`**, keyed with the **whole secret string, `whsec_` prefix included** (not base64-decoded).
After a rotation the header carries two `v1` values (new secret first) for 24 hours: accept the
request when **any** `v1` matches. Reject timestamps more than **300 seconds** from now in
either direction. Trim spaces around entries, compare in constant time.

<!-- check: verify-fn name=verifyZapSignature -->
```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyZapSignature(rawBody: Buffer | string, header: string | undefined, secret: string,
  now = Date.now() / 1000, tolerance = 300): boolean {
  let t = '';
  const sigs: string[] = [];
  for (const part of (header ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't') t = value;
    else if (key === 'v1') sigs.push(value);
  }
  if (!/^\d{1,12}$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(now - Number(t)) > tolerance) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  return sigs.some((s) => /^[0-9a-f]{64}$/i.test(s) && timingSafeEqual(Buffer.from(s, 'hex'), expected));
}
```

<!-- check: verify-fn name=verify_zap_signature -->
```python
import hashlib
import hmac
import re
import time
from typing import Optional


def verify_zap_signature(raw_body: bytes, header: Optional[str], secret: str,
                         now: Optional[float] = None, tolerance: int = 300) -> bool:
    t, sigs = "", []
    for part in (header or "").split(","):
        key, sep, value = part.partition("=")
        if not sep:
            continue
        if key.strip() == "t":
            t = value.strip()
        elif key.strip() == "v1":
            sigs.append(value.strip())
    if not re.fullmatch(r"[0-9]{1,12}", t) or not sigs:
        return False
    if abs((time.time() if now is None else now) - int(t)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(s.lower().encode(), expected.encode()) for s in sigs)
```

<!-- check: verify-fn name=verifyZapSignature -->
```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

func verifyZapSignature(body []byte, header, secret string, now time.Time) bool {
	var t string
	var sigs []string
	for _, part := range strings.Split(header, ",") {
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "t":
			t = strings.TrimSpace(value)
		case "v1":
			sigs = append(sigs, strings.TrimSpace(value))
		}
	}
	if len(t) == 0 || len(t) > 12 || strings.Trim(t, "0123456789") != "" || len(sigs) == 0 {
		return false
	}
	ts, _ := strconv.ParseInt(t, 10, 64)
	if age := now.Unix() - ts; age > 300 || age < -300 {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(t + "."))
	mac.Write(body)
	expected := mac.Sum(nil)
	for _, s := range sigs {
		if got, err := hex.DecodeString(s); err == nil && hmac.Equal(got, expected) {
			return true
		}
	}
	return false
}
```

Common mistakes: verifying re-serialized JSON; stripping `whsec_` or base64-decoding the
secret (that is Svix/Resend, not ZapSMTP); checking only the first `v1`; comparing with `==`.

## Deduplicate

Events can arrive more than once (retries, replays). Headers on every request:

| Header | Use |
|---|---|
| `Zap-Event-Id` | Stable across retries and replays. Store it and skip ids you have processed. |
| `Zap-Webhook-Id` | The endpoint this delivery is for. |
| `Zap-Signature` | The signature above. |

`email.received`, `thread.created` and `thread.replied` have **no top-level `id`**: dedupe them
on `Zap-Event-Id`. Make the work itself idempotent too (marking a bounce twice changes nothing).

## Batched delivery

With `batch: true`, events arrive up to 100 per request (or whatever arrived within a second) as
a **JSON array** of the usual event objects, signed as one body. `Zap-Event-Id` is then the
batch's id (the same on every retry); each event keeps its own `id`, so dedupe per event, and
dedupe `email.received`/thread events on `type` + `data.email_id`. A failed batch is retried as
it was. `email.received` with `include_content` still arrives alone. The one-event verify
refuses an array; use the batch-aware call, which also accepts a single event:

<!-- check: webhook path=/webhooks/zapsmtp batch=1 -->
```ts
import express from 'express';
import { verifyWebhookEvents, WebhookVerificationError } from 'zapsmtp';

const app = express(); // db and jobs stand for your storage and job queue

app.post('/webhooks/zapsmtp', express.raw({ type: 'application/json' }), async (req, res) => {
  let events;
  try {
    events = verifyWebhookEvents(req.body, req.headers, process.env.ZAP_WEBHOOK_SECRET!);
  } catch (err) {
    if (err instanceof WebhookVerificationError) return res.sendStatus(400);
    throw err;
  }
  for (const event of events) {
    const key = event.id ?? `${event.type}:${event.data.email_id}`; // inbound events have no id
    if (await db.alreadyProcessed(key)) continue;
    await jobs.enqueue(event.type, event.data);
    await db.markProcessed(key);
  }
  res.sendStatus(200);
});

app.listen(3000);
```

Python: `verify_webhook_events(body, headers, secret)` returns a list. Go:
`zapsmtp.VerifyWebhookEvents(body, sig, secret)`; `VerifyWebhook` returns `ErrWebhookBatch` for
an array.

ZapSMTP adapts its concurrency to your endpoint: requests in flight start at 32, grow while you
answer quickly and halve on timeouts, 5xx or 429.

## Retries and failure

- **Retried**: network errors, timeouts, `5xx`, `408` and `429`, after 5 s, 5 min, 30 min, 2 h,
  5 h, 10 h and 10 h: eight attempts over about 28 hours.
- **Final**: any other `4xx`. Answer `400` only for a bad signature, and `2xx` for events you
  choose to ignore, or they are retried or dropped as you did not intend.
- An endpoint that keeps failing is paused for a minute (attempts are not used up), and is
  **disabled** when five events exhaust their retries within 24 hours; `GET /webhooks/{id}`
  shows `enabled: false` and `disabled_reason`. Re-enable with `PATCH /webhooks/{id}`
  `{"enabled": true}`.

## Test, inspect, replay, rotate

| Call | Does |
|---|---|
| `POST /webhooks/{id}/test` `{"type": "email.bounced"}` | Sends a signed sample event now (default `email.delivered`), reports `ok`, `delivery.status_code` (`0` on network errors), `delivery.error`. Not retried; recorded in the log. |
| `GET /webhooks/{id}/deliveries` | The last 100 attempts, newest first, with the exact `body` (omitted above 64 KB) and `error` |
| `GET /webhooks/{id}/events`, `GET /webhooks/{id}/events/{event}` | Events with their outcome and attempts |
| `POST /webhooks/{id}/deliveries/{event}/replay` | Re-sends a past event (from the last 100) now: same body and `Zap-Event-Id`, new timestamp and current secret(s); not retried; bodies over 64 KB cannot be replayed |
| `POST /webhooks/{id}/rotate-secret` | New secret; the old one stays valid for 24 hours (`previous_secret_expires_at`); rotating again replaces the previous secret |

Rotation without downtime: rotate, deploy the new secret (the SDK accepts either `v1`), and
finish within 24 hours. Test, replay, rotate, deliveries and events need a full-access key.

```ts
import { ZapSMTP } from 'zapsmtp';

const zap = new ZapSMTP();
const webhookId = '019a1f22-6e7f-7091-8a2b-3c4d5e6f7a8b';
const result = await zap.webhooks.test(webhookId, { type: 'email.bounced' });
console.log(result.ok, result.delivery?.status_code);
const rotated = await zap.webhooks.rotateSecret(webhookId);
console.log(rotated.previous_secret_expires_at);
```

## Click actions

Name a button or link with `data-zap-action` and its clicks arrive as `email.clicked` with
`data.click.action`, plus the email's `metadata`: no URL parsing.

```html
<a href="https://acme.com/orders/{{order_id}}/confirm" data-zap-action="confirm_order">Confirm order</a>
<a href="https://acme.com/orders/{{order_id}}/track" data-zap-action="track_parcel">Track parcel</a>
```

- Names: lowercase letters, digits, `_`, `.`, `-`, starting with a letter or digit, up to 64
  characters. A name that does not fit makes an ordinary link. Declaring an action
  (`POST /actions`) is optional.
- Only `<a>` with an absolute `http(s)` `href` in the HTML part. A link with an action is
  tracked even with click tracking off; `data-zap-notrack` wins (no click reported).
- The action and destination are signed into the link (not forgeable). Links work 365 days; a
  repeat click on the same link from the same network within 10 minutes is not reported again.
- `data.click.unique` is `true` on the first click of that action by that recipient of that
  email, `false` on later clicks and on links without an action. It is a convenience, not a
  lock: make the work idempotent.
- Links belong to the first `to` address: send one recipient per email when a click is a
  person's answer. Keep `metadata` small: it rides on clicks only when its JSON fits in 200 bytes.
- Route one action to its own endpoint: `{"events": ["email.clicked"], "filter": {"actions":
  ["confirm_order"]}}`.

<!-- check: webhook path=/hooks/confirm-order event=click -->
```ts
import express from 'express';
import { verifyWebhook, WebhookVerificationError } from 'zapsmtp';

const app = express(); // orders stands for your order service

app.post('/hooks/confirm-order', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = verifyWebhook(req.body, req.headers, process.env.ZAP_WEBHOOK_SECRET!);
    const click = event.data.click;
    if (event.type === 'email.clicked' && click?.action === 'confirm_order' && click.unique) {
      await orders.confirm(event.data.metadata?.order_id); // idempotent on your side as well
    }
    res.sendStatus(200);
  } catch (err) {
    if (err instanceof WebhookVerificationError) return res.sendStatus(400);
    throw err;
  }
});

app.listen(3000);
```

## Checklist

- HTTPS endpoint, raw body, signature verified with the whole `whsec_` secret, 5-minute window.
- Dedupe on `Zap-Event-Id` (per-event `id` in batches); idempotent processing.
- `2xx` fast, work in a queue; `400` only for bad signatures.
- Subscribe to `email.bounced`, `email.complained` and `email.suppressed` at least, and stop
  mailing those addresses in your app.
- Monitor `enabled`/`disabled_reason`; use test events and replay while developing.
