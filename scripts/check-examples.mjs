#!/usr/bin/env node
// Checks every code example in the ZapSMTP Agent Skills (sdks/skills/**/SKILL.md and
// references/*.md).
//
//   PATH=$HOME/.local/node/bin:$HOME/.local/go/bin:$PATH node sdks/skills/scripts/check-examples.mjs [--keep] [filter]
//
// How a block is checked depends on its language and an optional directive on the line right
// before its fence: <!-- check: <mode> [key=value ...] -->
//
//   ts / typescript   run (default): type-checked with tsc against sdks/node, then executed
//                     against the mock API; typecheck: type-check only;
//                     webhook path=/x [batch=1] [event=bounced|click|received]: the Express app
//                     is started and sent correctly signed, duplicate, wrongly signed and stale
//                     requests (expects 2xx, 2xx, 400, 400);
//                     verify-fn name=f: f(rawBody, header, secret, now) against
//                     sdks/spec/webhook-vectors.json
//   python            run (default): mypy against sdks/python/src, then executed against the mock;
//                     typecheck; webhook (Flask test client); verify-fn
//   go                run (default when the block has func main): go vet, then go run against
//                     the mock; vet (default otherwise); webhook handler=f path=/x (httptest);
//                     verify-fn name=f (f(body, header, secret, now time.Time) bool)
//   bash              run (default): executed with ZAP_BASE_URL pointing at the mock; at least
//                     one request, all valid
//   json              parsed
//   render mode=html|text   the block (template), the next block (JSON variables) and the one
//                     after (expected output) are rendered with ZapSMTP's own engine
//                     (backend/internal/templates, through `go test -overlay`; nothing is
//                     written into the backend)
//   skip (reason)     not checked, counted as skipped
//
// The mock API is built from sdks/openapi/openapi.json: every request must hit a documented
// method and path, use only documented query parameters, send a body that matches the request
// schema with no unknown fields (the API rejects them too), and carry the test key. It answers
// with the operation's documented example.
//
// Placeholders the examples use for the reader's own code (db, jobs, orders, oldProvider) are
// provided as stubs. Toolchains and packages (express, @types/express, flask, mypy) are cached in
// $TMPDIR/zapsmtp-skills-check.
import { spawnSync, spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = resolve(HERE, '..');
const SDKS = resolve(SKILLS, '..');
const ROOT = resolve(SDKS, '..');
const CACHE = join(tmpdir(), 'zapsmtp-skills-check');
const WORK = join(CACHE, 'work');
const KEY = 'zap_test_skillcheck';
const SECRET = 'whsec_skillcheck_9c1f4e2a7b';
const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const FILTER = args.find((a) => !a.startsWith('--'));
const VECTORS = join(SDKS, 'spec/webhook-vectors.json');

const sh = (cmd, cmdArgs, opts = {}) => {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 300_000, ...opts });
  return { code: r.status ?? (r.error ? 127 : 1), out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}` };
};
// Commands that call the mock API must not block this process's event loop.
const run = (cmd, cmdArgs, opts = {}) => new Promise((resolveRun) => {
  const child = spawn(cmd, cmdArgs, { cwd: opts.cwd, env: opts.env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => { out += '\n(timed out)'; child.kill('SIGKILL'); }, opts.timeout ?? 120_000);
  child.on('error', (e) => { out += e.message; });
  child.on('close', (code) => { clearTimeout(timer); resolveRun({ code: code ?? 1, out }); });
});
const must = (r, what) => { if (r.code !== 0) { console.error(`${what} failed:\n${r.out}`); process.exit(2); } return r; };

// ---------------------------------------------------------------- extract blocks
function skillFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'scripts' && name !== 'node_modules') out.push(...skillFiles(p)); }
    else if (name === 'SKILL.md' || (dir.endsWith('references') && name.endsWith('.md'))) out.push(p);
  }
  return out.sort();
}

function parseDirective(line) {
  const m = /^<!--\s*check:\s*([a-z-]+)(.*?)-->\s*$/.exec(line.trim());
  if (!m) return null;
  const opts = {};
  for (const [, k, v] of m[2].matchAll(/([a-z]+)=(\S+)/g)) opts[k] = v;
  return { mode: m[1], opts, raw: m[2].trim() };
}

function extract(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\S*)/.exec(lines[i]);
    if (!open) continue;
    const start = i;
    const body = [];
    for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
    let j = start - 1;
    while (j >= 0 && lines[j].trim() === '') j--;
    const directive = j >= 0 ? parseDirective(lines[j]) : null;
    blocks.push({ file: relative(ROOT, file), line: start + 1, lang: open[1].toLowerCase(), code: body.join('\n'), directive });
  }
  return blocks;
}

const LANG = { ts: 'ts', typescript: 'ts', js: 'ts', javascript: 'ts', python: 'python', py: 'python', go: 'go', bash: 'bash', sh: 'bash', shell: 'bash', json: 'json' };

const all = skillFiles(SKILLS).flatMap(extract);
const jobs = [];
for (let i = 0; i < all.length; i++) {
  const b = all[i];
  if (FILTER && !`${b.file}:${b.line}`.includes(FILTER)) continue;
  const d = b.directive;
  if (d?.mode === 'render') {
    jobs.push({ ...b, kind: 'render', mode: d.opts.mode ?? 'html', vars: all[i + 1], want: all[i + 2] });
    i += 2;
    continue;
  }
  const lang = LANG[b.lang];
  if (d?.mode === 'skip') { jobs.push({ ...b, kind: 'skip', reason: d.raw }); continue; }
  if (!lang) { jobs.push({ ...b, kind: 'prose' }); continue; }
  let mode = d?.mode ?? 'run';
  if (lang === 'go' && !d && !/^func main\(\)/m.test(b.code)) mode = 'vet';
  if (lang === 'json') mode = 'parse';
  jobs.push({ ...b, kind: lang, mode, opts: d?.opts ?? {} });
}

// ---------------------------------------------------------------- mock API
const spec = JSON.parse(readFileSync(join(SDKS, 'openapi/openapi.json'), 'utf8'));
const ops = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    if (!item[method]) continue;
    const re = new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`);
    const params = [...(item.parameters ?? []), ...(item[method].parameters ?? [])];
    ops.push({ method: method.toUpperCase(), path, re, op: item[method], params });
  }
}
const deref = (s) => (s && s.$ref ? deref(s.$ref.split('/').slice(1).reduce((o, k) => o[k], spec)) : s);

