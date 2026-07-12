import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { marked } from 'marked';
import mermaid from 'mermaid';

marked.setOptions({ gfm: true, breaks: false });
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'dark',
  fontFamily: 'Inter, PingFang SC, Microsoft YaHei, sans-serif',
});

const DEFAULT_DOCUMENT_TYPE = 'MD';

const state = {
  catalog: null,
  selectedProject: null,
  selectedDocument: null,
  activeSourceId: null,
  selectedType: 'all',
  query: '',
  content: '',
  documentTitles: new Map(),
  titleLoads: new Set(),
  documentLoadSequence: 0,
};

const elements = {
  connectionState: document.querySelector('#connectionState'),
  refreshButton: document.querySelector('#refreshButton'),
  globalSearch: document.querySelector('#globalSearch'),
  sourceList: document.querySelector('#sourceList'),
  sourceSummary: document.querySelector('#sourceSummary'),
  catalogTree: document.querySelector('#catalogTree'),
  catalogCount: document.querySelector('#catalogCount'),
  lastRefresh: document.querySelector('#lastRefresh'),
  refreshDuration: document.querySelector('#refreshDuration'),
  projectDocumentCount: document.querySelector('#projectDocumentCount'),
  typeFilters: document.querySelector('#typeFilters'),
  documentList: document.querySelector('#documentList'),
  viewerPath: document.querySelector('#viewerPath'),
  viewerTitle: document.querySelector('#viewerTitle'),
  viewerSource: document.querySelector('#viewerSource'),
  viewerMeta: document.querySelector('#viewerMeta'),
  viewerContent: document.querySelector('#viewerContent'),
  viewerPanel: document.querySelector('.viewer-panel'),
  fullscreenButton: document.querySelector('#fullscreenButton'),
  copyButton: document.querySelector('#copyButton'),
  toast: document.querySelector('#toast'),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderMarkdown(markdown) {
  return DOMPurify.sanitize(marked.parse(markdown));
}

function languageFor(documentRecord) {
  const extension = documentRecord.path.split('.').at(-1)?.toLowerCase();
  if (extension === 'yml') return 'yaml';
  if (['json', 'yaml', 'xml', 'html', 'css', 'javascript', 'typescript', 'java', 'sql', 'bash'].includes(extension)) {
    return extension;
  }
  return '';
}

async function enhanceRenderedContent() {
  const diagramBlocks = [...elements.viewerContent.querySelectorAll('pre > code.language-mermaid')];
  for (const code of diagramBlocks) {
    const diagram = document.createElement('div');
    diagram.className = 'mermaid';
    diagram.textContent = code.textContent;
    code.parentElement.replaceWith(diagram);
    try {
      await mermaid.run({ nodes: [diagram] });
    } catch (error) {
      diagram.className = 'mermaid diagram-error';
      diagram.textContent = `流程图解析失败\n\n${code.textContent}\n\n${error.message}`;
    }
  }
  elements.viewerContent.querySelectorAll('pre > code:not(.language-mermaid)').forEach((code) => {
    hljs.highlightElement(code);
  });
  enhanceDocumentLinks();
}

function referencedDocument(reference) {
  const normalized = reference.trim().replace(/^\.\//, '').replaceAll('\\', '/').split('#', 1)[0];
  return state.selectedProject?.project.documents.find((documentRecord) => documentRecord.path === normalized) ?? null;
}

function connectDocumentLink(link, documentRecord) {
  const url = new URL(window.location.href);
  url.searchParams.set('document', documentRecord.id);
  link.href = url;
  link.dataset.documentTarget = documentRecord.id;
  link.title = `打开：${documentDisplayTitle(documentRecord)}`;
  link.addEventListener('click', async (event) => {
    event.preventDefault();
    state.selectedType = fileType(documentRecord);
    renderDocumentList();
    await loadDocument(documentRecord.id);
  });
}

function enhanceDocumentLinks() {
  elements.viewerContent.querySelectorAll('code:not(pre code)').forEach((code) => {
    const documentRecord = referencedDocument(code.textContent);
    if (!documentRecord) return;
    const link = document.createElement('a');
    link.className = 'document-link';
    link.textContent = code.textContent;
    connectDocumentLink(link, documentRecord);
    code.replaceWith(link);
  });
  elements.viewerContent.querySelectorAll('a[href]:not([data-document-target])').forEach((link) => {
    const documentRecord = referencedDocument(link.getAttribute('href'));
    if (documentRecord) connectDocumentLink(link, documentRecord);
  });
}

function formatDate(value) {
  if (!value) return '未知时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileType(documentRecord) {
  const extension = documentRecord.path.split('.').at(-1)?.toLowerCase() || 'txt';
  if (['md', 'markdown'].includes(extension)) return 'MD';
  if (['yaml', 'yml'].includes(extension)) return 'YAML';
  return extension.toUpperCase();
}

function extractDocumentTitle(content, fallback = '未命名文档') {
  const heading = /^\s*#\s+(.+?)\s*$/m.exec(content)?.[1];
  if (!heading) return fallback;
  return heading
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim() || fallback;
}

function documentDisplayTitle(documentRecord) {
  if (state.documentTitles.has(documentRecord.id)) return state.documentTitles.get(documentRecord.id);
  return fileType(documentRecord) === DEFAULT_DOCUMENT_TYPE ? '正在读取标题…' : `${fileType(documentRecord)} 文档`;
}

async function hydrateDocumentTitles(documents, projectKeyAtStart, excludedId = null) {
  const queue = documents.filter((documentRecord) => (
    fileType(documentRecord) === DEFAULT_DOCUMENT_TYPE
    && documentRecord.id !== excludedId
    && !state.documentTitles.has(documentRecord.id)
    && !state.titleLoads.has(documentRecord.id)
  ));
  for (const documentRecord of queue) state.titleLoads.add(documentRecord.id);
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length > 0) {
      const documentRecord = queue.shift();
      try {
        const response = await fetch(`/api/documents/${encodeURIComponent(documentRecord.id)}`);
        if (!response.ok) throw new Error(`title request failed: ${response.status}`);
        const loaded = await response.json();
        state.documentTitles.set(documentRecord.id, extractDocumentTitle(loaded.content, documentRecord.name));
      } catch {
        state.documentTitles.set(documentRecord.id, documentRecord.name);
      } finally {
        state.titleLoads.delete(documentRecord.id);
      }
    }
  });
  await Promise.all(workers);
  if (state.selectedProject?.key === projectKeyAtStart) renderDocumentList();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => elements.toast.classList.remove('show'), 2200);
}

