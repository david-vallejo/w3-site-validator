#!/usr/bin/env node
// Site-wide W3C (Nu) validator.
// Usage: node validate-site.mjs https://anvilfence.com/ [--limit N]
// Discovers pages via sitemap.xml (falls back to crawling the homepage),
// downloads each page, runs the local Nu checker over all of them in one pass,
// and writes a report grouped by error message so shared-include root causes
// are obvious. Output: reports/<domain>/report.md, report.json, pages/

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const VNU_JAR = join(TOOL_DIR, 'node_modules', 'vnu-jar', 'build', 'dist', 'vnu.jar');
const UA = 'DotComW3Validator/1.0 (+site maintenance; batch validation)';

const args = process.argv.slice(2);
const baseArg = args.find(a => !a.startsWith('--'));
if (!baseArg) {
  console.error('Usage: node validate-site.mjs <https://site.com/> [--limit N]');
  process.exit(1);
}
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

const base = new URL(baseArg);
const host = base.hostname.replace(/^www\./, '');
const OUT_DIR = join(TOOL_DIR, 'reports', host);
const PAGES_DIR = join(OUT_DIR, 'pages');
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(PAGES_DIR, { recursive: true });

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
}

function sameSite(u) {
  try {
    const url = new URL(u, base);
    return url.hostname.replace(/^www\./, '') === host;
  } catch { return false; }
}

// --- 1. Discover page URLs ---
let pageUrls = new Set();
try {
  const seedXml = await get(new URL('/sitemap.xml', base));
  let locs = extractLocs(seedXml);
  // sitemap index / nested sitemaps (e.g. sitemap-blog.cfm)
  const nested = locs.filter(l => /sitemap[^/]*\.(xml|cfm)$/i.test(l));
  const pages = locs.filter(l => !nested.includes(l));
  pages.forEach(l => sameSite(l) && pageUrls.add(l));
  for (const sm of nested) {
    try { extractLocs(await get(sm)).forEach(l => sameSite(l) && pageUrls.add(l)); }
    catch (e) { console.error(`  ! nested sitemap failed: ${sm}`); }
  }
  console.log(`Discovered ${pageUrls.size} pages from sitemap(s).`);
} catch {
  console.log('No sitemap.xml — crawling internal links from homepage.');
  const html = await get(base);
  pageUrls.add(base.href);
  [...html.matchAll(/href="([^"#?]+)"/g)]
    .map(m => m[1])
    .filter(h => !/\.(jpg|jpeg|png|gif|webp|pdf|css|js|ico|svg|xml)$/i.test(h))
    .forEach(h => { try { const u = new URL(h, base); if (sameSite(u)) pageUrls.add(u.href); } catch {} });
  console.log(`Found ${pageUrls.size} internal links.`);
}

let urls = [...pageUrls].slice(0, LIMIT);

// --- 2. Download pages ---
function slugFor(u) {
  const p = new URL(u).pathname.replace(/\/$/, '') || 'home';
  return (p.replace(/^\//, '').replace(/[^a-zA-Z0-9-]/g, '_') || 'home') + '.html';
}

const fileToUrl = {};
let done = 0, failed = [];
const queue = [...urls];
async function worker() {
  while (queue.length) {
    const u = queue.shift();
    const slug = slugFor(u);
    try {
      const html = await get(u);
      writeFileSync(join(PAGES_DIR, slug), html);
      fileToUrl[slug] = u;
    } catch (e) {
      failed.push({ url: u, error: e.message });
    }
    if (++done % 25 === 0) console.log(`  fetched ${done}/${urls.length}`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`Fetched ${Object.keys(fileToUrl).length}/${urls.length} pages${failed.length ? `, ${failed.length} failed` : ''}.`);

// --- 3. Validate all pages in one vnu pass ---
console.log('Running Nu HTML Checker...');
let vnuOut;
try {
  vnuOut = execFileSync('java', ['-jar', VNU_JAR, '--format', 'json', '--skip-non-html', PAGES_DIR],
    { maxBuffer: 1024 * 1024 * 256, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
} catch (e) {
  // vnu exits non-zero when errors are found; the JSON is on stderr
  vnuOut = (e.stderr || e.stdout || '').toString();
}
const messages = JSON.parse(vnuOut || '{"messages":[]}').messages || [];

// --- 4. Aggregate: group by normalized message ---
function normalize(msg) {
  // collapse attribute values / duplicate-id specifics so identical template bugs group together
  return msg.replace(/“[^”]*”/g, '“…”').replace(/"[^"]*"/g, '"…"');
}

const groups = new Map();
for (const m of messages) {
  const slug = decodeURIComponent(m.url || '').split('/').pop();
  const url = fileToUrl[slug] || slug;
  const key = `${m.type === 'info' ? 'warning' : m.type}|${normalize(m.message)}`;
  if (!groups.has(key)) groups.set(key, { type: m.type === 'info' ? 'warning' : m.type, message: normalize(m.message), count: 0, examples: [], pages: new Set() });
  const g = groups.get(key);
  g.count++;
  g.pages.add(url);
  if (g.examples.length < 3) g.examples.push({ url, line: m.lastLine, exact: m.message, extract: (m.extract || '').trim().slice(0, 200) });
}

const sorted = [...groups.values()].sort((a, b) => (a.type === 'error' ? 0 : 1) - (b.type === 'error' ? 0 : 1) || b.count - a.count);
const totalErrors = messages.filter(m => m.type === 'error').length;
const totalWarnings = messages.length - totalErrors;
const cleanPages = Object.values(fileToUrl).filter(u => !messages.some(m => (fileToUrl[decodeURIComponent(m.url || '').split('/').pop()] === u))).length;

// --- 5. Reports ---
const json = {
  site: base.href, scannedAt: null, pagesScanned: Object.keys(fileToUrl).length,
  totalErrors, totalWarnings, cleanPages, fetchFailures: failed,
  groups: sorted.map(g => ({ ...g, pages: [...g.pages].sort() })),
};
writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(json, null, 2));

let md = `# W3C Validation Report — ${host}\n\n`;
md += `Pages scanned: **${json.pagesScanned}** · Errors: **${totalErrors}** · Warnings: **${totalWarnings}** · Clean pages: **${cleanPages}**\n\n`;
md += `Distinct issues: **${sorted.length}** — most repeat across pages, meaning one shared include/template fix clears the whole group.\n\n`;
if (failed.length) md += `> ⚠️ ${failed.length} pages failed to fetch — see report.json.\n\n`;
for (const [i, g] of sorted.entries()) {
  md += `## ${i + 1}. [${g.type.toUpperCase()} ×${g.count} on ${g.pages.size} page${g.pages.size > 1 ? 's' : ''}] ${g.message}\n\n`;
  for (const ex of g.examples) md += `- ${ex.url} (line ${ex.line})\n  \`${ex.extract.replace(/`/g, "'")}\`\n`;
  if (g.pages.size <= 10) md += `\n  Pages: ${[...g.pages].map(p => new URL(p).pathname).join(' , ')}\n`;
  else md += `\n  Affects ${g.pages.size} pages (full list in report.json)\n`;
  md += `\n`;
}
writeFileSync(join(OUT_DIR, 'report.md'), md);

console.log(`\n${'='.repeat(60)}`);
console.log(`Pages: ${json.pagesScanned}  Errors: ${totalErrors}  Warnings: ${totalWarnings}  Distinct issues: ${sorted.length}`);
console.log(`Report: ${join(OUT_DIR, 'report.md')}`);