function validate(schema, v, at, errs) {
  schema = deref(schema);
  if (!schema || Object.keys(schema).length === 0) return;
  if (schema.oneOf || schema.anyOf) {
    const alts = schema.oneOf ?? schema.anyOf;
    if (!alts.some((a) => { const e = []; validate(a, v, at, e); return e.length === 0; })) errs.push(`${at}: matches none of the allowed shapes (${JSON.stringify(v)?.slice(0, 80)})`);
    return;
  }
  if (schema.allOf) { for (const a of schema.allOf) validate(a, v, at, errs); return; }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (v === null) { if (!(schema.nullable || types.includes('null'))) errs.push(`${at}: null not allowed`); return; }
  const actual = Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
  if (types.length && !types.some((t) => t === actual || (t === 'number' && actual === 'integer'))) { errs.push(`${at}: expected ${types.join('|')}, got ${actual}`); return; }
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${at}: ${JSON.stringify(v)} not one of ${schema.enum.join(', ')}`);
  if (actual === 'array') {
    if (schema.minItems != null && v.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && v.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
    v.forEach((x, k) => validate(schema.items, x, `${at}[${k}]`, errs));
  }
  if (actual === 'object') {
    for (const r of schema.required ?? []) if (!(r in v)) errs.push(`${at}: missing required ${r}`);
    const props = schema.properties ?? {};
    for (const [k, x] of Object.entries(v)) {
      if (k in props) validate(props[k], x, `${at}.${k}`, errs);
      else if (schema.additionalProperties === undefined && schema.properties) errs.push(`${at}: unknown field ${k} (the API rejects unknown fields)`);
      else if (schema.additionalProperties === false) errs.push(`${at}: unknown field ${k}`);
      else if (typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, x, `${at}.${k}`, errs);
    }
  }
}

const mock = { requests: [], errors: [] };
const server = createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://mock');
    const path = url.pathname.replace(/^\/v1/, '');
    const where = `${req.method} ${url.pathname}${url.search}`;
    mock.requests.push(where);
    const errs = [];
    if (!url.pathname.startsWith('/v1/')) errs.push('path does not start with the /v1 base URL');
    if (req.headers.authorization !== `Bearer ${KEY}`) errs.push(`authorization: ${req.headers.authorization}`);
    const m = ops.find((o) => o.method === req.method && o.re.test(path));
    let status = 400;
    let body = { statusCode: 400, name: 'validation_error', message: 'mock: request did not validate' };
    if (!m) errs.push('no documented operation for this method and path');
    else {
      const query = m.params.filter((p) => p.in === 'query');
      for (const [k, v] of url.searchParams) {
        const p = query.find((q) => q.name === k || k.startsWith(`${q.name}[`));
        if (!p) errs.push(`unknown query parameter ${k}`);
        else if (p.schema?.enum && !p.schema.enum.includes(v)) errs.push(`query ${k}=${v}: not one of ${p.schema.enum.join(', ')}`);
      }
      const ik = req.headers['idempotency-key'];
      if (ik !== undefined && (ik.length < 1 || Buffer.byteLength(ik) > 256)) errs.push('Idempotency-Key must be 1-256 bytes');
      const bv = req.headers['x-batch-validation'];
      if (bv !== undefined && bv !== '' && !/^(strict|permissive)$/i.test(bv)) errs.push(`x-batch-validation: ${bv}`);
      const rb = m.op.requestBody?.content?.['application/json'];
      if (rb) {
        if (raw.length === 0) { if (m.op.requestBody.required) errs.push('missing JSON body'); }
        else {
          if (!/^application\/json/.test(req.headers['content-type'] ?? '')) errs.push(`content-type: ${req.headers['content-type']}`);
          let parsed;
          try { parsed = JSON.parse(raw); } catch { errs.push('body is not JSON'); }
          if (parsed !== undefined) validate(rb.schema, parsed, 'body', errs);
        }
      } else if (raw.length && !m.op.requestBody) errs.push('this operation takes no body');
      const okCode = Object.keys(m.op.responses).find((c) => /^2/.test(c)) ?? '200';
      status = Number(okCode);
      body = m.op.responses[okCode]?.content?.['application/json']?.example ?? null;
    }
    if (errs.length) {
      mock.errors.push(`${where}: ${errs.join('; ')}`);
      status = 400;
      body = { statusCode: 400, name: 'validation_error', message: errs.join('; '), error: { code: 'validation_error', message: errs.join('; '), type: 'invalid_request_error' } };
    }
    const headers = { 'X-Request-Id': 'req_skillcheck', 'RateLimit-Limit': '10', 'RateLimit-Remaining': '9', 'RateLimit-Reset': '1' };
    if (body === null || status === 204) { res.writeHead(status, headers); res.end(); return; }
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/v1`;
const ENV = { ...process.env, ZAPSMTP_ROLLOUT_PERCENT: '100', ZAP_API_KEY: KEY, ZAP_BASE_URL: BASE, ZAP_WEBHOOK_SECRET: SECRET, PYTHONDONTWRITEBYTECODE: '1' };
const takeMock = () => { const r = { requests: mock.requests.splice(0), errors: mock.errors.splice(0) }; return r; };

// ---------------------------------------------------------------- webhook fixtures
const events = {
  bounced: { id: 'evt_5f0c2a9b7d1e4c3a8b6f2e10', type: 'email.bounced', created_at: '2026-10-21T15:04:12.381Z',
    data: { email_id: '019a1f2e-7c3b-7d41-9a52-0c4b8e6f1a23', from: 'Acme <hello@acme.com>', to: 'jane@example.org', subject: 'Your receipt',
      tags: { category: 'receipt' }, metadata: { order_id: 'A-1042' }, stream: 'transactional', thread_id: '3f1c9a52-6b0e-5d4f-8a71-2c9e0b4d6f13', attempts: 1,
      response: { code: 550, message: '5.1.1 The email account that you tried to reach does not exist' },
      bounce: { type: 'Permanent', subType: 'MailboxDoesNotExist', message: '5.1.1 The email account that you tried to reach does not exist', suppressed: true } } },
  click: { id: 'evt_7a1d0c3e9b2f4a6c8e5d1b07', type: 'email.clicked', created_at: '2026-10-27T08:41:05.214Z',
    data: { email_id: '019a1f2e-7c3b-7d41-9a52-0c4b8e6f1a23', from: '<@acme.com>', to: 'jane@example.org', tags: { category: 'receipt' },
      metadata: { order_id: 'A-1042' }, stream: 'transactional',
      click: { link: 'https://acme.com/orders/A-1042/confirm', action: 'confirm_order', unique: true, ip_address: '203.0.113.24', user_agent: 'Mozilla/5.0' } } },
  received: { type: 'email.received', created_at: '2026-10-21T15:10:03.418Z',
    data: { email_id: '019a1f30-1d4e-7a6b-8c2d-3e4f5a6b7c8d', created_at: '2026-10-21T15:10:02.904Z', from: 'jane@example.org', from_name: 'Jane Doe',
      to: ['support+1234@acme.com'], cc: [], bcc: [], reply_to: [], received_for: ['support+1234@acme.com'], message_id: '<CAF=abc123@mail.example.org>',
      subject: 'Re: Ticket #1234', attachments: [], envelope: { from: 'jane@example.org', to: 'support+1234@acme.com' }, mailbox_hash: '1234',
      reply_text: 'Thanks, that fixed it!', in_reply_to_email_id: null, thread_id: '3f1c9a52-6b0e-5d4f-8a71-2c9e0b4d6f13', automated: null,
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass', arc: 'gray' }, spam: { score: 1.2, is_spam: false }, route_id: '', size: 61877 } },
};
// The requests every webhook handler gets, in order, with the status class it must answer.
function webhookCases(opts) {
  const ev = events[opts.event ?? 'bounced'];
  const body = JSON.stringify(opts.batch ? [ev, { ...events.click, id: 'evt_batch_second' }] : ev);
  const now = Math.floor(Date.now() / 1000);
  const sign = (t, b, secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${b}`).digest('hex')}`;
  const id = opts.batch ? 'bat_evt_5f0c2a9b' : ev.id ?? 'evt_received_1';
  const h = (sig) => ({ 'content-type': 'application/json', 'zap-signature': sig, 'zap-event-id': id, 'zap-webhook-id': '019a1f22-6e7f-7091-8a2b-3c4d5e6f7a8b' });
  return [
    { name: 'signed event', body, headers: h(sign(now, body)), want: 2 },
    { name: 'the same event again (retry)', body, headers: h(sign(now, body)), want: 2 },
    { name: 'signed with another secret', body, headers: h(sign(now, body, 'whsec_other')), want: 4 },
    { name: 'signature older than five minutes', body, headers: h(sign(now - 600, body)), want: 4 },
  ];
}

// ---------------------------------------------------------------- toolchain setup
mkdirSync(CACHE, { recursive: true });
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const need = { ts: jobs.some((j) => j.kind === 'ts'), python: jobs.some((j) => j.kind === 'python'), go: jobs.some((j) => j.kind === 'go'), render: jobs.some((j) => j.kind === 'render') };

const NODE_DIR = join(CACHE, 'node');
if (need.ts) {
  if (!existsSync(join(NODE_DIR, 'node_modules/express/package.json')) || !existsSync(join(NODE_DIR, 'node_modules/typescript/package.json'))) {
    mkdirSync(NODE_DIR, { recursive: true });
    writeFileSync(join(NODE_DIR, 'package.json'), '{"private": true}\n');
    must(sh('npm', ['install', '--no-audit', '--no-fund', 'express@4', '@types/express@4', '@types/node@20', 'typescript@5'], { cwd: NODE_DIR }), 'npm install');
  }
  // The SDK, built from sdks/node/src into this cache (nothing is written into sdks/node).
  const pkg = join(NODE_DIR, 'node_modules/zapsmtp');
  rmSync(pkg, { recursive: true, force: true });
  must(sh(join(NODE_DIR, 'node_modules/.bin/tsc'), ['-p', join(SDKS, 'node/tsconfig.json'), '--outDir', join(pkg, 'dist'), '--declaration', '--noEmit', 'false', '--rootDir', join(SDKS, 'node/src')]), 'building the Node SDK');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'zapsmtp', type: 'module', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } }, types: './dist/index.d.ts' }));
}
const PY_DIR = join(CACHE, 'py');
const PY = join(PY_DIR, 'bin/python');
if (need.python) {
  if (!existsSync(join(PY_DIR, 'ok'))) {
    must(sh('python3', ['-m', 'venv', PY_DIR]), 'python venv');
    must(sh(PY, ['-m', 'pip', 'install', '-q', 'flask>=3,<4', 'mypy', 'httpx>=0.27']), 'pip install');
    writeFileSync(join(PY_DIR, 'ok'), '');
  }
}