function setConnection(status, message) {
  elements.connectionState.className = `connection-state ${status}`;
  elements.connectionState.querySelector('span:last-child').textContent = message;
}

function renderCatalogSummary() {
  elements.lastRefresh.textContent = formatDate(state.catalog?.generated_at);
  elements.refreshDuration.textContent = state.catalog ? `${state.catalog.refresh.duration_ms} ms` : '—';
}

function renderSources() {
  const sources = state.catalog?.sources ?? [];
  const healthy = sources.filter((source) => source.status === 'healthy').length;
  elements.sourceSummary.textContent = `${healthy} / ${sources.length}`;
  elements.sourceList.innerHTML = sources.map((source) => `
    <button class="source-item ${state.activeSourceId === source.id ? 'active' : ''} ${source.status === 'error' ? 'error' : ''}" type="button" data-source-id="${escapeHtml(source.id)}" aria-pressed="${state.activeSourceId === source.id}" title="${escapeHtml(source.error || source.type)}">
      <span class="source-indicator"></span>
      <span class="source-copy">
        <strong>${escapeHtml(source.label)}</strong>
        <small>${source.status === 'error' ? escapeHtml(source.error || '读取失败') : `${source.document_count} 篇 · ${source.duration_ms} ms`}</small>
      </span>
    </button>
  `).join('');
  elements.sourceList.querySelectorAll('[data-source-id]').forEach((button) => {
    button.addEventListener('click', () => selectSource(button.dataset.sourceId));
  });
}

function projectKey(bucket, organization, project) {
  return [bucket.name, organization.id, project.slug].map(encodeURIComponent).join('|');
}

function bucketsForActiveSource() {
  return (state.catalog?.buckets ?? []).filter((bucket) => bucket.source_ids.includes(state.activeSourceId));
}

function firstProjectForActiveSource() {
  for (const bucket of bucketsForActiveSource()) {
    for (const organization of bucket.organizations) {
      const project = organization.projects[0];
      if (project) return { bucket, organization, project };
    }
  }
  return null;
}

