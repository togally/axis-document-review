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

const state = {
  catalog: null,
  selectedProject: null,
  selectedDocument: null,
  selectedType: 'all',
  query: '',
  content: '',
};

const elements = {
  connectionState: document.querySelector('#connectionState'),
  refreshButton: document.querySelector('#refreshButton'),
  globalSearch: document.querySelector('#globalSearch'),
  sourceList: document.querySelector('#sourceList'),
  sourceSummary: document.querySelector('#sourceSummary'),
  catalogTree: document.querySelector('#catalogTree'),
  catalogCount: document.querySelector('#catalogCount'),
  bucketMetric: document.querySelector('#bucketMetric'),
  organizationMetric: document.querySelector('#organizationMetric'),
  projectMetric: document.querySelector('#projectMetric'),
  documentMetric: document.querySelector('#documentMetric'),
  breadcrumb: document.querySelector('#breadcrumb'),
  projectTitle: document.querySelector('#projectTitle'),
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

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => elements.toast.classList.remove('show'), 2200);
}

function drillDown(metric) {
  const selectors = {
    buckets: '.tree-group .tree-summary',
    organizations: '.organization-node .organization-label',
    projects: '.project-node.active, .project-node',
    documents: '.document-item.active, .document-item',
  };
  const labels = {
    buckets: '存储桶目录',
    organizations: '组织目录',
    projects: '项目目录',
    documents: '当前项目文档',
  };
  const target = document.querySelector(selectors[metric]);
  if (!target) {
    showToast(`${labels[metric]}暂无可定位内容`);
    return;
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  target.classList.remove('drilldown-highlight');
  window.requestAnimationFrame(() => target.classList.add('drilldown-highlight'));
  if (typeof target.focus === 'function' && target.matches('button, [tabindex]')) target.focus({ preventScroll: true });
  showToast(`已定位到${labels[metric]}`);
}

function setConnection(status, message) {
  elements.connectionState.className = `connection-state ${status}`;
  elements.connectionState.querySelector('span:last-child').textContent = message;
}

function renderMetrics() {
  const totals = state.catalog?.totals;
  elements.bucketMetric.textContent = totals?.buckets ?? '—';
  elements.organizationMetric.textContent = totals?.organizations ?? '—';
  elements.projectMetric.textContent = totals?.projects ?? '—';
  elements.documentMetric.textContent = totals?.documents ?? '—';
  elements.catalogCount.textContent = totals?.projects ?? 0;
  elements.lastRefresh.textContent = formatDate(state.catalog?.generated_at);
  elements.refreshDuration.textContent = state.catalog ? `${state.catalog.refresh.duration_ms} ms` : '—';
}

function renderSources() {
  const sources = state.catalog?.sources ?? [];
  const healthy = sources.filter((source) => source.status === 'healthy').length;
  elements.sourceSummary.textContent = `${healthy} / ${sources.length}`;
  elements.sourceList.innerHTML = sources.map((source) => `
    <div class="source-item ${source.status === 'error' ? 'error' : ''}" title="${escapeHtml(source.error || source.type)}">
      <span class="source-indicator"></span>
      <span class="source-copy">
        <strong>${escapeHtml(source.label)}</strong>
        <small>${source.status === 'error' ? escapeHtml(source.error || '读取失败') : `${source.document_count} 篇 · ${source.duration_ms} ms`}</small>
      </span>
    </div>
  `).join('');
}

function projectKey(bucket, organization, project) {
  return [bucket.name, organization.id, project.slug].map(encodeURIComponent).join('|');
}

function renderCatalogTree() {
  const query = state.query.toLowerCase();
  const buckets = state.catalog?.buckets ?? [];
  const markup = [];
  for (const bucket of buckets) {
    const organizationMarkup = [];
    for (const organization of bucket.organizations) {
      const projects = organization.projects.filter((project) => {
        if (!query) return true;
        return [bucket.name, organization.id, project.slug, ...project.documents.map((document) => document.path)]
          .some((value) => value.toLowerCase().includes(query));
      });
      if (projects.length === 0) continue;
      organizationMarkup.push(`
        <div class="organization-node">
          <div class="organization-label">${escapeHtml(organization.id)}</div>
          ${projects.map((project) => {
            const key = projectKey(bucket, organization, project);
            const active = state.selectedProject?.key === key ? 'active' : '';
            return `
              <button class="project-node ${active}" type="button" data-project-key="${escapeHtml(key)}">
                <span class="tree-icon">└</span>
                <span class="tree-label">${escapeHtml(project.slug)}</span>
                <span class="tree-count">${project.document_count}</span>
              </button>
            `;
          }).join('')}
        </div>
      `);
    }
    if (organizationMarkup.length === 0) continue;
    markup.push(`
      <div class="tree-group">
        <div class="tree-summary">
          <span class="tree-icon">▣</span>
          <span class="tree-label">${escapeHtml(bucket.name)}</span>
          <span class="tree-count">${bucket.document_count}</span>
        </div>
        ${organizationMarkup.join('')}
      </div>
    `);
  }
  elements.catalogTree.innerHTML = markup.join('') || '<div class="empty-state compact"><p>没有匹配的项目</p></div>';
  elements.catalogTree.querySelectorAll('[data-project-key]').forEach((button) => {
    button.addEventListener('click', () => selectProject(button.dataset.projectKey));
  });
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
  state.selectedProject = selected;
  state.selectedType = 'all';
  elements.breadcrumb.textContent = `${selected.bucket.name} / ${selected.organization.id}`;
  elements.projectTitle.textContent = selected.project.slug;
  renderCatalogTree();
  renderDocumentList();
  if (!options.keepDocument && selected.project.documents.length > 0) loadDocument(selected.project.documents[0].id);
}

function filteredDocuments() {
  const documents = state.selectedProject?.project.documents ?? [];
  const query = state.query.toLowerCase();
  return documents.filter((document) => {
    const matchesType = state.selectedType === 'all' || fileType(document) === state.selectedType;
    const matchesQuery = !query || [document.path, document.source_label, document.name]
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
    <button class="document-item ${state.selectedDocument?.id === document.id ? 'active' : ''}" type="button" data-document-id="${document.id}">
      <span class="file-icon">${fileType(document)}</span>
      <span class="document-copy">
        <strong>${escapeHtml(document.name)}</strong>
        <small>${escapeHtml(document.path)}</small>
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

async function loadDocument(documentId) {
  elements.viewerContent.innerHTML = '<div class="loading-line"></div><div class="loading-line"></div><div class="loading-line"></div>';
  try {
    const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`);
    if (!response.ok) throw new Error(`文档读取失败（${response.status}）`);
    const loaded = await response.json();
    state.selectedDocument = loaded.document;
    state.content = loaded.content;
    renderDocumentList();
    await renderViewer(loaded.document, loaded.content);
    const url = new URL(window.location.href);
    url.searchParams.set('document', loaded.document.id);
    window.history.replaceState({}, '', url);
  } catch (error) {
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
            selectProject(projectKey(bucket, organization, project), { keepDocument: true });
            loadDocument(requestedDocumentId);
            return;
          }
        }
      }
    }
  }
  const preferred = (state.catalog?.buckets ?? []).find((bucket) => bucket.name !== 'local-workspace')
    || state.catalog?.buckets?.[0];
  const organization = preferred?.organizations?.[0];
  const project = organization?.projects?.[0];
  if (preferred && organization && project) selectProject(projectKey(preferred, organization, project));
}

function applyCatalog(catalog, preserveSelection = false) {
  const previousProjectKey = state.selectedProject?.key;
  const previousDocumentId = state.selectedDocument?.id;
  state.catalog = catalog;
  renderMetrics();
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
document.querySelectorAll('[data-drilldown]').forEach((button) => {
  button.addEventListener('click', () => drillDown(button.dataset.drilldown));
});
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
