import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
const supportedDocumentExtensions = new Set([
    '.md',
    '.markdown',
    '.yaml',
    '.yml',
    '.json',
    '.txt',
    '.html',
    '.csv',
]);
const maximumDocumentBytes = 5 * 1024 * 1024;
function mediaTypeFor(filePath) {
    switch (path.extname(filePath).toLowerCase()) {
        case '.md':
        case '.markdown':
            return 'text/markdown';
        case '.yaml':
        case '.yml':
            return 'application/yaml';
        case '.json':
            return 'application/json';
        case '.html':
            return 'text/html';
        case '.csv':
            return 'text/csv';
        default:
            return 'text/plain';
    }
}
function isSupportedDocument(filePath) {
    return supportedDocumentExtensions.has(path.extname(filePath).toLowerCase());
}
function stableDocumentId(providerId, document) {
    return createHash('sha256')
        .update(providerId)
        .update('\0')
        .update(document.bucket)
        .update('\0')
        .update(document.locator)
        .digest('hex')
        .slice(0, 24);
}
function safeError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message
        .split(/\r?\n/, 1)[0]
        .replace(/https?:\/\/\S+/gi, '[remote]')
        .replace(/(access[_-]?key|secret|token)\s*[:=]\s*\S+/gi, '$1=[redacted]')
        .slice(0, 240);
}
function latestTimestamp(documents) {
    const timestamps = documents
        .map((document) => document.updatedAt)
        .filter((value) => Boolean(value))
        .sort();
    return timestamps.at(-1) ?? null;
}

function capabilityOverviewMatch(documentPath) {
    return /^business\/capabilities\/([^/]+)\/detailed-design\.md$/.exec(documentPath);
}

function secondaryCapabilityMatch(documentPath) {
    return /^business\/capabilities\/([^/]+)\/secondary-capabilities\/([^/]+)\/detailed-design\.md$/.exec(documentPath);
}