// ---------------------------------------------------------------- results
const results = [];
const record = (job, ok, detail = '') => results.push({ job, ok, detail });
const where = (j) => `${j.file}:${j.line}`;

// ---------------------------------------------------------------- TypeScript
if (need.ts) {
  const dir = join(NODE_DIR, 'ex');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsJobs = jobs.filter((j) => j.kind === 'ts');
  writeFileSync(join(dir, 'placeholders.d.ts'),
    '// Stand-ins for the reader\'s own code in the examples.\ndeclare const db: any;\ndeclare const jobs: any;\ndeclare const orders: any;\ndeclare const oldProvider: any;\n');
  tsJobs.forEach((j, k) => {
    j.dir = join(dir, `b${k}`);
    mkdirSync(j.dir);
    writeFileSync(join(j.dir, 'main.ts'), j.code + '\n');
    if (j.mode === 'verify-fn') {
      writeFileSync(join(j.dir, 'harness.ts'), `import { readFileSync } from 'node:fs';
import { ${j.opts.name} } from './main.js';
const { vectors } = JSON.parse(readFileSync(${JSON.stringify(VECTORS)}, 'utf8'));
let bad = 0;
for (const vec of vectors) {
  const got = ${j.opts.name}(vec.payload, vec.header, vec.secret, vec.now);
  if (got !== vec.valid) { bad++; console.error('vector ' + JSON.stringify(vec.name) + ': got ' + got + ', want ' + vec.valid); }
}
console.log(vectors.length + ' vectors, ' + bad + ' wrong');
process.exit(bad ? 1 : 0);
`);
    }
  });
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', strict: true, esModuleInterop: true,
      skipLibCheck: true, outDir: join(dir, 'out'), rootDir: dir, moduleDetection: 'force', types: ['node'], typeRoots: [join(NODE_DIR, 'node_modules/@types')] },
    include: ['**/*.ts'],
  }));
  writeFileSync(join(dir, 'package.json'), '{"type": "module"}\n');
  const tsc = sh(join(NODE_DIR, 'node_modules/.bin/tsc'), ['-p', join(dir, 'tsconfig.json')], { cwd: dir });
  const tsErrors = new Map();
  for (const line of tsc.out.split('\n')) {
    const m = /(?:^|\/)(b\d+)\/(?:main|harness)\.ts\((\d+),\d+\): (error .*)$/.exec(line);
    if (m) { const k = Number(m[1].slice(1)); (tsErrors.get(k) ?? tsErrors.set(k, []).get(k)).push(`line ${m[2]}: ${m[3]}`); }
  }
  if (tsc.code !== 0 && tsErrors.size === 0) { console.error(tsc.out); process.exit(2); }
  writeFileSync(join(dir, 'out/package.json'), '{"type": "module"}\n');
  writeFileSync(join(dir, 'preload.mjs'), `// Stubs for the reader's own code, and the webhook driver.
import http from 'node:http';
const stub = () => new Proxy(function () {}, { get: () => async () => undefined, apply: async () => undefined });
for (const n of ['db', 'jobs', 'orders', 'oldProvider']) globalThis[n] = stub();
const spec = process.env.CHECK_WEBHOOK ? JSON.parse(process.env.CHECK_WEBHOOK) : null;
process.on('unhandledRejection', (e) => { console.error('unhandled rejection:', e); process.exit(1); });
if (spec) {
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function () {
    const srv = listen.call(this, 0, '127.0.0.1');
    srv.on('listening', async () => {
      const port = srv.address().port;
      let bad = 0;
      for (const c of spec.cases) {
        const res = await fetch('http://127.0.0.1:' + port + spec.path, { method: 'POST', headers: c.headers, body: c.body });
        const ok = Math.floor(res.status / 100) === c.want;
        if (!ok) bad++;
        console.log((ok ? 'ok   ' : 'FAIL ') + c.name + ': HTTP ' + res.status);
      }
      await new Promise((r) => setTimeout(r, 300)); // work done after answering
      process.exit(bad ? 1 : 0);
    });
    return srv;
  };
}
`);
  for (const [k, j] of tsJobs.entries()) {
    if (tsErrors.has(k)) { record(j, false, `tsc:\n${tsErrors.get(k).join('\n')}`); continue; }
    if (j.mode === 'typecheck') { record(j, true, 'type-checked'); continue; }
    const runDir = join(WORK, `ts${k}`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'invoice.pdf'), '%PDF-1.4\n%skillcheck\n');
    const file = join(dir, 'out', `b${k}`, j.mode === 'verify-fn' ? 'harness.js' : 'main.js');
    const env = { ...ENV };
    if (j.mode === 'webhook') env.CHECK_WEBHOOK = JSON.stringify({ path: j.opts.path, cases: webhookCases(j.opts) });
    takeMock();
    const r = await run(process.execPath, ['--import', join(dir, 'preload.mjs'), file], { cwd: runDir, env, timeout: 60_000 });
    const m = takeMock();
    const ok = r.code === 0 && m.errors.length === 0;
    record(j, ok, `type-checked, ${j.mode}: exit ${r.code}, ${m.requests.length} API request(s)${m.errors.length ? `\nmock: ${m.errors.join('\n')}` : ''}${ok ? '' : `\n${r.out.trim()}`}`);
  }
}