function renderCatalogTree() {
  const query = state.query.toLowerCase();
  const buckets = bucketsForActiveSource();
  const markup = [];
  let visibleProjectCount = 0;
  for (const bucket of buckets) {
    for (const organization of bucket.organizations) {
      const projects = organization.projects.filter((project) => {
        if (!query) return true;
        return [bucket.name, organization.id, project.slug, ...project.documents.map((document) => document.path)]
          .some((value) => value.toLowerCase().includes(query));
      });
      if (projects.length === 0) continue;
      visibleProjectCount += projects.length;
      markup.push(`
        <div class="organization-node">
          ${projects.map((project) => {
            const key = projectKey(bucket, organization, project);
            const active = state.selectedProject?.key === key ? 'active' : '';
            return `
              <button class="project-node ${active}" type="button" data-project-key="${escapeHtml(key)}">
                <span class="project-context">
                  <small class="organization-id">${escapeHtml(organization.id)}</small>
                  <strong class="tree-label">${escapeHtml(project.slug)}</strong>
                </span>
                <span class="tree-count">${project.document_count}</span>
              </button>
            `;
          }).join('')}
        </div>
      `);
    }
  }
  elements.catalogCount.textContent = visibleProjectCount;
  elements.catalogTree.innerHTML = markup.join('') || '<div class="empty-state compact"><p>当前数据源没有匹配的项目</p></div>';
  elements.catalogTree.querySelectorAll('[data-project-key]').forEach((button) => {
    button.addEventListener('click', () => selectProject(button.dataset.projectKey));
  });
}

function clearProjectSelection() {
  state.selectedProject = null;
  state.selectedDocument = null;
  state.content = '';
  state.selectedType = 'all';
  state.documentLoadSequence += 1;
  elements.projectDocumentCount.textContent = '0';
  elements.typeFilters.innerHTML = '';
  elements.documentList.innerHTML = '<div class="empty-state compact"><p>当前数据源暂无文档</p></div>';
  elements.viewerPath.textContent = '未选择文档';
  elements.viewerTitle.textContent = '选择文档开始查阅';
  elements.viewerSource.textContent = '—';
  elements.viewerMeta.innerHTML = '';
  elements.viewerContent.innerHTML = '<div class="empty-state"><h4>当前数据源暂无可查阅文档</h4></div>';
  elements.copyButton.disabled = true;
}

function selectSource(sourceId) {
  if (!state.catalog?.sources.some((source) => source.id === sourceId)) return;
  state.activeSourceId = sourceId;
  clearProjectSelection();
  renderSources();
  renderCatalogTree();
  const first = firstProjectForActiveSource();
  if (first) selectProject(projectKey(first.bucket, first.organization, first.project));
}

function findProject(key) {
  for (const bucket of state.catalog?.buckets ?? []) {
    for (const organization of bucket.organizations) {
      for (const project of organization.projects) {
        if (projectKey(bucket, organization, project) === key) return { key, bucket, organization, project };
      }
    }
  }
  return null;
}

function selectProject(key, options = {}) {
  const selected = findProject(key);
  if (!selected) return;
  const projectChanged = state.selectedProject?.key !== key;
  state.selectedProject = selected;
  const projectSourceId = selected.project.documents[0]?.source_id ?? selected.bucket.source_ids[0];
  if (projectSourceId && projectSourceId !== state.activeSourceId) {
    state.activeSourceId = projectSourceId;
    renderSources();
  }
  const requestedDocument = options.preferredDocumentId
    ? selected.project.documents.find((documentRecord) => documentRecord.id === options.preferredDocumentId)
    : null;
  const defaultDocument = requestedDocument
    ?? selected.project.documents.find((documentRecord) => fileType(documentRecord) === DEFAULT_DOCUMENT_TYPE)
    ?? selected.project.documents[0];
  state.selectedType = requestedDocument
    ? fileType(requestedDocument)
    : selected.project.documents.some((documentRecord) => fileType(documentRecord) === DEFAULT_DOCUMENT_TYPE)
      ? DEFAULT_DOCUMENT_TYPE
      : 'all';
  renderCatalogTree();
  renderDocumentList();
  if (projectChanged) elements.documentList.scrollTop = 0;
  void hydrateDocumentTitles(selected.project.documents, selected.key, defaultDocument?.id);
  if (!options.keepDocument && defaultDocument) loadDocument(defaultDocument.id, { resetList: projectChanged });
}

function filteredDocuments() {
  const documents = state.selectedProject?.project.documents ?? [];
  const query = state.query.toLowerCase();
  return documents.filter((document) => {
    const matchesType = state.selectedType === 'all' || fileType(document) === state.selectedType;
    const matchesQuery = !query || [document.path, document.source_label, document.name, documentDisplayTitle(document)]
      .some((value) => value.toLowerCase().includes(query));
    return matchesType && matchesQuery;
  });
}

