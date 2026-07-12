import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const html = await readFile(path.join(root, 'public', 'index.html'), 'utf8');
const css = await readFile(path.join(root, 'public', 'styles.css'), 'utf8');
const browserSourcePath = existsSync(path.join(root, 'src', 'browser.mjs'))
  ? path.join(root, 'src', 'browser.mjs')
  : path.join(root, 'public', 'app.js');
const browserSource = await readFile(browserSourcePath, 'utf8');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

assert.doesNotMatch(html, /overview-strip|bucketMetric|organizationMetric|projectMetric|documentMetric/);
assert.doesNotMatch(css, /\.overview-strip|\.metric-card/);
assert.match(browserSource, /activeSourceId/);
assert.match(browserSource, /selectSource/);
assert.match(browserSource, /<button class="source-item/);
assert.match(browserSource, /data-source-id/);
assert.match(browserSource, /bucket\.source_ids\.includes\(state\.activeSourceId\)/);
assert.match(browserSource, /elements\.documentList\.scrollTop\s*=\s*0/);
assert.match(browserSource, /loadDocument\(defaultDocument\.id,\s*\{\s*resetList:\s*projectChanged\s*\}\)/);
assert.match(browserSource, /if \(options\.resetList\) elements\.documentList\.scrollTop\s*=\s*0/);
assert.doesNotMatch(browserSource, /tree-summary/);
assert.match(css, /\.source-item\.active/);

const navigationMarkup = html.match(/<aside[^>]+class="navigation-panel"[\s\S]*?<\/aside>/)?.[0] ?? '';
const contentMarkup = html.match(/<section class="content-panel">[\s\S]*?<\/section>\s*<\/main>/)?.[0] ?? '';
assert.match(navigationMarkup, /class="document-list-panel navigation-documents"/);
assert.doesNotMatch(contentMarkup, /document-list-panel/);
assert.match(css, /\.workspace\s*\{[^}]*grid-template-columns:\s*330px\s+minmax\(0,\s*1fr\)/s);
assert.match(css, /\.navigation-panel\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*overflow:\s*hidden/s);
assert.match(css, /\.document-workbench\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
assert.match(css, /\.navigation-documents\s*\{[^}]*min-height:\s*0[^}]*flex:\s*1/s);
assert.match(css, /\.viewer-panel\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
assert.match(css, /\.viewer-content\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s);

for (const dependency of ['dompurify', 'highlight.js', 'marked', 'mermaid']) {
  assert.ok(packageJson.dependencies?.[dependency], `${dependency} should be a local runtime dependency`);
}
assert.match(browserSource, /from ['"]marked['"]/);
assert.match(browserSource, /from ['"]dompurify['"]/);
assert.match(browserSource, /from ['"]mermaid['"]/);
assert.match(browserSource, /from ['"]highlight\.js['"]/);
assert.match(browserSource, /DOMPurify\.sanitize/);
assert.match(browserSource, /mermaid\.run/);
assert.match(browserSource, /highlightElement/);

assert.match(html, /id="fullscreenButton"/);
assert.match(browserSource, /DEFAULT_DOCUMENT_TYPE\s*=\s*['"]MD['"]/);
assert.match(browserSource, /extractDocumentTitle/);
assert.match(browserSource, /hydrateDocumentTitles/);
assert.match(browserSource, /document-title/);
assert.match(browserSource, /document-link/);
assert.match(browserSource, /requestFullscreen/);
assert.match(browserSource, /fullscreenchange/);
assert.match(browserSource, /catch \(error\) \{[\s\S]*setFallbackFullscreen\(true\)/);
assert.match(css, /\.viewer-panel:fullscreen/);
assert.match(css, /\.icon-button\s*\{[^}]*white-space:\s*nowrap/s);
