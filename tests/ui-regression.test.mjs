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

for (const target of ['buckets', 'organizations', 'projects', 'documents']) {
  assert.match(
    html,
    new RegExp(`<button[^>]+class="metric-card[^"]*"[^>]+data-drilldown="${target}"`),
    `${target} metric should be an interactive drill-down button`,
  );
}
assert.match(browserSource, /\[data-drilldown\]/);
assert.match(browserSource, /scrollIntoView/);

assert.match(css, /\.document-workbench\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/s);
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