function renderTypeFilters() {
  const documents = state.selectedProject?.project.documents ?? [];
  const types = ['all', ...new Set(documents.map(fileType))];
  elements.typeFilters.innerHTML = types.map((type) => `
    <button class="filter-chip ${state.selectedType === type ? 'active' : ''}" type="button" data-type="${type}">
      ${type === 'all' ? '全部' : type}
    </button>
  `).join('');
  elements.typeFilters.querySelectorAll('[data-type]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedType = button.dataset.type;
      renderDocumentList();
    });
  });
}

function renderDocumentList() {
  const documents = filteredDocuments();
  const total = state.selectedProject?.project.document_count ?? 0;
  elements.projectDocumentCount.textContent = total;
  renderTypeFilters();
  elements.documentList.innerHTML = documents.map((document) => `
    <button class="document-item ${state.selectedDocument?.id === document.id ? 'active' : ''}" type="button" data-document-id="${document.id}" title="${escapeHtml(document.path)}">
      <span class="file-icon">${fileType(document)}</span>
      <span class="document-copy">
        <strong>${escapeHtml(document.name)}</strong>
        <small class="document-title">${escapeHtml(documentDisplayTitle(document))}</small>
      </span>
    </button>
  `).join('') || '<div class="empty-state compact"><p>当前筛选下没有文档</p></div>';
  elements.documentList.querySelectorAll('[data-document-id]').forEach((button) => {
    button.addEventListener('click', () => loadDocument(button.dataset.documentId));
  });
}

async function renderViewer(documentRecord, content) {
  elements.viewerPath.textContent = `${documentRecord.bucket} / ${documentRecord.organizationId} / ${documentRecord.projectSlug} / ${documentRecord.path}`;
  elements.viewerTitle.textContent = documentRecord.name;
  elements.viewerSource.textContent = documentRecord.source_label;
  elements.viewerMeta.innerHTML = `
    <span>${escapeHtml(documentRecord.mediaType)}</span>
    <span>${formatBytes(documentRecord.size)}</span>
    <span>${formatDate(documentRecord.updatedAt)}</span>
  `;
  if (documentRecord.mediaType === 'text/markdown') {
    elements.viewerContent.innerHTML = renderMarkdown(content);
  } else {
    const pre = document.createElement('pre');
    pre.className = 'raw-document';
    const code = document.createElement('code');
    const language = languageFor(documentRecord);
    if (language) code.className = `language-${language}`;
    code.textContent = content;
    pre.append(code);
    elements.viewerContent.replaceChildren(pre);
  }
  await enhanceRenderedContent();
  elements.viewerContent.scrollTop = 0;
  elements.copyButton.disabled = false;
}

