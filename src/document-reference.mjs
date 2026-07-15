const externalReferencePattern = /^[a-z][a-z0-9+.-]*:/i;
const evidencePathPattern = /(?:[A-Za-z0-9_.$@+\-]+\/)+([A-Za-z0-9_.$@+\-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?#[A-Za-z_$][A-Za-z0-9_$<>.\-]*)/g;

function referencePath(reference) {
  const value = String(reference ?? '').trim().replaceAll('\\', '/');
  if (!value || value.startsWith('#') || value.startsWith('?') || value.startsWith('//')) return null;
  if (externalReferencePattern.test(value)) return null;
  return value.split(/[?#]/, 1)[0] || null;
}

function normalizeSegments(initialSegments, reference) {
  const segments = [...initialSegments];
  for (const segment of reference.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

export function resolveProjectDocumentPath(reference, currentDocumentPath, projectDocumentPaths) {
  const rawPath = referencePath(reference);
  if (!rawPath) return null;
  const available = projectDocumentPaths instanceof Set
    ? projectDocumentPaths
    : new Set(projectDocumentPaths ?? []);
  const projectRelative = normalizeSegments([], rawPath.replace(/^\//, ''));
  if (projectRelative && available.has(projectRelative)) return projectRelative;
  const currentSegments = String(currentDocumentPath ?? '').replaceAll('\\', '/').split('/');
  currentSegments.pop();
  const relative = normalizeSegments(currentSegments, rawPath);
  return relative && available.has(relative) ? relative : null;
}

export function compactDocumentLocator(documentPath) {
  const normalized = String(documentPath ?? '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  const secondary = /^business\/capabilities\/([^/]+)\/secondary-capabilities\/([^/]+)\/([^/]+)$/.exec(normalized);
  if (secondary) return `${secondary[1]} / ${secondary[2]} / ${secondary[3]}`;
  const overview = /^business\/capabilities\/([^/]+)\/([^/]+)$/.exec(normalized);
  if (overview) return `${overview[1]} / ${overview[2]}`;
  const segments = normalized.split('/').filter(Boolean);
  return segments.slice(-2).join(' / ') || '未命名文档';
}

export function compactEvidencePaths(value) {
  return String(value ?? '').replace(evidencePathPattern, '$1');
}

const authoringMetadataLabels = [
  '文档状态',
  '文档版本',
  '能力标识',
  '所属能力',
  '二级能力标识',
  '对应业务标识',
  '证据基线',
];

const machineCoveragePattern = /(?:interface_design_status|interface_coverage|user_journey_design_status|user_journey_coverage|user_journey_gap_id|dependency_graph_status|dependency_graph_revision|dependency_graph_gap_id|table_design_status|table_design_coverage|table_design_gap_id)\s*=/i;

export function isAuthoringMetadataText(value) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (machineCoveragePattern.test(normalized)) return true;
  return authoringMetadataLabels.filter((label) => normalized.includes(label)).length >= 2;
}
