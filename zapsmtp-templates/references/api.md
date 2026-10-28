# Templates and variables API

Source: https://zapsmtp.com/docs/templates.md, templating.md, variables.md.
`{id}` accepts the template id or its alias everywhere.

| Method | Path | SDK (Node / Python) | Key |
|---|---|---|---|
| `GET` | `/templates` | `templates.list` | full-access (test keys may read) |
| `POST` | `/templates` | `templates.create` | full-access **live** |
| `GET` | `/templates/{id}` | `templates.get` | full-access |
| `PATCH` | `/templates/{id}` | `templates.update` (partial; draft) | full-access live |
| `DELETE` | `/templates/{id}` | `templates.delete` | full-access live |
| `POST` | `/templates/{id}/publish` | `templates.publish` | full-access live |
| `POST` | `/templates/{id}/duplicate` | `templates.duplicate` | full-access live |
| `POST` | `/templates/{id}/render` | `templates.render` (draft; `variables` or the samples) | full-access (test keys allowed) |
| `POST` | `/templates/render` | `templates.renderSource` / `render_source` (`subject`, `html`, `text`, `variables`) | full-access (test keys allowed) |
| `GET` | `/templates/{id}/versions` | `templates.versions.list` | full-access |
| `GET` | `/templates/{id}/versions/{vid}` | `templates.versions.get` | full-access |
| `POST` | `/templates/{id}/versions/{vid}/restore` | `templates.versions.restore` | full-access live |
| `GET` | `/variables` | `variables.list` | full-access |
| `PUT` | `/variables/global/{key}` | `variables.setGlobal` / `set_global` | full-access live |
| `DELETE` | `/variables/global/{key}` | `variables.deleteGlobal` / `delete_global` | full-access live |

## Create / update body

| Field | Rule |
|---|---|
| `name` | Required on create; trimmed, 1–200 characters |
| `alias` | `^[a-z0-9][a-z0-9_-]{0,62}$`, unique (`409 conflict`) |
| `subject`, `html`, `text` | Mustache source; at least one of `html`/`text` ("html or text is required") |
| `from` | Default sender when a send omits `from` |
| `variables` | Sample values for previews; never used for sending |
| `variable_schema` | ≤ 200 entries `{name, type, required, default, example, description}`; replaces the declared list |
| `design` | Visual editor document: object with a numeric `version`, ≤ 1 MB ("design is larger than 1 MB"); `null` makes a code template |
| `publish` | `true` publishes in the same call |

Request body ≤ 4 MB (`413 payload_too_large`).

## Template object (selected fields)

`id`, `name`, `alias`, `subject`, `html`, `text`, `from`, `variables`, `variable_schema`,
`variable_names`, `status` (`draft` | `published`), `has_unpublished_changes`, `published_at`,
`published` (`subject`, `html`, `text`, `from`, `variable_schema`, `design`), `created_at`,
`updated_at`, `object: "template"`.

## Render response

```json
{
  "subject": "Hi Ann",
  "html": "",
  "text": "Hi Ann , your plan: ",
  "missing_variables": ["last_name", "plan.name"],
  "variable_names": ["first_name", "last_name", "plan"]
}
```

`POST /templates/{id}/render` uses, per variable, the value you pass, else its `example`, else
its `default`; without a `variables` object it uses the template's sample `variables`.
`POST /templates/render` uses only what you pass. Both add the account's globals and check
neither types nor required variables.

## Errors

| Code | HTTP | Message / when |
|---|---|---|
| `template_variables_missing` | 422 | Send: "missing required template variables: customer, total" (sorted) |
| `template_variables_invalid` | 422 | Send: "template variables of the wrong type: items" (checked first) |
| `template_render_error` | 422 | Send: "missing template variables: last_name, plan.name" (object fields, unset globals, pre-schema templates) |
| `template_render_error` | 422 | Save/render: "html: line 2, column 3: unclosed section {{#items}}" |
| `template_render_error` | 422 | Save: "html: line 4, column 1: {{#each items}} is not a variable name: letters, digits, _ and - (no spaces), parts joined with dots" |
| `template_render_error` | 422 | Render/send: "html: template output too large (lists nested too deep or too long)" |
| `invalid_parameter` | 422 | Send: "template receipt not found"; "template receipt is not published (POST /v1/templates/<id>/publish)"; "html/text cannot be combined with template"; `template.variables.global is reserved…` |
| `invalid_parameter` | 422 | Save: "variable_schema: items: type must be one of string, number, boolean, url, date, list, object, any"; bad/reserved/duplicate name; default or example of the wrong type; description over 500 bytes; more than 200 entries; bad alias |
| `missing_required_field` | 422 | "template.id is required"; "html or text is required" |
| `conflict` | 409 | "a template with this alias already exists" |
| `not_found` | 404 | "template not found" |
| `test_key_restricted` | 403 | Create, update, publish, duplicate, restore, delete with a test key |

In a batch the same codes appear per item in `errors[]`.
