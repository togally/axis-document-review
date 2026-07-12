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

function renderInline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}/.test(line) && line.includes('|');
}

function renderMarkdown(markdown) {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const output = [];
  let index = 0;
  let inCode = false;
  let codeLanguage = '';
  let codeLines = [];
  let listType = null;

  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = null;
  };

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith('```')) {
      closeList();
      if (!inCode) {
        inCode = true;
        codeLanguage = line.slice(3).trim();
        codeLines = [];
      } else {
        output.push(`<pre data-language="${escapeHtml(codeLanguage)}"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCode = false;
      }
      index += 1;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      index += 1;
      continue;
    }
    if (index + 1 < lines.length && line.includes('|') && isTableSeparator(lines[index + 1])) {
      closeList();
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      output.push('<div class="table-wrap"><table><thead><tr>');
      output.push(headers.map((cell) => `<th>${renderInline(cell)}</th>`).join(''));
      output.push('</tr></thead><tbody>');
      for (const row of rows) {
        output.push(`<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`);
      }
      output.push('</tbody></table></div>');
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const nextListType = unordered ? 'ul' : 'ol';
      if (listType !== nextListType) {
        closeList();
        listType = nextListType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${renderInline((unordered || ordered)[1])}</li>`);
      index += 1;
      continue;
    }
    closeList();
    if (line.startsWith('>')) {
      output.push(`<blockquote>${renderInline(line.replace(/^>\s?/, ''))}</blockquote>`);
    } else if (line.trim()) {
      output.push(`<p>${renderInline(line)}</p>`);
    }
    index += 1;
  }
  closeList();
  if (inCode) output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  return output.join('\n');
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

function renderViewer(documentRecord, content) {
  elements.viewerPath.textContent = `${documentRecord.bucket} / ${documentRecord.organizationId} / ${documentRecord.projectSlug} / ${documentRecord.path}`;
  elements.viewerTitle.textContent = documentRecord.name;
  elements.viewerSource.textContent = documentRecord.source_label;
  elements.viewerMeta.innerHTML = `
    <span>${escapeHtml(documentRecord.mediaType)}</span>
    <span>${formatBytes(documentRecord.size)}</span>
    <span>${formatDate(documentRecord.updatedAt)}</span>
  `;
  elements.viewerContent.innerHTML = documentRecord.mediaType === 'text/markdown'
    ? renderMarkdown(content)
    : `<pre class="raw-document"><code>${escapeHtml(content)}</code></pre>`;
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
    renderViewer(loaded.document, loaded.content);
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