function applyProjectDocumentNavigation(documents) {
    const businessArchitecture = documents.find((document) => document.path === 'architecture/business.md') ?? null;
    const capabilityOverviews = documents
        .filter((document) => capabilityOverviewMatch(document.path))
        .sort((left, right) => left.path.localeCompare(right.path));
    const secondaryByCapability = new Map();
    for (const document of documents) {
        const match = secondaryCapabilityMatch(document.path);
        if (!match) continue;
        const children = secondaryByCapability.get(match[1]) ?? [];
        children.push(document);
        secondaryByCapability.set(match[1], children);
    }
    for (const children of secondaryByCapability.values()) {
        children.sort((left, right) => left.path.localeCompare(right.path));
    }
    for (const document of documents) {
        document.navigation = {
            role: 'document',
            business_architecture_id: businessArchitecture?.id ?? null,
            capability_overview_id: null,
            previous_peer_id: null,
            next_peer_id: null,
            child_ids: [],
        };
    }
    if (businessArchitecture) {
        businessArchitecture.navigation.role = 'business_architecture';
        businessArchitecture.navigation.business_architecture_id = businessArchitecture.id;
        businessArchitecture.navigation.child_ids = capabilityOverviews.map((document) => document.id);
    }
    capabilityOverviews.forEach((document, index) => {
        const match = capabilityOverviewMatch(document.path);
        const capabilityId = match?.[1] ?? null;
        const children = secondaryByCapability.get(capabilityId) ?? [];
        document.navigation = {
            role: 'capability_overview',
            level1_capability_id: capabilityId,
            business_architecture_id: businessArchitecture?.id ?? null,
            capability_overview_id: document.id,
            previous_peer_id: capabilityOverviews[index - 1]?.id ?? null,
            next_peer_id: capabilityOverviews[index + 1]?.id ?? null,
            child_ids: children.map((child) => child.id),
        };
        children.forEach((child, childIndex) => {
            const childMatch = secondaryCapabilityMatch(child.path);
            child.navigation = {
                role: 'secondary_capability',
                level1_capability_id: capabilityId,
                secondary_capability_id: childMatch?.[2] ?? null,
                business_architecture_id: businessArchitecture?.id ?? null,
                capability_overview_id: document.id,
                previous_peer_id: children[childIndex - 1]?.id ?? null,
                next_peer_id: children[childIndex + 1]?.id ?? null,
                child_ids: [],
            };
        });
    });
}
export class DocumentCatalogService {
    providers;
    documents = new Map();
    catalog = null;
    refreshCount = 0;
    readCount = 0;
    constructor(providers) {
        if (providers.length === 0)
            throw new Error('At least one document source provider is required');
        this.providers = new Map();
        for (const provider of providers) {
            if (this.providers.has(provider.id))
                throw new Error(`Duplicate document source provider id: ${provider.id}`);
            this.providers.set(provider.id, provider);
        }
    }
    currentCatalog() {
        return this.catalog;
    }
    metrics() {
        return {
            refreshes: this.refreshCount,
            reads: this.readCount,
            last_generated_at: this.catalog?.generated_at ?? null,
        };
    }
    async refresh() {
        const startedAt = Date.now();
        const sourceStatuses = [];
        const collected = [];
        const results = await Promise.all([...this.providers.values()].map(async (provider) => {
            const sourceStartedAt = Date.now();
            try {
                const documents = await provider.listDocuments();
                const normalized = documents.map((document) => ({
                    ...document,
                    id: stableDocumentId(provider.id, document),
                    source_id: provider.id,
                    source_label: provider.label,
                    name: path.posix.basename(document.path),
                    is_archive: document.is_archive === true,
                }));
                const currentDocuments = normalized.filter((document) => !document.is_archive);
                const archives = normalized.filter((document) => document.is_archive);
                return {
                    status: {
                        id: provider.id,
                        label: provider.label,
                        type: provider.type,
                        status: 'healthy',
                        document_count: currentDocuments.length,
                        archive_count: archives.length,
                        duration_ms: Date.now() - sourceStartedAt,
                    },
                    documents: normalized,
                };
            }
            catch (error) {
                return {
                    status: {
                        id: provider.id,
                        label: provider.label,
                        type: provider.type,
                        status: 'error',
                        document_count: 0,
                        duration_ms: Date.now() - sourceStartedAt,
                        error: safeError(error),
                    },
                    documents: [],
                };
            }
        }));
        for (const result of results) {
            sourceStatuses.push(result.status);
            collected.push(...result.documents);
        }
        sourceStatuses.sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
        collected.sort((left, right) => (left.bucket.localeCompare(right.bucket)
            || left.organizationId.localeCompare(right.organizationId)
            || left.projectSlug.localeCompare(right.projectSlug)
            || left.path.localeCompare(right.path)
            || left.source_id.localeCompare(right.source_id)));
        this.documents.clear();
        for (const document of collected)
            this.documents.set(document.id, document);
        const currentDocuments = collected.filter((document) => !document.is_archive);
        const archivedDocuments = collected.filter((document) => document.is_archive);
        const archiveKey = (document) => [
            document.source_id,
            document.bucket,
            document.organizationId,
            document.projectSlug,
            document.canonical_path ?? document.path,
        ].join('\0');
        const archivesByCanonicalPath = new Map();
        for (const archive of archivedDocuments) {
            const key = archiveKey(archive);
            const history = archivesByCanonicalPath.get(key) ?? [];
            history.push(archive);
            archivesByCanonicalPath.set(key, history);
        }
        for (const history of archivesByCanonicalPath.values()) {
            history.sort((left, right) => String(right.archived_at ?? right.updatedAt ?? '')
                .localeCompare(String(left.archived_at ?? left.updatedAt ?? '')));
        }
        for (const document of currentDocuments) {
            const history = archivesByCanonicalPath.get(archiveKey(document)) ?? [];
            document.archive_count = history.length;
            document.latest_archive_at = history[0]?.archived_at ?? null;
        }
        const bucketMap = new Map();
        for (const document of currentDocuments) {
            const bucket = bucketMap.get(document.bucket) ?? { sourceIds: new Set(), organizations: new Map() };
            bucket.sourceIds.add(document.source_id);
            const organization = bucket.organizations.get(document.organizationId) ?? new Map();
            const project = organization.get(document.projectSlug) ?? [];
            project.push(document);
            organization.set(document.projectSlug, project);
            bucket.organizations.set(document.organizationId, organization);
            bucketMap.set(document.bucket, bucket);
        }
        const buckets = [...bucketMap.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([bucketName, bucketValue]) => {
            const organizations = [...bucketValue.organizations.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([organizationId, projectsValue]) => {
                const projects = [...projectsValue.entries()]
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([projectSlug, documents]) => {
                    applyProjectDocumentNavigation(documents);
                    const archives = archivedDocuments.filter((archive) => (archive.bucket === bucketName
                        && archive.organizationId === organizationId
                        && archive.projectSlug === projectSlug
                        && documents.some((document) => document.source_id === archive.source_id)));
                    return {
                        slug: projectSlug,
                        documents,
                        archives,
                        document_count: documents.length,
                        archive_count: archives.length,
                        latest_updated_at: latestTimestamp(documents),
                    };
                });
                return {
                    id: organizationId,
                    projects,
                    project_count: projects.length,
                    document_count: projects.reduce((total, project) => total + project.document_count, 0),
                };
            });
            return {
                id: createHash('sha256').update(bucketName).digest('hex').slice(0, 16),
                name: bucketName,
                source_ids: [...bucketValue.sourceIds].sort(),
                organizations,
                organization_count: organizations.length,
                project_count: organizations.reduce((total, organization) => total + organization.project_count, 0),
                document_count: organizations.reduce((total, organization) => total + organization.document_count, 0),
            };
        });
        const failedSources = sourceStatuses.filter((source) => source.status === 'error').length;
        this.refreshCount += 1;
        this.catalog = {
            schema: 'axis.document_review.catalog',
            schema_version: '0.2',
            generated_at: new Date().toISOString(),
            refresh: {
                status: failedSources === 0 ? 'healthy' : failedSources === sourceStatuses.length ? 'error' : 'partial',
                duration_ms: Date.now() - startedAt,
            },
            totals: {
                sources: sourceStatuses.length,
                buckets: buckets.length,
                organizations: buckets.reduce((total, bucket) => total + bucket.organization_count, 0),
                projects: buckets.reduce((total, bucket) => total + bucket.project_count, 0),
                documents: currentDocuments.length,
                archives: archivedDocuments.length,
            },
            sources: sourceStatuses,
            buckets,
        };
        return this.catalog;
    }
    async readDocument(documentId) {
        const document = this.documents.get(documentId);
        if (!document)
            throw new Error('Document not found');
        if (document.size > maximumDocumentBytes) {
            throw new Error(`Document exceeds ${maximumDocumentBytes} byte viewing limit`);
        }
        const provider = this.providers.get(document.source_id);
        if (!provider)
            throw new Error('Document source provider is unavailable');
        const loaded = await provider.readDocument(document.locator);
        if (loaded.size > maximumDocumentBytes || Buffer.byteLength(loaded.content) > maximumDocumentBytes) {
            throw new Error(`Document exceeds ${maximumDocumentBytes} byte viewing limit`);
        }
        this.readCount += 1;
        return {
            document: {
                ...document,
                mediaType: loaded.mediaType || document.mediaType,
                size: loaded.size,
                updatedAt: loaded.updatedAt ?? document.updatedAt,
            },
            content: loaded.content,
        };
    }
}
export class LocalProjectDocumentProvider {
    id;
    label;
    type = 'local-filesystem';
    repo;
    bucket;
    docsRoot;
    archiveRoot;
    constructor(options) {
        this.repo = path.resolve(options.repo);
        this.bucket = options.bucket ?? 'local-workspace';
        this.id = options.id ?? `local:${createHash('sha256').update(this.repo).digest('hex').slice(0, 12)}`;
        this.label = options.label ?? '本地工作区';
        this.docsRoot = path.join(this.repo, '.axis', 'docs', 'orgs');
        this.archiveRoot = path.join(this.repo, '.axis', 'docs', '_archive', 'orgs');
    }
    async listDocuments() {
        if (!existsSync(this.docsRoot))
            return [];
        const documents = [];
        const organizations = await readdir(this.docsRoot, { withFileTypes: true });
        for (const organization of organizations) {
            if (!organization.isDirectory())
                continue;
            const projectsRoot = path.join(this.docsRoot, organization.name, 'projects');
            if (!existsSync(projectsRoot))
                continue;
            const projects = await readdir(projectsRoot, { withFileTypes: true });
            for (const project of projects) {
                if (!project.isDirectory())
                    continue;
                const projectRoot = path.join(projectsRoot, project.name);
                await this.collectProjectDocuments(projectRoot, organization.name, project.name, documents);
            }
        }
        await this.collectArchiveDocuments(documents);
        return documents.sort((left, right) => (left.organizationId.localeCompare(right.organizationId)
            || left.projectSlug.localeCompare(right.projectSlug)
            || left.path.localeCompare(right.path)));
    }
    async collectProjectDocuments(projectRoot, organizationId, projectSlug, output) {
        const visit = async (directory) => {
            const entries = await readdir(directory, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name === '.DS_Store')
                    continue;
                const absolutePath = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    await visit(absolutePath);
                    continue;
                }
                if (!entry.isFile())
                    continue;
                const relativePath = path.relative(projectRoot, absolutePath).split(path.sep).join('/');
                if (!isSupportedDocument(relativePath))
                    continue;
                const fileStats = await stat(absolutePath);
                output.push({
                    bucket: this.bucket,
                    organizationId,
                    projectSlug,
                    path: relativePath,
                    locator: path.relative(this.repo, absolutePath).split(path.sep).join('/'),
                    mediaType: mediaTypeFor(relativePath),
                    size: fileStats.size,
                    updatedAt: fileStats.mtime.toISOString(),
                    is_archive: false,
                });
            }
        };
        await visit(projectRoot);
    }
    async collectArchiveDocuments(output) {
        if (!existsSync(this.archiveRoot))
            return;
        const organizations = await readdir(this.archiveRoot, { withFileTypes: true });
        for (const organization of organizations) {
            if (!organization.isDirectory())
                continue;
            const projectsRoot = path.join(this.archiveRoot, organization.name, 'projects');
            if (!existsSync(projectsRoot))
                continue;
            const projects = await readdir(projectsRoot, { withFileTypes: true });
            for (const project of projects) {
                if (!project.isDirectory())
                    continue;
                const projectArchiveRoot = path.join(projectsRoot, project.name);
                const visit = async (directory) => {
                    const entries = await readdir(directory, { withFileTypes: true });
                    for (const entry of entries) {
                        const absolutePath = path.join(directory, entry.name);
                        if (entry.isDirectory()) {
                            await visit(absolutePath);
                            continue;
                        }
                        if (!entry.isFile() || entry.name !== 'metadata.json')
                            continue;
                        let metadata;
                        try {
                            metadata = JSON.parse(await readFile(absolutePath, 'utf8'));
                        }
                        catch {
                            continue;
                        }
                        if (metadata.schema !== 'axis.document_archive'
                            || metadata.organization_id !== organization.name
                            || metadata.project_slug !== project.name
                            || typeof metadata.canonical_path !== 'string'
                            || typeof metadata.archive_content !== 'string')
                            continue;
                        const canonicalPath = metadata.canonical_path.replaceAll('\\', '/').replace(/^\/+/, '');
                        if (!canonicalPath || canonicalPath.split('/').includes('..'))
                            continue;
                        const contentPath = path.resolve(path.dirname(absolutePath), metadata.archive_content);
                        const archiveRootWithSeparator = projectArchiveRoot.endsWith(path.sep)
                            ? projectArchiveRoot
                            : `${projectArchiveRoot}${path.sep}`;
                        if (!contentPath.startsWith(archiveRootWithSeparator) || !existsSync(contentPath) || !isSupportedDocument(contentPath))
                            continue;
                        const fileStats = await stat(contentPath);
                        output.push({
                            bucket: this.bucket,
                            organizationId: organization.name,
                            projectSlug: project.name,
                            path: `_archive/${canonicalPath}/${metadata.archive_id}${path.extname(contentPath)}`,
                            locator: path.relative(this.repo, contentPath).split(path.sep).join('/'),
                            mediaType: mediaTypeFor(contentPath),
                            size: fileStats.size,
                            updatedAt: metadata.archived_at ?? fileStats.mtime.toISOString(),
                            is_archive: true,
                            canonical_path: canonicalPath,
                            archive_id: metadata.archive_id,
                            archived_at: metadata.archived_at ?? fileStats.mtime.toISOString(),
                            change_reason: metadata.change_reason ?? '',
                            request_summary: metadata.request_summary ?? '',
                            source_revision: String(metadata.source_revision ?? ''),
                            target_revision: String(metadata.target_revision ?? ''),
                            content_sha256: metadata.content_sha256 ?? null,
                        });
                    }
                };
                await visit(projectArchiveRoot);
            }
        }
    }
    async readDocument(locator) {
        const absolutePath = path.resolve(this.repo, locator);
        const rootWithSeparator = this.docsRoot.endsWith(path.sep) ? this.docsRoot : `${this.docsRoot}${path.sep}`;
        const archiveRootWithSeparator = this.archiveRoot.endsWith(path.sep) ? this.archiveRoot : `${this.archiveRoot}${path.sep}`;
        if ((!absolutePath.startsWith(rootWithSeparator) && !absolutePath.startsWith(archiveRootWithSeparator)) || !isSupportedDocument(absolutePath)) {
            throw new Error('Local document path is outside the allowed Axis docs root');
        }
        const fileStats = await stat(absolutePath);
        if (!fileStats.isFile())
            throw new Error('Local document is not a file');
        if (fileStats.size > maximumDocumentBytes) {
            throw new Error(`Document exceeds ${maximumDocumentBytes} byte viewing limit`);
        }
        return {
            content: await readFile(absolutePath, 'utf8'),
            mediaType: mediaTypeFor(absolutePath),
            size: fileStats.size,
            updatedAt: fileStats.mtime.toISOString(),
        };
    }
}
export class AliyunOssDocumentProvider {
    id;
    label;
    type = 'aliyun-oss';
    client;
    bucket;
    prefix;
    constructor(options) {
        this.client = options.client;
        this.bucket = options.bucket;
        this.prefix = options.prefix.replace(/^\/+|\/+$/g, '');
        this.id = options.id ?? `oss:${this.bucket}:${this.prefix || 'root'}`;
        this.label = options.label ?? `OSS · ${this.bucket}`;
    }
    async listDocuments() {
        const rootPrefix = `${this.prefix ? `${this.prefix}/` : ''}orgs/`;
        const archivePrefix = `${this.prefix ? `${this.prefix}/` : ''}_archive/orgs/`;
        const documents = [];
        const listObjects = async (prefix) => {
            const objects = [];
            let marker;
            do {
                const result = await this.client.list({ prefix, marker, 'max-keys': 1000 });
                objects.push(...(result.objects ?? []));
                marker = result.isTruncated ? result.nextMarker : undefined;
            } while (marker);
            return objects;
        };
        for (const object of await listObjects(rootPrefix)) {
            const relative = object.name.slice(rootPrefix.length);
            const match = /^([^/]+)\/projects\/([^/]+)\/(.+)$/.exec(relative);
            if (!match || !isSupportedDocument(match[3]))
                continue;
            documents.push({
                bucket: this.bucket,
                organizationId: match[1],
                projectSlug: match[2],
                path: match[3],
                locator: object.name,
                mediaType: mediaTypeFor(match[3]),
                size: Number(object.size ?? 0),
                updatedAt: object.lastModified ?? null,
                is_archive: false,
            });
        }
        const archiveObjects = await listObjects(archivePrefix);
        const archiveObjectByName = new Map(archiveObjects.map((object) => [object.name, object]));
        for (const metadataObject of archiveObjects.filter((object) => object.name.endsWith('/metadata.json'))) {
            const relative = metadataObject.name.slice(archivePrefix.length);
            const match = /^([^/]+)\/projects\/([^/]+)\/(.+)\/metadata\.json$/.exec(relative);
            if (!match)
                continue;
            let metadata;
            try {
                const loaded = await this.client.get(metadataObject.name);
                const bytes = Buffer.isBuffer(loaded.content) ? loaded.content : Buffer.from(loaded.content);
                metadata = JSON.parse(bytes.toString('utf8'));
            }
            catch {
                continue;
            }
            if (metadata.schema !== 'axis.document_archive'
                || metadata.organization_id !== match[1]
                || metadata.project_slug !== match[2]
                || typeof metadata.canonical_path !== 'string'
                || typeof metadata.archive_content !== 'string')
                continue;
            const canonicalPath = metadata.canonical_path.replaceAll('\\', '/').replace(/^\/+/, '');
            if (!canonicalPath || canonicalPath.split('/').includes('..'))
                continue;
            const contentName = `${path.posix.dirname(metadataObject.name)}/${metadata.archive_content}`;
            const contentObject = archiveObjectByName.get(contentName);
            if (!contentObject || !isSupportedDocument(contentName))
                continue;
            documents.push({
                bucket: this.bucket,
                organizationId: match[1],
                projectSlug: match[2],
                path: `_archive/${canonicalPath}/${metadata.archive_id}${path.posix.extname(contentName)}`,
                locator: contentName,
                mediaType: mediaTypeFor(contentName),
                size: Number(contentObject.size ?? 0),
                updatedAt: metadata.archived_at ?? contentObject.lastModified ?? null,
                is_archive: true,
                canonical_path: canonicalPath,
                archive_id: metadata.archive_id,
                archived_at: metadata.archived_at ?? contentObject.lastModified ?? null,
                change_reason: metadata.change_reason ?? '',
                request_summary: metadata.request_summary ?? '',
                source_revision: String(metadata.source_revision ?? ''),
                target_revision: String(metadata.target_revision ?? ''),
                content_sha256: metadata.content_sha256 ?? null,
            });
        }
        return documents;
    }
    async readDocument(locator) {
        const rootPrefix = `${this.prefix ? `${this.prefix}/` : ''}orgs/`;
        const archivePrefix = `${this.prefix ? `${this.prefix}/` : ''}_archive/orgs/`;
        if ((!locator.startsWith(rootPrefix) && !locator.startsWith(archivePrefix)) || !isSupportedDocument(locator)) {
            throw new Error('OSS object is outside the configured project-document prefix');
        }
        const result = await this.client.get(locator);
        const content = Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content);
        if (content.byteLength > maximumDocumentBytes) {
            throw new Error(`Document exceeds ${maximumDocumentBytes} byte viewing limit`);
        }
        return {
            content: content.toString('utf8'),
            mediaType: mediaTypeFor(locator),
            size: content.byteLength,
            updatedAt: result.res?.headers?.['last-modified'] ?? null,
        };
    }
}
function writeJson(response, statusCode, body) {
    response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    response.end(`${JSON.stringify(body, null, 2)}\n`);
}
function writeStatic(response, contentType, body) {
    response.writeHead(200, {
        'content-type': contentType,
        'cache-control': 'no-cache',
    });
    response.end(body);
}
function serverAddress(server, host) {
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('Document review server address is unavailable');
    return `http://${host}:${address.port}`;
}
export async function startDocsObservatoryServer(options) {
    const assetsDir = path.resolve(options.publicDir ?? options.assetsDir);
    const staticAssets = new Map([
        ['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
        ['/index.html', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
        ['/app.js', { file: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
        ['/styles.css', { file: 'styles.css', contentType: 'text/css; charset=utf-8' }],
    ]);
    for (const asset of staticAssets.values()) {
        if (!existsSync(path.join(assetsDir, asset.file)))
            throw new Error(`Docs observatory asset missing: ${asset.file}`);
    }
    await options.service.refresh();
    const metrics = {
        started_at: new Date().toISOString(),
        requests: { total: 0, errors: 0, documents: 0, refreshes: 0 },
    };
    const server = createServer(async (request, response) => {
        metrics.requests.total += 1;
        response.setHeader('x-content-type-options', 'nosniff');
        response.setHeader('x-frame-options', 'DENY');
        response.setHeader('referrer-policy', 'no-referrer');
        try {
            const url = new URL(request.url ?? '/', `http://${options.host}`);
            if (request.method === 'GET' && url.pathname === '/api/health') {
                const catalog = options.service.currentCatalog();
                writeJson(response, catalog?.refresh.status === 'error' ? 503 : 200, {
                    ok: catalog?.refresh.status !== 'error',
                    refresh: catalog?.refresh ?? null,
                    generated_at: catalog?.generated_at ?? null,
                });
                return;
            }
            if (request.method === 'GET' && url.pathname === '/api/catalog') {
                writeJson(response, 200, options.service.currentCatalog());
                return;
            }
            if (request.method === 'POST' && url.pathname === '/api/refresh') {
                metrics.requests.refreshes += 1;
                writeJson(response, 200, await options.service.refresh());
                return;
            }
            if (request.method === 'GET' && url.pathname === '/api/metrics') {
                const catalog = options.service.currentCatalog();
                writeJson(response, 200, {
                    ...metrics,
                    service: options.service.metrics(),
                    catalog: catalog?.totals ?? null,
                    sources: catalog?.sources ?? [],
                });
                return;
            }
            if (request.method === 'GET' && url.pathname.startsWith('/api/documents/')) {
                const documentId = decodeURIComponent(url.pathname.slice('/api/documents/'.length));
                try {
                    const loaded = await options.service.readDocument(documentId);
                    metrics.requests.documents += 1;
                    writeJson(response, 200, loaded);
                }
                catch (error) {
                    if (safeError(error) === 'Document not found') {
                        writeJson(response, 404, { error: 'Document not found' });
                    }
                    else {
                        throw error;
                    }
                }
                return;
            }
            const staticAsset = request.method === 'GET' ? staticAssets.get(url.pathname) : undefined;
            if (staticAsset) {
                writeStatic(response, staticAsset.contentType, await readFile(path.join(assetsDir, staticAsset.file)));
                return;
            }
            writeJson(response, 404, { error: 'Not found' });
        }
        catch (error) {
            metrics.requests.errors += 1;
            writeJson(response, 500, { error: safeError(error) });
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
            server.off('error', reject);
            resolve();
        });
    });
    return {
        server,
        url: serverAddress(server, options.host),
        close: () => new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
}

export const startDocumentReviewServer = startDocsObservatoryServer;
