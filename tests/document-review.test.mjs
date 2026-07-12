import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AliyunOssDocumentProvider,
  DocumentCatalogService,
  LocalProjectDocumentProvider,
  createProvidersFromProject,
  startDocumentReviewServer,
} from '../src/index.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'axis-document-review-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeProvider(documents) {
  return {
    id: 'fake-source',
    label: '测试来源',
    type: 'mock',
    async listDocuments() {
      return documents.map((document) => ({ ...document }));
    },
    async readDocument(locator) {
      const document = documents.find((item) => item.locator === locator);
      return {
        content: document.content,
        mediaType: document.mediaType,
        size: Buffer.byteLength(document.content),
        updatedAt: document.updatedAt,
      };
    },
  };
}

const documents = [{
  bucket: 'example-bucket',
  organizationId: 'org_example',
  projectSlug: 'example-project',
  path: 'architecture/business.md',
  locator: 'orgs/org_example/projects/example-project/architecture/business.md',
  mediaType: 'text/markdown',
  size: 16,
  updatedAt: '2026-07-12T01:00:00Z',
  content: '# 业务架构\n',
}];

{
  const service = new DocumentCatalogService([fakeProvider(documents)]);
  const catalog = await service.refresh();
  assert.equal(catalog.schema, 'axis.document_review.catalog');
  assert.deepEqual(catalog.totals, {
    sources: 1,
    buckets: 1,
    organizations: 1,
    projects: 1,
    documents: 1,
  });
  const document = catalog.buckets[0].organizations[0].projects[0].documents[0];
  assert.equal((await service.readDocument(document.id)).content, '# 业务架构\n');
}

await withTempDir(async (projectRoot) => {
  const docsRoot = path.join(projectRoot, '.axis', 'docs', 'orgs', 'org_example', 'projects', 'example-project');
  await mkdir(path.join(docsRoot, 'architecture'), { recursive: true });
  await writeFile(path.join(docsRoot, 'architecture', 'technical.md'), '# 技术架构\n', 'utf8');
  const provider = new LocalProjectDocumentProvider({ repo: projectRoot });
  const listed = await provider.listDocuments();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].organizationId, 'org_example');
  assert.equal(listed[0].projectSlug, 'example-project');
});

{
  let markerSeen = false;
  const provider = new AliyunOssDocumentProvider({
    bucket: 'example-bucket',
    prefix: 'docs',
    client: {
      async list({ marker }) {
        if (!marker) {
          return {
            isTruncated: true,
            nextMarker: 'next',
            objects: [{ name: 'docs/orgs/org_example/projects/example-project/architecture/business.md', size: 10 }],
          };
        }
        markerSeen = true;
        return { isTruncated: false, objects: [] };
      },
      async get(name) {
        return { content: Buffer.from(`# ${name}\n`) };
      },
    },
  });
  assert.equal((await provider.listDocuments()).length, 1);
  assert.equal(markerSeen, true);
}

await withTempDir(async (projectRoot) => {
  await mkdir(path.join(projectRoot, '.axis'), { recursive: true });
  await writeFile(path.join(projectRoot, '.axis', 'config.yml'), [
    'contract_version: "0.2"',
    'organization:',
    '  id: org_example',
    'project:',
    '  slug: example-project',
    'oss:',
    '  bucket: example-bucket',
    '  prefix: docs',
    '  endpoint_env: TEST_OSS_ENDPOINT',
    '  access_key_id_env: TEST_OSS_KEY',
    '  access_key_secret_env: TEST_OSS_SECRET',
  ].join('\n'), 'utf8');
  const providers = await createProvidersFromProject({
    repo: projectRoot,
    source: 'all',
    env: {
      TEST_OSS_ENDPOINT: 'oss-cn-example.aliyuncs.com',
      TEST_OSS_KEY: 'key',
      TEST_OSS_SECRET: 'secret',
    },
    ossClientFactory: () => ({ list: async () => ({ objects: [] }), get: async () => ({ content: Buffer.alloc(0) }) }),
  });
  assert.deepEqual(providers.map((provider) => provider.type), ['local-filesystem', 'aliyun-oss']);
});

await withTempDir(async (root) => {
  const publicDir = path.join(root, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<title>Axis Document Review</title>', 'utf8');
  await writeFile(path.join(publicDir, 'app.js'), '', 'utf8');
  await writeFile(path.join(publicDir, 'styles.css'), '', 'utf8');
  const service = new DocumentCatalogService([fakeProvider(documents)]);
  const running = await startDocumentReviewServer({ host: '127.0.0.1', port: 0, publicDir, service });
  try {
    assert.equal((await fetch(`${running.url}/api/health`)).status, 200);
    const catalog = await (await fetch(`${running.url}/api/catalog`)).json();
    assert.equal(catalog.totals.documents, 1);
    assert.match(await (await fetch(running.url)).text(), /Axis Document Review/);
  } finally {
    await running.close();
  }
});

assert.match(await readFile(new URL('../README.md', import.meta.url), 'utf8'), /Provider/i);
