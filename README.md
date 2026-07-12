# axis-document-review

Axis 项目文档的本地只读观测与评审页面。它按 `bucket / organization / project` 聚合本地 `.axis/docs` 与阿里云 OSS 项目文档，并在浏览器中查看 Markdown、YAML、JSON、文本和 CSV。

## 启动

```bash
npm install
npm start -- --repo /path/to/project --open
```

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

`listDocuments()` 返回的每项必须包含 `bucket`、`organizationId`、`projectSlug`、`path`、`locator`、`mediaType`、`size` 和 `updatedAt`。服务端统一生成稳定文档 ID，并通过 `/api/catalog`、`/api/documents/:id`、`/api/health`、`/api/metrics` 暴露只读 API。

## 安全边界

- 服务默认仅绑定 `127.0.0.1`。
- 浏览器不接触 OSS AccessKey 或安全令牌。
- 只读取受支持的文本文件，单文档上限为 5 MiB。
- 页面不提供写入、删除或上传能力。

## 开源协议

MIT
