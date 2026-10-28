# ZapSMTP Agent Skills

[Agent Skills](https://agentskills.io) that teach AI coding agents (Claude Code, Cursor, GitHub
Copilot, OpenAI Codex and others that read `SKILL.md`) to integrate
[ZapSMTP](https://zapsmtp.com) correctly: send, receive and track email, verify webhooks, use
templates, keep deliverability high and migrate from other providers.

Each skill is a folder with a `SKILL.md` (YAML front matter with `name` and a `description`
that tells the agent when to load it, then instructions) and optional `references/*.md` that the
skill links to for longer tables.

| Skill | Folder | Use it for |
|---|---|---|
| `zapsmtp` | this folder (`SKILL.md`) | Router: what ZapSMTP is, keys, base URL, SDKs, errors and retries; points to the others |
| `zapsmtp-send-email` | [`zapsmtp-send-email/`](zapsmtp-send-email/) | `POST /emails` and batches: every field, attachments, streams, scheduling, idempotency, responses, retries |
| `zapsmtp-webhooks` | [`zapsmtp-webhooks/`](zapsmtp-webhooks/) | Endpoints, event types and payloads, `Zap-Signature` verification, batches, retries, replay, click actions |
| `zapsmtp-templates` | [`zapsmtp-templates/`](zapsmtp-templates/) | Mustache syntax, variable schema, global variables, drafts and publishing, versions, sending by template |
| `zapsmtp-inbound` | [`zapsmtp-inbound/`](zapsmtp-inbound/) | Inbound domains, routes, `email.received`, attachments, conversations, replies, reply tracking |
| `zapsmtp-email-best-practices` | [`zapsmtp-email-best-practices/`](zapsmtp-email-best-practices/) | DKIM/SPF/DMARC, provider rules, unsubscribe, suppressions, warm-up, testing, monitoring |
| `zapsmtp-migrate` | [`zapsmtp-migrate/`](zapsmtp-migrate/) | Moving from Resend, SendGrid, Mailgun, Postmark or Amazon SES |

## Install

A skill is installed by copying its folder into a directory the tool scans. Copy the router
under the name `zapsmtp` (its `name`) and each sub-skill under its own folder name. The commands
below assume this repository is checked out and the shell is in `sdks/skills`.

### Claude Code

Project skills live in `.claude/skills/<skill-name>/SKILL.md`, personal ones in
`~/.claude/skills/<skill-name>/SKILL.md`
([docs](https://code.claude.com/docs/en/skills)).

```bash
DEST=.claude/skills            # or ~/.claude/skills for every project on this machine
mkdir -p "$DEST/zapsmtp"
cp -R SKILL.md LICENSE references "$DEST/zapsmtp/"
for s in zapsmtp-*/; do cp -R "$s" "$DEST/"; done
```

### Cursor

Cursor loads Agent Skills from `.agents/skills/` and `.cursor/skills/` in the project and from
`~/.agents/skills/` and `~/.cursor/skills/` for the user; it also reads `.claude/skills/` and
`~/.claude/skills/` for compatibility ([docs](https://cursor.com/docs/context/skills)). Use the
commands above with `DEST=.cursor/skills` (or `.agents/skills`).

### GitHub Copilot

Copilot loads project skills from `.github/skills/`, `.claude/skills/` or `.agents/skills/`, and
personal skills from `~/.copilot/skills/` or `~/.agents/skills/`
([docs](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)). Support covers
the Copilot cloud agent and code review on GitHub.com, Copilot CLI, the Copilot app, and agent
mode in VS Code, Visual Studio and JetBrains IDEs, depending on version; check the surface's
setup guide before relying on personal skills there. Use `DEST=.github/skills`.

### OpenAI Codex

Codex loads skills from `.agents/skills/` in the directory you start it in, its parent inside a
Git repository and the repository root, and from `$HOME/.agents/skills/` for the user; `name`
and `description` are required front matter, which every skill here has
([docs](https://learn.chatgpt.com/docs/build-skills)). Use `DEST=.agents/skills`.

`.agents/skills/` is read by Cursor, Copilot and Codex alike, so one copy there serves all three.

### Tools without skills support

Copy the relevant `SKILL.md` content into the tool's own instruction file instead (for example
`AGENTS.md` or `.github/copilot-instructions.md`), keeping the `references/` files where the
links point.

## Use

Ask in plain words; the agent loads the matching skill by its description:

- "Send a receipt email with the PDF invoice attached through ZapSMTP"
- "Add a webhook endpoint that marks bounced addresses in our database"
- "Create a ZapSMTP template for order confirmations with typed variables"
- "Build a support inbox: receive email on support.acme.com and reply in the thread"
- "Set up DKIM, SPF and DMARC for news.acme.com"
- "Move our SendGrid integration to ZapSMTP"

Prerequisites for the code the skills produce: a ZapSMTP account, an API key in `ZAP_API_KEY`
(a `zap_test_…` key while developing), `ZAP_BASE_URL` set to the API base URL your ZapSMTP docs
show, and for live sending a verified domain.

## Checking the examples

Every code example in these skills is checked by
[`scripts/check-examples.mjs`](scripts/check-examples.mjs):

```bash
PATH=$HOME/.local/node/bin:$HOME/.local/go/bin:$PATH node sdks/skills/scripts/check-examples.mjs
```

It runs cURL, Node.js, Python and Go examples against a mock of the API built from the OpenAPI
description (every request must use a documented path, query parameter and body field), type
checks them against the SDKs in `sdks/node`, `sdks/python` and `sdks/go`, drives the webhook
handlers with correctly and wrongly signed requests, runs the signature functions against the
shared vectors in `sdks/spec/webhook-vectors.json`, and renders every template example with
ZapSMTP's own template engine. A comment such as `<!-- check: webhook path=/hooks -->` before a
code block tells it how to check that block.

## License

MIT, see [LICENSE](LICENSE).
