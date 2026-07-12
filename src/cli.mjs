#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import {
  createProvidersFromProject,
  DocumentCatalogService,
  startDocumentReviewServer,
} from './index.mjs';

function valueOf(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function openUrl(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(command, args, () => undefined);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('axis-document-review --repo <project> [--source all|local|oss] [--host 127.0.0.1] [--port 4177] [--open]');
  process.exit(0);
}

const repo = path.resolve(valueOf('--repo', process.cwd()));
const source = valueOf('--source', 'all');
const host = valueOf('--host', '127.0.0.1');
const port = Number(valueOf('--port', '4177'));
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535');
if (!/^[A-Za-z0-9.:-]+$/.test(host)) throw new Error('--host contains unsupported characters');

const providers = await createProvidersFromProject({ repo, source });
const service = new DocumentCatalogService(providers);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const running = await startDocumentReviewServer({ host, port, publicDir, service });
console.log(JSON.stringify({
  ok: true,
  url: running.url,
  mode: 'read_only',
  source,
  providers: providers.map(({ id, label, type }) => ({ id, label, type })),
}, null, 2));
if (process.argv.includes('--open')) openUrl(running.url);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await running.close();
}
process.once('SIGINT', () => void close().finally(() => process.exit(0)));
process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
await new Promise(() => undefined);
