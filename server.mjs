#!/usr/bin/env node
// Web UI for the site-wide W3C validator.
// Usage: node server.mjs  →  http://localhost:8321
// Zero dependencies: plain Node http + the validate-site.mjs CLI.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(TOOL_DIR, 'reports');
const PORT = process.env.PORT || 8321;

// one scan at a time; jobs keyed by hostname
const jobs = new Map(); // host -> {running, log[], startedAt, error}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const CSS = `
  :root{--bg:#f6f7f9;--card:#fff;--ink:#1a202c;--sub:#64748b;--accent:#2563eb;--err:#dc2626;--warn:#d97706;--ok:#16a34a;--line:#e2e8f0}
  @media (prefers-color-scheme:dark){:root{--bg:#0f172a;--card:#1e293b;--ink:#e2e8f0;--sub:#94a3b8;--accent:#60a5fa;--err:#f87171;--warn:#fbbf24;--ok:#4ade80;--line:#334155}}
  *{box-sizing:border-box}body{margin:0;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--ink)}
  .wrap{max-width:880px;margin:0 auto;padding:32px 20px}
  h1{font-size:1.5em;margin:0 0 4px}h1 a{color:inherit;text-decoration:none}
  .sub{color:var(--sub);margin:0 0 24px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:16px}
  input[type=url]{width:100%;padding:10px 12px;font-size:15px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
  button{margin-top:10px;padding:10px 20px;font-size:15px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer;font-weight:600}
  button:disabled{opacity:.5;cursor:default}
  pre.log{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;font-size:12.5px;overflow-x:auto;max-height:280px;overflow-y:auto;white-space:pre-wrap}
  table{width:100%;border-collapse:collapse;font-size:14px}
  td,th{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line)}th{color:var(--sub);font-weight:600}
  a{color:var(--accent)}
  .pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:700;color:#fff}
  .pill.error{background:var(--err)}.pill.warning{background:var(--warn)}
  .stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 18px;min-width:110px}
  .stat b{display:block;font-size:1.5em}.stat span{color:var(--sub);font-size:12.5px}
  .issue{margin-bottom:14px}
  .issue summary{cursor:pointer;font-weight:600;padding:4px 0}
  .issue .meta{color:var(--sub);font-size:13px;margin:6px 0}
  code{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:12.5px;word-break:break-all}
  ul.pages{columns:2;font-size:13px;margin:8px 0;padding-left:18px}
`;

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body><div class="wrap">
<h1><a href="/">W3C Site Validator</a></h1><p class="sub">Batch-validates every page on a site (Nu HTML Checker, run locally) and groups errors by root cause.</p>
${body}</div></body></html>`;
}