// ---------------------------------------------------------------- Python
if (need.python) {
  const pyJobs = jobs.filter((j) => j.kind === 'python');
  const dir = join(WORK, 'py');
  mkdirSync(dir, { recursive: true });
  const prelude = 'from typing import Any\ndb: Any\njobs: Any\n';
  const plines = prelude.split('\n').length - 1;
  const runner = join(dir, 'runner.py');
  writeFileSync(runner, `import builtins, json, os, sys
class Stub:
    def __getattr__(self, name):
        return lambda *a, **k: None
for n in ("db", "jobs"):
    setattr(builtins, n, Stub())
code_path, mode, opts = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
src = open(code_path, encoding="utf-8").read()
ns = {"__name__": "example"}
exec(compile(src, code_path, "exec"), ns)
if mode == "verify-fn":
    fn = ns[opts["name"]]
    vectors = json.load(open(${JSON.stringify(VECTORS)}, encoding="utf-8"))["vectors"]
    bad = 0
    for v in vectors:
        got = fn(v["payload"].encode("utf-8"), v["header"], v["secret"], now=v["now"])
        if got is not v["valid"]:
            bad += 1
            print("vector", v["name"], "got", got, "want", v["valid"])
    print(len(vectors), "vectors,", bad, "wrong")
    sys.exit(1 if bad else 0)
if mode == "webhook":
    client = ns["app"].test_client()
    bad = 0
    for c in json.loads(os.environ["CHECK_WEBHOOK"])["cases"]:
        r = client.post(opts["path"], data=c["body"].encode("utf-8"), headers=c["headers"])
        ok = r.status_code // 100 == c["want"]
        bad += not ok
        print("ok  " if ok else "FAIL", c["name"], r.status_code)
    sys.exit(1 if bad else 0)
`);
  for (const [k, j] of pyJobs.entries()) {
    const f = join(dir, `b${k}.py`);
    writeFileSync(f, j.code + '\n');
    const mf = join(dir, `m${k}.py`);
    writeFileSync(mf, prelude + j.code + '\n');
    const my = sh(join(PY_DIR, 'bin/mypy'), ['--python-version', '3.9', '--check-untyped-defs', '--no-error-summary', '--cache-dir', join(CACHE, 'mypy-cache'), mf],
      { env: { ...ENV, MYPYPATH: join(SDKS, 'python/src') } });
    if (my.code !== 0) {
      record(j, false, `mypy:\n${my.out.replace(new RegExp(`${mf}:(\\d+)`, 'g'), (_, n) => `line ${Number(n) - plines}`)}`);
      continue;
    }
    if (j.mode === 'typecheck') { record(j, true, 'mypy clean'); continue; }
    const env = { ...ENV, PYTHONPATH: join(SDKS, 'python/src') };
    if (j.mode === 'webhook') env.CHECK_WEBHOOK = JSON.stringify({ cases: webhookCases(j.opts) });
    const runDir = join(WORK, `py${k}`);
    mkdirSync(runDir, { recursive: true });
    takeMock();
    const r2 = await run(PY, [runner, f, j.mode, JSON.stringify(j.opts)], { cwd: runDir, env, timeout: 60_000 });
    const m = takeMock();
    const ok = r2.code === 0 && m.errors.length === 0;
    record(j, ok, `mypy clean, ${j.mode}: exit ${r2.code}, ${m.requests.length} API request(s)${m.errors.length ? `\nmock: ${m.errors.join('\n')}` : ''}${ok ? '' : `\n${r2.out.trim()}`}`);
  }
}

