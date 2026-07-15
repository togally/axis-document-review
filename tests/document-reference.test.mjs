import assert from 'node:assert/strict';
import {
  compactDocumentLocator,
  compactEvidencePaths,
  isAuthoringMetadataText,
  resolveProjectDocumentPath,
} from '../src/document-reference.mjs';

const overviewPath = 'business/capabilities/community_engagement/detailed-design.md';
const secondaryPath = 'business/capabilities/community_engagement/secondary-capabilities/community_content_interaction/detailed-design.md';
const projectDocumentPaths = [
  'architecture/business.md',
  overviewPath,
  secondaryPath,
];

assert.equal(
  resolveProjectDocumentPath(
    'secondary-capabilities/community_content_interaction/detailed-design.md',
    overviewPath,
    projectDocumentPaths,
  ),
  secondaryPath,
  'a secondary-capability link must resolve relative to its current overview instead of navigating to a server path',
);
assert.equal(
  resolveProjectDocumentPath('../../../architecture/business.md', overviewPath, projectDocumentPaths),
  'architecture/business.md',
);
assert.equal(
  resolveProjectDocumentPath(`${secondaryPath}?view=compact#interfaces`, overviewPath, projectDocumentPaths),
  secondaryPath,
  'project-root references remain supported and query/fragment suffixes are ignored for catalog matching',
);
assert.equal(resolveProjectDocumentPath('#interfaces', overviewPath, projectDocumentPaths), null);
assert.equal(resolveProjectDocumentPath('https://example.com/reference.md', overviewPath, projectDocumentPaths), null);
assert.equal(resolveProjectDocumentPath('../../../../../outside.md', overviewPath, projectDocumentPaths), null);

assert.equal(
  compactDocumentLocator(secondaryPath),
  'community_engagement / community_content_interaction / detailed-design.md',
);
assert.equal(compactDocumentLocator(overviewPath), 'community_engagement / detailed-design.md');
assert.equal(compactDocumentLocator('architecture/business.md'), 'architecture / business.md');

assert.equal(
  compactEvidencePaths(
    'platform-modules/platform-app/src/test/java/com/whale/app/controller/petcircle/AppPetFriendCircleControllerTest.java:73-96#anonymousLocationDiscoverIsPublicAndDelegatesWithoutLoginContext',
  ),
  'AppPetFriendCircleControllerTest.java:73-96#anonymousLocationDiscoverIsPublicAndDelegatesWithoutLoginContext',
);
assert.equal(
  compactEvidencePaths('AppPetFriendCircleController.java:50-58#discoverByLocation'),
  'AppPetFriendCircleController.java:50-58#discoverByLocation',
  'already compact anchors stay unchanged',
);

assert.equal(
  isAuthoringMetadataText('文档状态：评审中 文档版本：10 所属能力：community_engagement 二级能力标识：community_content_interaction'),
  true,
  'reader view hides document lifecycle and stable-id authoring metadata',
);
assert.equal(
  isAuthoringMetadataText('设计完整性：interface_design_status=detailed interface_coverage=partial'),
  true,
  'reader view hides machine coverage controls',
);
assert.equal(
  isAuthoringMetadataText('本能力负责内容发布，用户提交后可以查看审核状态。'),
  false,
  'reader-facing business conclusions remain visible',
);
