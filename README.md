# W3C Site Validator

Batch-validates **every page of a website** against the W3C (Nu) HTML checker and groups the errors by root cause — so "hundreds of validation errors" collapses into the handful of shared includes/templates that actually need fixing.

The Nu checker runs **locally** (bundled `vnu.jar`), so there are no API rate limits; a 50-page site scans in about a minute.

## Requirements

- Node 18+
- Java 11+ (`java -version`)

## Setup

```
npm install
```

## Web interface

```
npm start        # → http://localhost:8321
```

Enter a site URL, hit **Scan all pages**, watch the live log, and get a report with issues grouped by root cause (errors first, most frequent first). Past reports are listed on the home page.

## CLI

```
node validate-site.mjs https://anvilfence.com/ [--limit N]
```

Output goes to `reports/<domain>/`:

- `report.md` — human-readable grouped report
- `report.json` — full data incl. complete page lists per issue
- `pages/` — the downloaded HTML that was validated

## How it works

1. Discovers pages from `sitemap.xml` (follows nested sitemaps; falls back to crawling homepage links)
2. Downloads every page (8 concurrent fetches)
3. Runs `vnu.jar` over all pages in a single pass
4. Normalizes messages (collapses attribute values) so identical template bugs group together, then reports each distinct issue with count, affected pages, and example lines/snippets

## Fix workflow

This tool intentionally **does not auto-edit sites**. The intended loop:

1. Scan → report shows e.g. *"ERROR ×173 on 47 pages: Element X not allowed as child of Y"* → that's one shared include (nav, footer, gallery…)
2. Fix the shared `.cfm`/template file locally (with judgment — some W3C fixes can break CSS/JS that hooks on the invalid markup)
3. Upload, then re-scan to confirm 0 errors

## Docker (for hosting)

```
docker build -t w3-validator .
docker run -p 8321:8321 w3-validator
```

Deployable to any container host (Render, Railway, Fly.io, …). Note: the scanner fetches arbitrary URLs, so if hosted publicly, put it behind auth.
