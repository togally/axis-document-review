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
    archives: 0,
  });
  const document = catalog.buckets[0].organizations[0].projects[0].documents[0];
  assert.equal((await service.readDocument(document.id)).content, '# 业务架构\n');
}

{
  const hierarchyDocuments = [
    {
      ...documents[0],
      locator: 'orgs/org_example/projects/example-project/architecture/business.md',
    },
    ...['commerce', 'service'].flatMap((capabilityId) => [
      {
        ...documents[0],
        path: `business/capabilities/${capabilityId}/detailed-design.md`,
        locator: `orgs/org_example/projects/example-project/business/capabilities/${capabilityId}/detailed-design.md`,
        content: `# ${capabilityId} 详细设计\n`,
      },
      {
        ...documents[0],
        path: `business/capabilities/${capabilityId}/secondary-capabilities/${capabilityId}_one/detailed-design.md`,
        locator: `orgs/org_example/projects/example-project/business/capabilities/${capabilityId}/secondary-capabilities/${capabilityId}_one/detailed-design.md`,
        content: `# ${capabilityId} one 详细设计\n`,
      },
      {
        ...documents[0],
        path: `business/capabilities/${capabilityId}/secondary-capabilities/${capabilityId}_two/detailed-design.md`,
        locator: `orgs/org_example/projects/example-project/business/capabilities/${capabilityId}/secondary-capabilities/${capabilityId}_two/detailed-design.md`,
        content: `# ${capabilityId} two 详细设计\n`,
      },
    ]),
  ];
  const service = new DocumentCatalogService([fakeProvider(hierarchyDocuments)]);
  const catalog = await service.refresh();
  const projectDocuments = catalog.buckets[0].organizations[0].projects[0].documents;
  const byPath = (documentPath) => projectDocuments.find((document) => document.path === documentPath);
  const businessArchitecture = byPath('architecture/business.md');
  const commerce = byPath('business/capabilities/commerce/detailed-design.md');
  const serviceOverview = byPath('business/capabilities/service/detailed-design.md');
  const commerceOne = byPath('business/capabilities/commerce/secondary-capabilities/commerce_one/detailed-design.md');
  const commerceTwo = byPath('business/capabilities/commerce/secondary-capabilities/commerce_two/detailed-design.md');

  assert.equal(businessArchitecture.navigation.role, 'business_architecture');
  assert.deepEqual(businessArchitecture.navigation.child_ids, [commerce.id, serviceOverview.id]);
  assert.equal(commerce.navigation.business_architecture_id, businessArchitecture.id);
  assert.equal(commerce.navigation.next_peer_id, serviceOverview.id);
  assert.deepEqual(commerce.navigation.child_ids, [commerceOne.id, commerceTwo.id]);
  assert.equal(commerceOne.navigation.role, 'secondary_capability');
  assert.equal(commerceOne.navigation.capability_overview_id, commerce.id);
  assert.equal(commerceOne.navigation.next_peer_id, commerceTwo.id);
  assert.equal(commerceTwo.navigation.previous_peer_id, commerceOne.id);
}

await withTempDir(async (projectRoot) => {
  const docsRoot = path.join(projectRoot, '.axis', 'docs', 'orgs', 'org_example', 'projects', 'example-project');
  await mkdir(path.join(docsRoot, 'architecture'), { recursive: true });
  await writeFile(path.join(docsRoot, 'architecture', 'technical.md'), '# 技术架构\n', 'utf8');
  const archiveRoot = path.join(
    projectRoot,
    '.axis',
    'docs',
    '_archive',
    'orgs',
    'org_example',
    'projects',
    'example-project',
    'architecture',
    'technical.md.history',
    '20260712T010000Z-r1-a1b2c3d4',
  );
  await mkdir(archiveRoot, { recursive: true });
  await writeFile(path.join(archiveRoot, 'document.md'), '# 技术架构历史版本\n', 'utf8');
  await writeFile(path.join(archiveRoot, 'metadata.json'), JSON.stringify({
    schema: 'axis.document_archive',
    schema_version: '0.2',
    archive_id: '20260712T010000Z-r1-a1b2c3d4',
    organization_id: 'org_example',
    project_slug: 'example-project',
    canonical_path: 'architecture/technical.md',
    archive_content: 'document.md',
    archived_at: '2026-07-12T01:00:00Z',
    change_reason: '更新技术架构',
    request_summary: '增加历史追溯',
    source_revision: '1',
    target_revision: '2',
    content_sha256: 'a'.repeat(64),
  }), 'utf8');
  const provider = new LocalProjectDocumentProvider({ repo: projectRoot });
  const listed = await provider.listDocuments();
  assert.equal(listed.length, 2);
  assert.equal(listed.filter((document) => !document.is_archive).length, 1);
  const archived = listed.find((document) => document.is_archive);
  assert.equal(archived.organizationId, 'org_example');
  assert.equal(archived.projectSlug, 'example-project');
  assert.equal(archived.canonical_path, 'architecture/technical.md');
  const service = new DocumentCatalogService([provider]);
  const catalog = await service.refresh();
  const project = catalog.buckets[0].organizations[0].projects[0];
  assert.equal(project.document_count, 1);
  assert.equal(project.archive_count, 1);
  assert.equal(project.documents[0].archive_count, 1);
  assert.equal(project.archives[0].change_reason, '更新技术架构');
  assert.equal((await service.readDocument(project.archives[0].id)).content, '# 技术架构历史版本\n');
});

