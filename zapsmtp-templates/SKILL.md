---
name: zapsmtp-templates
description: Use when creating, editing, previewing, publishing or sending ZapSMTP stored email templates — logic-less Mustache syntax ({{var}}, {{{raw}}}, sections, inverted sections, lists, dotted names), the typed variable_schema (types, required, defaults) and its send-time errors (template_variables_missing, template_variables_invalid, template_render_error), global variables ({{global.key}}), {{{zap:unsubscribe_url}}}, drafts vs published versions, version history and restore, aliases, render/preview endpoints, the visual editor's design field, and converting Handlebars templates.
license: MIT
metadata:
  author: zapsmtp
  version: "1.0.0"
---

# ZapSMTP templates

A template stores the subject, HTML and text of an email; a send passes
`template: {id, variables}` instead of `subject`/`html`/`text`. The language is **logic-less
Mustache**: no code runs, so any input is safe. Full syntax with verified outputs:
[references/syntax.md](references/syntax.md). Endpoints and errors:
[references/api.md](references/api.md).

## Lifecycle at a glance

1. **Create** (`POST /templates`) with `name`, `alias`, `subject`, `html` and/or `text`, a default
   `from`, sample `variables` and a `variable_schema`. Creating, updating, publishing, restoring,
   duplicating and deleting need a **full-access live key** (test keys: `403
   test_key_restricted`). Test keys may read templates and call the two render endpoints.
2. **Preview** the draft (`POST /templates/{id}/render`) or unsaved source
   (`POST /templates/render`). Previews never fail on missing variables; they list them.
3. **Publish** (`POST /templates/{id}/publish`, or `"publish": true` on create/update). **Sends
   always use the published version**; a never-published template cannot be sent
   (`422 invalid_parameter` "template … is not published").
4. **Send** with `template.id` = the template id (UUID, never changes) or its alias.
5. **Edit** with `PATCH` (lands in the draft, `has_unpublished_changes: true`), preview, publish.
   Every save, publish and restore is a version (newest 50 kept).

## Syntax

Subject, HTML and text are each a template. Spaces inside tags are ignored.

| Tag | Meaning |
|---|---|
| `{{name}}` | Value; **HTML-escaped in the HTML body** (`< > & ' "`), as is in subject and text |
| `{{{name}}}` or `{{& name}}` | Raw, never escaped: only for HTML you produced yourself |
| `{{user.first_name}}` | Dotted name: walks into nested objects |
| `{{#name}}…{{/name}}` | Section: a list repeats per item; an object or other truthy value renders once with it as context; falsy/absent skips |
| `{{^name}}…{{/name}}` | Inverted: renders when the value is `false`, `null`, `""`, `0`, `[]` or absent |
| `{{.}}` | The current item of a list of strings or numbers |
| `{{! note }}` | Comment |
| `{{global.key}}` | An account-wide global variable |
| `{{{zap:unsubscribe_url}}}` | The recipient's signed unsubscribe link, filled at send time |

There is **nothing else**: no partials (`{{> footer}}`), helpers, filters, expressions, `if`,
`each` or custom delimiters. Saving a tag that is not a variable name (`{{first name}}`,
`{{#each items}}`, `{{> footer}}`) fails with `422 template_render_error` "html: line L,
column C: {{…}} is not a variable name: …". Compute formatted prices, dates, plurals and
anything else in your code and pass the result.

Values are JSON: strings print as they are; numbers print in shortest form (`19.90` → `19.9`),
so **pass money, dates and fixed formats as strings**; `null` prints empty; an empty object `{}`
is still truthy (send `null` to hide a block). Inside a section the current item is searched
first, then each enclosing context out to the top level. Sections nest up to 32 levels; a render
over 10 MB of output or about a million steps fails.

<!-- check: render mode=html -->
```mustache
<p>Hi {{customer.first_name}}, thanks for order {{order_id}}.</p>
<table>
{{#items}}<tr><td>{{quantity}} × {{name}}</td><td>{{price}} {{currency}}</td></tr>
{{/items}}</table>
{{#coupon}}<p>Use <strong>{{code}}</strong> for {{percent}}% off.</p>{{/coupon}}{{^coupon}}<p>See you soon.</p>{{/coupon}}
```

```json
{
  "order_id": "A-1042",
  "currency": "EUR",
  "customer": { "first_name": "Ann & \"Bob\"" },
  "items": [
    { "name": "Coffee beans", "quantity": 2, "price": "24.00" },
    { "name": "Grinder", "quantity": 1, "price": "89.00" }
  ],
  "coupon": null
}
```