function listReports() {
  if (!existsSync(REPORTS_DIR)) return [];
  return readdirSync(REPORTS_DIR)
    .filter(d => existsSync(join(REPORTS_DIR, d, 'report.json')))
    .map(d => {
      const r = JSON.parse(readFileSync(join(REPORTS_DIR, d, 'report.json'), 'utf8'));
      const mtime = statSync(join(REPORTS_DIR, d, 'report.json')).mtime;
      return { host: d, pages: r.pagesScanned, errors: r.totalErrors, warnings: r.totalWarnings, issues: r.groups.length, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function homePage() {
  const rows = listReports().map(r =>
    `<tr><td><a href="/r/${esc(r.host)}">${esc(r.host)}</a></td><td>${r.pages}</td>
     <td style="color:var(--err);font-weight:600">${r.errors}</td><td style="color:var(--warn)">${r.warnings}</td>
     <td>${r.issues}</td><td>${r.mtime.toISOString().slice(0, 16).replace('T', ' ')}</td></tr>`).join('');
  return page('W3C Site Validator', `
<div class="card"><form id="f">
  <label for="url"><b>Scan a site</b></label>
  <input type="url" id="url" placeholder="https://anvilfence.com/" required>
  <button id="go">Scan all pages</button>
</form><pre class="log" id="log" style="display:none"></pre></div>
${rows ? `<div class="card"><b>Past reports</b><table><tr><th>Site</th><th>Pages</th><th>Errors</th><th>Warnings</th><th>Distinct issues</th><th>Scanned (UTC)</th></tr>${rows}</table></div>` : ''}
<script>
const f=document.getElementById('f'),log=document.getElementById('log'),go=document.getElementById('go');
f.onsubmit=async e=>{e.preventDefault();go.disabled=true;log.style.display='block';log.textContent='Starting…\\n';
 const res=await fetch('/api/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:document.getElementById('url').value})});
 const {host,error}=await res.json();
 if(error){log.textContent+='ERROR: '+error;go.disabled=false;return}
 const poll=setInterval(async()=>{
   const s=await(await fetch('/api/status?host='+host)).json();
   log.textContent=s.log.join('\\n');log.scrollTop=log.scrollHeight;
   if(!s.running){clearInterval(poll);if(s.error){log.textContent+='\\nFAILED';go.disabled=false}else location.href='/r/'+host}
 },1500)};
</script>`);
}

function reportPage(host) {
  const f = join(REPORTS_DIR, host, 'report.json');
  if (!existsSync(f)) return null;
  const r = JSON.parse(readFileSync(f, 'utf8'));
  const issues = r.groups.map((g, i) => `
<details class="issue" ${i < 3 ? 'open' : ''}><summary><span class="pill ${g.type}">${g.type.toUpperCase()} ×${g.count}</span> ${esc(g.message)}</summary>
 <div class="meta">Affects ${g.pages.length} page${g.pages.length > 1 ? 's' : ''}. Examples:</div>
 ${g.examples.map(ex => `<div class="meta"><a href="${esc(ex.url)}" target="_blank">${esc(new URL(ex.url).pathname)}</a> line ${ex.line} — <code>${esc(ex.extract)}</code></div>`).join('')}
 ${g.pages.length <= 30 ? `<ul class="pages">${g.pages.map(p => `<li>${esc(new URL(p).pathname)}</li>`).join('')}</ul>` : `<div class="meta">(${g.pages.length} pages — full list in report.json)</div>`}
</details>`).join('');
  return page(`${host} — W3C report`, `
<div class="stats">
 <div class="stat"><b>${r.pagesScanned}</b><span>pages scanned</span></div>
 <div class="stat"><b style="color:var(--err)">${r.totalErrors}</b><span>errors</span></div>
 <div class="stat"><b style="color:var(--warn)">${r.totalWarnings}</b><span>warnings</span></div>
 <div class="stat"><b>${r.groups.length}</b><span>distinct issues</span></div>
 <div class="stat"><b style="color:var(--ok)">${r.cleanPages}</b><span>clean pages</span></div>
</div>
<div class="card"><b>${esc(r.site)}</b> — issues grouped by root cause, errors first, most frequent first. A group spanning many pages = one shared include/template to fix.</div>
${issues}`);
}

const PASSWORD = process.env.ACCESS_PASSWORD;

const server = createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body, type = 'text/html') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };

  if (PASSWORD) {
    const given = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString().split(':').pop();
    if (given !== PASSWORD) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="W3C Site Validator"' });
      return res.end('Auth required');
    }
  }

  if (req.method === 'GET' && u.pathname === '/') return send(200, homePage());

  if (req.method === 'POST' && u.pathname === '/api/scan') {
    let body = '';
    for await (const c of req) body += c;
    let target;
    try { target = new URL(JSON.parse(body).url); } catch { return send(400, JSON.stringify({ error: 'invalid URL' }), 'application/json'); }
    if (!/^https?:$/.test(target.protocol)) return send(400, JSON.stringify({ error: 'http(s) only' }), 'application/json');
    const host = target.hostname.replace(/^www\./, '');
    if ([...jobs.values()].some(j => j.running)) return send(409, JSON.stringify({ error: 'a scan is already running — wait for it to finish' }), 'application/json');
    const job = { running: true, log: [], error: null };
    jobs.set(host, job);
    const child = spawn(process.execPath, [join(TOOL_DIR, 'validate-site.mjs'), target.href], { cwd: TOOL_DIR });
    const onData = d => job.log.push(...d.toString().split('\n').filter(Boolean));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', code => { job.running = false; if (code !== 0) job.error = `exit ${code}`; });
    return send(200, JSON.stringify({ host }), 'application/json');
  }

  if (req.method === 'GET' && u.pathname === '/api/status') {
    const job = jobs.get(u.searchParams.get('host'));
    if (!job) return send(404, JSON.stringify({ error: 'no such job' }), 'application/json');
    return send(200, JSON.stringify(job), 'application/json');
  }

  const rMatch = u.pathname.match(/^\/r\/([a-z0-9.-]+)$/);
  if (req.method === 'GET' && rMatch) {
    const html = reportPage(rMatch[1]);
    return html ? send(200, html) : send(404, page('Not found', '<div class="card">No report for that site yet.</div>'));
  }

  send(404, page('Not found', '<div class="card">404</div>'));
});

server.listen(PORT, () => console.log(`W3C Site Validator UI → http://localhost:${PORT}`));