{
  let markerSeen = false;
  const provider = new AliyunOssDocumentProvider({
    bucket: 'example-bucket',
    prefix: 'docs',
    client: {
      async list({ prefix, marker }) {
        if (prefix.includes('_archive/')) return { isTruncated: false, objects: [] };
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

{
  const projectPrefix = 'docs/orgs/org_example/projects/example-project/';
  const currentPaths = [
    'architecture/business.md',
    'business/capabilities/commerce/detailed-design.md',
    'business/capabilities/commerce/secondary-capabilities/order_fulfillment/detailed-design.md',
    '_sync/metadata.json',
    '_sync/manifest.json',
  ];
  const listedPaths = [
    ...currentPaths,
    'business/domains/legacy_order/detailed-design.md',
  ];
  const manifest = {
    schema: 'axis.package.manifest',
    schema_version: '0.2',
    organization: { id: 'org_example' },
    project: { slug: 'example-project' },
    publish: { status: 'published' },
    files: [
      { kind: 'metadata', path: 'metadata.json' },
      { kind: 'document', path: 'documents/architecture/business.md' },
      { kind: 'document', path: 'documents/business/capabilities/commerce/detailed-design.md' },
      {
        kind: 'document',
        path: 'documents/business/capabilities/commerce/secondary-capabilities/order_fulfillment/detailed-design.md',
      },
      { kind: 'manifest', path: 'manifest.json' },
    ],
  };
  const provider = new AliyunOssDocumentProvider({
    bucket: 'example-bucket',
    prefix: 'docs',
    client: {
      async list({ prefix }) {
        if (prefix.includes('_archive/')) return { isTruncated: false, objects: [] };
        return {
          isTruncated: false,
          objects: listedPaths.map((documentPath) => ({
            name: `${projectPrefix}${documentPath}`,
            size: 10,
          })),
        };
      },
      async get(name) {
        assert.equal(name, `${projectPrefix}_sync/manifest.json`);
        return { content: Buffer.from(JSON.stringify(manifest)) };
      },
    },
  });
  const listed = await provider.listDocuments();
  assert.deepEqual(
    listed.filter((document) => !document.is_archive).map((document) => document.path).sort(),
    currentPaths.sort(),
    'the latest project sync manifest should hide superseded current-document paths without deleting OSS history',
  );
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
    documents.push({
      ...documents[0],
      path: 'architecture/technical.md',
      locator: 'orgs/org_example/projects/example-project/architecture/technical.md',
      content: '# 技术架构\n',
    });
    const cachedCatalog = await (await fetch(`${running.url}/api/catalog`)).json();
    assert.equal(cachedCatalog.totals.documents, 1, 'catalog reads should remain stable until the user requests a refresh');
    const refreshedCatalog = await (await fetch(`${running.url}/api/refresh`, { method: 'POST' })).json();
    assert.equal(refreshedCatalog.totals.documents, 2, 'manual refresh should reflect current provider data without a server restart');
    documents.pop();
    assert.match(await (await fetch(running.url)).text(), /Axis Document Review/);
  } finally {
    await running.close();
  }
});

assert.match(await readFile(new URL('../README.md', import.meta.url), 'utf8'), /Provider/i);