```text
<p>Hi Ann &amp; &#34;Bob&#34;, thanks for order A-1042.</p>
<table>
<tr><td>2 × Coffee beans</td><td>24.00 EUR</td></tr>
<tr><td>1 × Grinder</td><td>89.00 EUR</td></tr>
</table>
<p>See you soon.</p>
```

In the **text** body, put a section's opening tag at the start of the repeated line and the
closing tag right after its line break (`{{#items}}- {{name}}\n{{/items}}`): text outside tags,
including the line break after a tag on its own line, is copied exactly and becomes blank lines.

## Variable schema

`variable_schema` declares each top-level variable: `name` (letters, digits, `_`, `-`, starting
with a letter or `_`, up to 64; `global` is reserved), `type`, `required` (default `false`),
`default`, `example` (both of the declared type) and `description` (≤ 500 bytes). Up to 200
entries; sending it replaces the declared list.

| `type` | Accepts |
|---|---|
| `string` | JSON string |
| `number` | JSON number |
| `boolean` | `true` / `false` |
| `url` | string: `http(s)://` with a host, or `mailto:` / `tel:` |
| `date` | string: RFC 3339 time or `YYYY-MM-DD` |
| `list` | JSON array (repeating sections) |
| `object` | JSON object (dotted names, sections that render once) |
| `any` | anything, unchecked |

**Discovery on save:** a top-level name used in the source but not declared is added: a section
(`{{#items}}`, `{{^vip}}`) as optional `any`, a dotted name (`{{customer.first_name}}`) as
required `object`, anything else as required `any`, with its sample value as `example`.
Declared names the source no longer uses stay, marked `unused: true`. Declare real types to get
sends checked. The schema has a draft and a published copy; sends use
`published.variable_schema`.

**At send time**, for each declared variable:

1. A value (not `null`) in `template.variables` must match its type → else `422
   template_variables_invalid` "template variables of the wrong type: …" (checked first).
2. No value → the `default` is used.
3. No default → a **required** variable fails with `422 template_variables_missing` "missing
   required template variables: customer, total"; an optional one becomes `null` (renders empty,
   its section is skipped).

Undeclared values pass through. Then globals are added and the template renders; anything it
renders that is still absent (a field inside an object, an unset global) fails with
`422 template_render_error` "missing template variables: …". A half-filled email never goes out.
A section or inverted section whose name is absent counts as false and is never "missing";
tags inside a skipped section are not evaluated.

A template last published before schemas existed has `published.variable_schema: null`: every
rendered variable must be given. Save and publish it once to switch to the schema rules.

## Global variables and system variables

- `{{global.company_name}}`: set once per account with `PUT /variables/global/{key}`
  (`{"value": "…", "description": "…"}`; string values up to 10 KB; full-access live key). A
  change applies from the next send, no publish needed. A send cannot override them
  (`template.variables.global` → `422 invalid_parameter`). An unset global fails sends with
  `template_render_error`. `DELETE /variables/global/{key}` removes one. `GET /variables` lists
  system, global and template variables with the templates that use each.
- `{{{zap:unsubscribe_url}}}` (or `{{zap:unsubscribe_url}}`) passes through rendering and becomes
  the recipient's signed one-click unsubscribe link at send time, in HTML and text, templated or
  not; never wrapped by click tracking; never a missing variable. With several recipients it
  belongs to the first: send marketing one recipient per email.

## Create, preview, publish, send

```ts
import { ZapSMTP } from 'zapsmtp';

const zap = new ZapSMTP(); // full-access live key to create and publish

await zap.templates.create({
  name: 'Receipt',
  alias: 'receipt',                       // [a-z0-9][a-z0-9_-]{0,62}, unique per account
  from: 'Acme <billing@acme.com>',
  subject: 'Your Acme receipt {{order_id}}',
  html: '<p>Hi {{customer.first_name}},</p><p>Total: <strong>{{total}}</strong></p>',
  text: 'Hi {{customer.first_name}},\n\nTotal: {{total}}\n',
  variables: { order_id: 'A-1042', customer: { first_name: 'Ann' }, total: '$113.00' }, // samples for previews only
  variable_schema: [
    { name: 'order_id', type: 'string', required: true, description: 'Order number' },
    { name: 'customer', type: 'object', required: true },
    { name: 'total', type: 'string', required: true },
  ],
  publish: true, // omit to keep a draft
});

const preview = await zap.templates.render('receipt', {
  variables: { order_id: 'A-1042', customer: { first_name: 'Ann' }, total: '$113.00' },
});
if (preview.missing_variables.length) throw new Error(`missing: ${preview.missing_variables.join(', ')}`);

await zap.emails.send({
  to: 'delivered@simulator.zapsmtp.com',
  template: { id: 'receipt', variables: { order_id: 'A-1042', customer: { first_name: 'Ann' }, total: '$113.00' } },
});
```