// ---------------------------------------------------------------- Go
if (need.go) {
  const goJobs = jobs.filter((j) => j.kind === 'go');
  for (const [k, j] of goJobs.entries()) {
    const dir = join(WORK, `go${k}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'go.mod'), `module skillcheck\n\ngo 1.23\n\nrequire github.com/zapsmtp/zapsmtp-go v0.0.0\n\nreplace github.com/zapsmtp/zapsmtp-go => ${join(SDKS, 'go')}\n`);
    writeFileSync(join(dir, 'main.go'), j.code + '\n');
    const hasMain = /^func main\(\)/m.test(j.code);
    if (j.mode === 'verify-fn') {
      writeFileSync(join(dir, 'harness_test.go'), `package main

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

${hasMain ? '' : 'func main() {}\n'}
func TestVectors(t *testing.T) {
	raw, err := os.ReadFile(${JSON.stringify(VECTORS)})
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Vectors []struct {
			Name, Secret, Payload, Header string
			Now                           int64
			Valid                         bool
		}
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	for _, v := range f.Vectors {
		if got := ${j.opts.name}([]byte(v.Payload), v.Header, v.Secret, time.Unix(v.Now, 0)); got != v.Valid {
			t.Errorf("vector %q: got %v, want %v", v.Name, got, v.Valid)
		}
	}
	t.Logf("%d vectors", len(f.Vectors))
}
`);
    }
    if (j.mode === 'webhook') {
      writeFileSync(join(dir, 'harness_test.go'), `package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestWebhook(t *testing.T) {
	var spec struct {
		Cases []struct {
			Name, Body string
			Headers    map[string]string
			Want       int
		}
	}
	if err := json.Unmarshal([]byte(os.Getenv("CHECK_WEBHOOK")), &spec); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST ${j.opts.path}", ${j.opts.handler})
	for _, c := range spec.Cases {
		req := httptest.NewRequest("POST", "${j.opts.path}", strings.NewReader(c.Body))
		for k, v := range c.Headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code/100 != c.Want {
			t.Errorf("%s: HTTP %d", c.Name, rec.Code)
		}
	}
}
`);
    }
    const env = { ...ENV, GOFLAGS: '-mod=mod', GOWORK: 'off', CHECK_WEBHOOK: JSON.stringify({ cases: webhookCases(j.opts) }) };
    const vet = sh('go', ['vet', '.'], { cwd: dir, env });
    if (vet.code !== 0) { record(j, false, `go vet:\n${vet.out}`); continue; }
    if (j.mode === 'vet') { record(j, true, 'go vet clean'); continue; }
    takeMock();
    const r = j.mode === 'run' ? await run('go', ['run', '.'], { cwd: dir, env, timeout: 120_000 }) : await run('go', ['test', '-count=1', '-v', '.'], { cwd: dir, env, timeout: 120_000 });
    const m = takeMock();
    const ok = r.code === 0 && m.errors.length === 0;
    record(j, ok, `go vet clean, ${j.mode}: exit ${r.code}, ${m.requests.length} API request(s)${m.errors.length ? `\nmock: ${m.errors.join('\n')}` : ''}${ok ? '' : `\n${r.out.trim()}`}`);
  }
}

// ---------------------------------------------------------------- bash (cURL)
for (const [k, j] of jobs.filter((x) => x.kind === 'bash').entries()) {
  if (j.mode !== 'run') { record(j, false, `unknown mode ${j.mode}`); continue; }
  takeMock();
  const r = await run('bash', ['-euo', 'pipefail', '-c', j.code], { cwd: WORK, env: ENV, timeout: 60_000 });
  const m = takeMock();
  const ok = r.code === 0 && m.errors.length === 0 && m.requests.length > 0;
  record(j, ok, `exit ${r.code}, ${m.requests.length} API request(s)${m.errors.length ? `\nmock: ${m.errors.join('\n')}` : ''}${ok ? '' : `\n${r.out.trim()}`}`);
  void k;
}

// ---------------------------------------------------------------- JSON
for (const j of jobs.filter((x) => x.kind === 'json')) {
  try { JSON.parse(j.code); record(j, true, 'valid JSON'); } catch (e) { record(j, false, `invalid JSON: ${e.message}`); }
}

// ---------------------------------------------------------------- templates (ZapSMTP's engine)
const renderJobs = jobs.filter((j) => j.kind === 'render');
if (renderJobs.length) {
  const cases = [];
  for (const j of renderJobs) {
    let vars;
    try { vars = JSON.parse(j.vars.code); } catch (e) { record(j, false, `variables block at line ${j.vars?.line} is not JSON: ${e.message}`); continue; }
    if (!j.want) { record(j, false, 'no expected-output block'); continue; }
    cases.push({ j, c: { Src: j.code, Vars: vars, HTML: j.mode === 'html', Want: j.want.code } });
  }
  const dir = join(WORK, 'render');
  mkdirSync(dir, { recursive: true });
  const casesFile = join(dir, 'cases.json');
  writeFileSync(casesFile, JSON.stringify(cases.map((x) => x.c)));
  const testFile = join(dir, 'zz_skillcheck_test.go');
  writeFileSync(testFile, `package templates

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

func TestSkillExamples(t *testing.T) {
	raw, err := os.ReadFile(${JSON.stringify(casesFile)})
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Src  string
		Vars map[string]any
		HTML bool
		Want string
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		res, err := Render(c.Src, c.Vars, c.HTML)
		got := res.Output
		if err != nil {
			got = "ERROR: " + err.Error()
		}
		out, _ := json.Marshal(map[string]any{"i": i, "ok": got == c.Want, "got": got, "missing": res.Missing})
		fmt.Println("SKILLCHECK " + string(out))
	}
}
`);
  const backend = join(ROOT, 'backend');
  const overlay = join(dir, 'overlay.json');
  writeFileSync(overlay, JSON.stringify({ Replace: { [join(backend, 'internal/templates/zz_skillcheck_test.go')]: testFile } }));
  const r = sh('go', ['test', `-overlay=${overlay}`, '-count=1', '-run', '^TestSkillExamples$', '-v', './internal/templates'], { cwd: backend, env: { ...ENV, GOWORK: 'off' }, timeout: 300_000 });
  const lines = r.out.split('\n').filter((l) => l.startsWith('SKILLCHECK ')).map((l) => JSON.parse(l.slice(11)));
  if (lines.length !== cases.length) for (const { j } of cases) record(j, false, `go test failed:\n${r.out.slice(0, 4000)}`);
  else for (const x of lines) {
    const { j } = cases[x.i];
    record(j, x.ok, x.ok ? `rendered by backend/internal/templates (${j.mode})` : `rendered output differs:\n--- got\n${x.got}\n--- want\n${j.want.code}`);
  }
}

// ---------------------------------------------------------------- report
server.close();
for (const j of jobs.filter((x) => x.kind === 'skip' || x.kind === 'prose')) results.push({ job: j, ok: null, detail: j.kind === 'skip' ? `skipped ${j.reason}` : `not code (${j.lang || 'plain'})` });
results.sort((a, b) => (a.job.file + String(a.job.line).padStart(5, '0')).localeCompare(b.job.file + String(b.job.line).padStart(5, '0')));
const tally = {};
for (const r of results) {
  const k = r.job.kind === 'ts' || r.job.kind === 'python' || r.job.kind === 'go' ? `${r.job.kind} ${r.job.mode}` : r.job.kind;
  tally[k] ??= { pass: 0, fail: 0, n: 0 };
  tally[k].n++;
  if (r.ok === true) tally[k].pass++;
  if (r.ok === false) tally[k].fail++;
  if (r.ok === false || process.env.VERBOSE) console.log(`${r.ok === false ? 'FAIL' : r.ok ? 'ok  ' : '--  '} ${where(r.job)} [${k}] ${r.detail}\n`);
}
console.log('\nSummary (checked blocks):');
for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(18)} ${v.n} blocks${v.pass || v.fail ? `: ${v.pass} passed, ${v.fail} failed` : ''}`);
const failed = results.filter((r) => r.ok === false).length;
console.log(failed ? `\n${failed} example(s) failed` : '\nAll examples passed');
if (!KEEP) rmSync(WORK, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
