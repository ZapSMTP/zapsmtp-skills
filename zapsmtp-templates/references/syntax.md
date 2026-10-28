# ZapSMTP template syntax, with rendered output

Every example below was rendered with ZapSMTP's template engine. `mode=html` means the HTML
body (escaping on); `mode=text` means the subject or text body (no escaping).

## Escaping

<!-- check: render mode=html -->
```mustache
<p>Hi {{name}}, your note: {{note}}</p>
<p>{{{signature_html}}}</p>
```

```json
{ "name": "Ann & \"Bob\"", "note": "<b>it's urgent</b>", "signature_html": "<em>The Acme team</em>" }
```

```text
<p>Hi Ann &amp; &#34;Bob&#34;, your note: &lt;b&gt;it&#39;s urgent&lt;/b&gt;</p>
<p><em>The Acme team</em></p>
```

The same source in the text body is not escaped:

<!-- check: render mode=text -->
```mustache
Hi {{name}}, your note: {{note}}
```

```json
{ "name": "Ann & \"Bob\"", "note": "<b>it's urgent</b>" }
```

```text
Hi Ann & "Bob", your note: <b>it's urgent</b>
```

## How values print

<!-- check: render mode=text -->
```mustache
Price {{price}}, qty {{qty}}, paid {{paid}}, note [{{note}}]
```

```json
{ "price": 19.90, "qty": 2, "paid": true, "note": null }
```

```text
Price 19.9, qty 2, paid true, note []
```

| JSON value | Prints as | In a section |
|---|---|---|
| `"Ann"` | Ann | true unless `""` |
| `19.90` | 19.9 | true unless 0 |
| `true` / `false` | true / false | as is |
| `null` | (empty) | false |
| `[…]` | not useful: use a section | true unless `[]` |
| `{…}` | not useful: use a section or dotted name | **always true, even `{}`** |

## Lists of plain values, string conditions

<!-- check: render mode=html -->
```mustache
Tags: {{#labels}}{{.}}; {{/labels}}
{{#greeting}}<p>{{.}}</p>{{/greeting}}
```

```json
{ "labels": ["billing", "urgent"], "greeting": "Welcome back!" }
```

```text
Tags: billing; urgent; 
<p>Welcome back!</p>
```

## Context lookup inside sections

Inside a section the item is searched first, then each enclosing context out to the top level,
so an item can use a top-level `currency`. A nested value (`shipping.name`) is not visible from
another section.

<!-- check: render mode=html -->
```mustache
{{#shipping}}<p>{{name}}<br>{{address.city}}</p>{{/shipping}}
{{#items}}<p>{{name}}: {{price}} {{currency}}</p>{{/items}}
```

```json
{
  "currency": "EUR",
  "shipping": { "name": "Ann Lee", "address": { "city": "Lisbon" } },
  "items": [ { "name": "Grinder", "price": "89.00" } ]
}
```

```text
<p>Ann Lee<br>Lisbon</p>
<p>Grinder: 89.00 EUR</p>
```

## If / else, empty states, zero

<!-- check: render mode=html -->
```mustache
{{#items}}<li>{{name}}</li>{{/items}}{{^items}}<p>Your cart is empty.</p>{{/items}}
{{#count}}You have {{count}} new messages.{{/count}}{{^count}}No new messages.{{/count}}
```

```json
{ "items": [], "count": 0 }
```

```text
<p>Your cart is empty.</p>
No new messages.
```

## Plurals: decide in code, pass a flag

<!-- check: render mode=text -->
```mustache
You have {{count}} {{#one}}message{{/one}}{{^one}}messages{{/one}}.
```

```json
{ "count": 3, "one": false }
```

```text
You have 3 messages.
```

## Line breaks in text bodies

Tags on their own lines leave blank lines:

<!-- check: render mode=text -->
```mustache
Your order {{order_id}}:
{{#items}}
- {{quantity}} x {{name}}
{{/items}}
Total: {{total}}
```

```json
{ "order_id": "A-1042", "total": "$113.00", "items": [ { "name": "Coffee beans", "quantity": 2 }, { "name": "Grinder", "quantity": 1 } ] }
```

```text
Your order A-1042:

- 2 x Coffee beans

- 1 x Grinder

Total: $113.00
```

Tight tags give a clean list:

<!-- check: render mode=text -->
```mustache
Your order {{order_id}}:
{{#items}}- {{quantity}} x {{name}}
{{/items}}Total: {{total}}
```

```json
{ "order_id": "A-1042", "total": "$113.00", "items": [ { "name": "Coffee beans", "quantity": 2 }, { "name": "Grinder", "quantity": 1 } ] }
```

```text
Your order A-1042:
- 2 x Coffee beans
- 1 x Grinder
Total: $113.00
```

## Comments and the unsubscribe tag

`{{! … }}` is removed. `{{{zap:unsubscribe_url}}}` passes through rendering untouched and is
replaced at send time with the recipient's signed link.

<!-- check: render mode=html -->
```mustache
<p>{{! shown in every newsletter }}You get this because you subscribed to {{list_name}}.
<a href="{{{zap:unsubscribe_url}}}">Unsubscribe</a></p>
```

```json
{ "list_name": "Acme news" }
```

```text
<p>You get this because you subscribed to Acme news.
<a href="{{{zap:unsubscribe_url}}}">Unsubscribe</a></p>
```

## Missing variables

A preview (`POST /templates/render`, `POST /templates/{id}/render`) renders a missing variable as
empty text and lists it in `missing_variables` (dotted names in full, e.g. `plan.name`). A send
refuses it (`template_variables_missing` for required schema variables without default,
`template_render_error` for anything else still absent). Not missing: an absent section or
inverted-section name (false), tags inside a skipped section, any `zap:` tag, and values set to
`null` or `""`.

`variable_names` in responses lists top-level names, section names included, and only the first
part of a dotted name (`customer` for `{{customer.first_name}}`); names used only inside a
section are not listed.

## Not supported

Partials `{{> footer}}`, `{{#each}}`, `{{#if}}`, `{{else}}`, helpers, filters, expressions and
custom delimiters. A tag that is not a variable name is refused on save with
`template_render_error` and its line and column. Syntax errors look like
`html: line 2, column 3: unclosed section {{#items}}`.