```python
from zapsmtp import ZapSMTP

client = ZapSMTP()
client.templates.update("receipt", subject="Receipt {{order_id}} from Acme")  # changes the draft
client.templates.publish("receipt")                                          # sends now use it
client.emails.send(
    to="delivered@simulator.zapsmtp.com",
    template={"id": "receipt", "variables": {"order_id": "A-1042", "customer": {"first_name": "Ann"}, "total": "$113.00"}},
)
```

```bash
curl -X POST "$ZAP_BASE_URL/templates/render" \
  -H "Authorization: Bearer $ZAP_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "subject": "Hi {{first_name}}",
    "text": "Hi {{first_name}} {{last_name}}, your plan: {{plan.name}}",
    "variables": {"first_name": "Ann", "plan": {}}
  }'
# → missing_variables: ["last_name", "plan.name"]; a send with these variables would be refused
```

Send rules with `template`: `html`/`text` are not allowed (`422 invalid_parameter` "html/text
cannot be combined with template"); `from` is optional when the template has one and overrides
it when given (live keys still need a verified domain); a request `subject` overrides the
template's and is **not rendered**; `cc`, `bcc`, `reply_to`, `headers`, `attachments`, `tags`,
`metadata`, `tracking`, `stream`, `scheduled_at` and `tls` work as usual. The template is
rendered when the request is accepted: a scheduled email keeps that content even if the
template is published again. In a batch each item has its own variables; with strict
validation one bad item stops the batch.

## Drafts, versions, aliases

- Top-level fields are the **draft**; `published` holds what sends use. `status` is `draft`
  until the first publish, then `published`; `has_unpublished_changes` and `published_at` tell
  the rest.
- `GET /templates/{id}/versions` (newest 50, no bodies; `kind` `saved`/`published`/`restored`,
  `author`), `GET /templates/{id}/versions/{vid}`, `POST /templates/{id}/versions/{vid}/restore`
  copies name, subject, HTML, text, From and design into the **draft** (alias and samples kept);
  publishing stays a separate step.
- `alias` works wherever an id does (`/templates/receipt`, `template.id: "receipt"`); duplicate
  alias → `409 conflict`. Changing an alias breaks code that sends with the old one. One
  template per language with shared variables works well: `receipt`, `receipt-de`, `receipt-fr`.
- `POST /templates/{id}/duplicate` copies the draft into a new unpublished template
  "… (copy)" without the alias.
- Request bodies up to 4 MB.

## Visual editor templates (`design`)

Templates built in the dashboard's visual editor carry `design`: the editor's JSON document
(an object with a numeric `version`, at most 1 MB). `html`/`text` remain what is sent. **Changing
`html` through the API without sending `design` drops the design** and turns the template into a
code template (sending the same HTML again keeps it); `"design": null` drops it explicitly. When
editing an editor-built template from code, change only `subject`, `from`, `variable_schema`
or samples, or accept that it becomes a code template.

## Converting Handlebars (SendGrid, Mailgun, SES)

| Handlebars | ZapSMTP |
|---|---|
| `{{#if vip}}…{{/if}}` | `{{#vip}}…{{/vip}}` |
| `{{else}}`, `{{#unless x}}` | `{{^x}}…{{/x}}` |
| `{{#each items}}{{this.name}}{{/each}}` | `{{#items}}{{name}}{{/items}}`; `{{.}}` for plain values |
| helpers (`{{formatDate …}}`) | none: format in code |
| `%recipient.name%` (Mailgun) | `{{name}}`, one batch item per recipient |
| unsubscribe placeholders | `{{{zap:unsubscribe_url}}}` |

Postmark templates are Mustache and usually move unchanged. Validate converted source with
`POST /templates/render` before saving (works with a test key).

## Checklist

- Variables: declare types; mark required ones; give defaults where sensible.
- Strings for money and dates; `null` (not `{}`) to hide an object section.
- `{{x}}` in HTML for user data; `{{{x}}}` only for trusted HTML.
- Preview with the exact variables your code builds and fail tests on `missing_variables`
  (previews render the draft; sends use the published version).
- Publish after every change you want live; send by alias from code.
