# axis-document-review

Axis 项目文档的本地只读观测与评审页面。它按 `bucket / organization / project` 聚合本地 `.axis/docs` 与阿里云 OSS 项目文档，并在浏览器中查看 Markdown、YAML、JSON、文本和 CSV。

阅读器使用本地打包的 `marked`、`DOMPurify`、`Mermaid` 和 `highlight.js`：支持 GFM Markdown、表格、流程图/状态图以及常见代码格式高亮，不依赖公网 CDN。

## 启动

```bash
npm install
npm start -- --repo /path/to/project --open
```

左侧数据源卡片用于切换目录，组织和项目区只展示当前数据源的内容；健康 OSS 默认作为跨组织、跨项目阅读源，本地工作区只表示启动时指定的当前仓库。文档阅读区使用独立滚动容器，可通过滚轮、触控板或滚动条查看全文。

看板不会后台轮询或自动替换正在阅读的内容。文档生产流程应在本地修改完成后及时同步 OSS；需要查看最新目录时，由用户点击“刷新”主动重新读取数据源。

OSS 项目的最新已发布 `_sync/manifest.json` 是当前文档集合的完成标记。看板只展示该 manifest 声明的当前项目文档；结构迁移前遗留在 OSS 的旧对象继续保留，但不会与新的能力总览/二级能力结构同时出现在当前列表。缺少有效 manifest 的兼容项目仍按对象列表读取，避免旧项目不可浏览。

数据源、组织/项目与文档列表统一收纳在左侧导航中，右侧主区域完整用于阅读正文；文档列表和正文分别独立滚动。

项目目录使用扁平的“组织 + 项目”行，文档路径、文件名、文件元信息、刷新时间和操作按钮集中在同一个紧凑文档头中。

项目默认筛选并打开 Markdown 文档。文件列表以“文件名 + Markdown 一级标题”展示；能力总览和二级能力设计按父子树折叠。业务架构可进入各能力总览，能力总览可进入二级详细设计；阅读器提供返回上级、上一个和下一个同级文档。正文中的项目内路径也可直接点击跳转，阅读器支持全屏预览。

当前文档从 `.axis/docs/orgs/` 进入默认目录。修订快照从 `.axis/docs/_archive/orgs/` 读取，独立保存在项目 `archives` 中，只通过当前文档头部的“历史追溯”按钮展示；历史版本不会进入当前文档列表、搜索计数或默认打开逻辑。历史面板显示 revision、存档时间、修改原因和内容哈希，并提供“返回当前版本”。

默认监听 `http://127.0.0.1:4177`。可使用 `--source local` 或 `--source oss` 限定数据源，也可用 `--host`、`--port` 调整地址。

OSS 配置来自目标项目的 `.axis/config.yml` 与组织注册表；访问凭据只从配置声明的环境变量读取，不会发送给浏览器。某个数据源不可用时，页面会显示降级状态，其他健康数据源仍可浏览。

## Provider 扩展

新增数据源时实现以下只读 Provider 接口，并将实例传给 `DocumentCatalogService`：

```js
{
  id: 'stable-source-id',
  label: '可读名称',
  type: 'provider-type',
  async listDocuments() {},
  async readDocument(locator) {},
}
```

`listDocuments()` 返回的每项必须包含 `bucket`、`organizationId`、`projectSlug`、`path`、`locator`、`mediaType`、`size` 和 `updatedAt`。存档项还需要 `is_archive: true`、`canonical_path`、revision 和追溯元数据。服务端统一生成稳定文档 ID，并通过 `/api/catalog`、`/api/documents/:id`、`/api/health`、`/api/metrics` 暴露只读 API。

## 安全边界

- 服务默认仅绑定 `127.0.0.1`。
- 浏览器不接触 OSS AccessKey 或安全令牌。
- 只读取受支持的文本文件，单文档上限为 5 MiB。
- 页面不提供写入、删除或上传能力。

## 开源协议

MIT