async function loadDocument(documentId, options = {}) {
  const loadSequence = ++state.documentLoadSequence;
  elements.viewerContent.innerHTML = '<div class="loading-line"></div><div class="loading-line"></div><div class="loading-line"></div>';
  try {
    const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`);
    if (!response.ok) throw new Error(`文档读取失败（${response.status}）`);
    const loaded = await response.json();
    if (loadSequence !== state.documentLoadSequence) return;
    state.selectedDocument = loaded.document;
    state.content = loaded.content;
    if (fileType(loaded.document) === DEFAULT_DOCUMENT_TYPE) {
      state.documentTitles.set(loaded.document.id, extractDocumentTitle(loaded.content, loaded.document.name));
    }
    renderDocumentList();
    if (options.resetList) elements.documentList.scrollTop = 0;
    await renderViewer(loaded.document, loaded.content);
    const url = new URL(window.location.href);
    url.searchParams.set('document', loaded.document.id);
    window.history.replaceState({}, '', url);
  } catch (error) {
    if (loadSequence !== state.documentLoadSequence) return;
    elements.viewerContent.innerHTML = `<div class="empty-state"><h4>无法读取文档</h4><p>${escapeHtml(error.message)}</p></div>`;
    showToast(error.message);
  }
}

function selectInitialProject() {
  const requestedDocumentId = new URL(window.location.href).searchParams.get('document');
  if (requestedDocumentId) {
    for (const bucket of state.catalog?.buckets ?? []) {
      for (const organization of bucket.organizations) {
        for (const project of organization.projects) {
          if (project.documents.some((document) => document.id === requestedDocumentId)) {
            const requestedDocument = project.documents.find((document) => document.id === requestedDocumentId);
            state.activeSourceId = requestedDocument?.source_id ?? bucket.source_ids[0];
            renderSources();
            renderCatalogTree();
            selectProject(projectKey(bucket, organization, project), {
              keepDocument: true,
              preferredDocumentId: requestedDocumentId,
            });
            loadDocument(requestedDocumentId);
            return;
          }
        }
      }
    }
  }
  const first = firstProjectForActiveSource();
  if (first) selectProject(projectKey(first.bucket, first.organization, first.project));
  else clearProjectSelection();
}

function applyCatalog(catalog, preserveSelection = false) {
  const previousProjectKey = state.selectedProject?.key;
  const previousDocumentId = state.selectedDocument?.id;
  state.catalog = catalog;
  if (!catalog.sources.some((source) => source.id === state.activeSourceId)) {
    state.activeSourceId = catalog.sources.find((source) => source.type === 'aliyun-oss' && source.status === 'healthy')?.id
      ?? catalog.sources.find((source) => source.status === 'healthy')?.id
      ?? catalog.sources[0]?.id
      ?? null;
  }
  renderCatalogSummary();
  renderSources();
  renderCatalogTree();
  const status = catalog.refresh.status;
  setConnection(status, status === 'healthy' ? '所有数据源正常' : status === 'partial' ? '部分数据源不可用' : '数据源读取失败');
  if (preserveSelection && previousProjectKey && findProject(previousProjectKey)) {
    selectProject(previousProjectKey, { keepDocument: true });
    const documentStillExists = state.selectedProject.project.documents.some((document) => document.id === previousDocumentId);
    if (previousDocumentId && documentStillExists) loadDocument(previousDocumentId);
  } else {
    selectInitialProject();
  }
}

async function loadCatalog() {
  setConnection('', '正在读取目录');
  const response = await fetch('/api/catalog');
  if (!response.ok) throw new Error(`目录读取失败（${response.status}）`);
  applyCatalog(await response.json());
}

async function refreshCatalog() {
  elements.refreshButton.disabled = true;
  setConnection('', '正在刷新数据源');
  try {
    const response = await fetch('/api/refresh', { method: 'POST' });
    if (!response.ok) throw new Error(`刷新失败（${response.status}）`);
    applyCatalog(await response.json(), true);
    showToast('文档目录已刷新');
  } catch (error) {
    setConnection('error', '刷新失败');
    showToast(error.message);
  } finally {
    elements.refreshButton.disabled = false;
  }
}

elements.refreshButton.addEventListener('click', refreshCatalog);
elements.globalSearch.addEventListener('input', (event) => {
  state.query = event.target.value.trim();
  renderCatalogTree();
  renderDocumentList();
});
elements.copyButton.addEventListener('click', async () => {
  if (!state.content) return;
  await navigator.clipboard.writeText(state.content);
  showToast('文档内容已复制');
});

function setFallbackFullscreen(active) {
  elements.viewerPanel.classList.toggle('fullscreen-fallback', active);
  document.body.classList.toggle('viewer-fullscreen-fallback', active);
}

function syncFullscreenState() {
  const nativeFullscreen = document.fullscreenElement === elements.viewerPanel;
  if (nativeFullscreen) setFallbackFullscreen(false);
  const fallbackFullscreen = elements.viewerPanel.classList.contains('fullscreen-fallback');
  const active = nativeFullscreen || fallbackFullscreen;
  elements.fullscreenButton.textContent = active ? '退出全屏' : '全屏';
  elements.fullscreenButton.title = active ? '退出全屏预览' : '全屏预览文档';
  elements.fullscreenButton.setAttribute('aria-pressed', String(active));
}

async function toggleFullscreen() {
  try {
    if (elements.viewerPanel.classList.contains('fullscreen-fallback')) {
      setFallbackFullscreen(false);
      syncFullscreenState();
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (elements.viewerPanel.requestFullscreen) {
      await elements.viewerPanel.requestFullscreen();
    } else {
      setFallbackFullscreen(true);
      syncFullscreenState();
    }
  } catch (error) {
    setFallbackFullscreen(true);
    syncFullscreenState();
    showToast(`浏览器未允许原生全屏，已切换沉浸预览：${error.message}`);
  }
}

elements.fullscreenButton.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', syncFullscreenState);
window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    elements.globalSearch.focus();
  }
});

loadCatalog().catch((error) => {
  setConnection('error', '无法连接本地服务');
  elements.catalogTree.innerHTML = `<div class="empty-state compact"><p>${escapeHtml(error.message)}</p></div>`;
  showToast(error.message);
});
