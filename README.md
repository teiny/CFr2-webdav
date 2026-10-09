# Cloudflare R2 WebDAV Server

基于 Cloudflare Workers 和 R2 的通用 WebDAV 服务。通过一个 Worker 和一个 R2 存储桶提供文件访问、目录管理、条件读写和自定义属性，无需维护服务器。

服务使用单组账号密码进行 HTTP Basic 认证。浏览器可以查看目录和下载文件，上传、复制、移动及属性操作通过 WebDAV 客户端或 HTTP 请求完成。

本文描述当前源码的行为，实际可用功能取决于部署的版本。服务声明 `DAV: 1`，不宣称完整 WebDAV 合规；需要强制锁或无限深度目录查询的客户端可能不兼容。

## 功能与协议支持

| 方法或功能     | 当前行为                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `OPTIONS`      | 返回支持的方法、`DAV: 1` 和 CORS 头；不要求认证                                                                                |
| `GET` / `HEAD` | 文件下载与元数据；目录 HTML 列表；支持文件 ETag 和 HTTP 日期条件                                                               |
| 条件下载       | `If-None-Match` 命中时返回 `304`，无正文；前置条件不满足返回 `412`                                                             |
| 范围下载       | 支持单个 `Range: bytes=...` 和 `If-Range`；返回 `206`，越界返回 `416`；多范围或非法格式忽略范围并返回完整正文                  |
| `PUT`          | 流式写入完整文件；创建返回 `201`，覆盖返回 `204`；支持 `If-Match`、`If-None-Match: *`；带 `Content-Range` 的局部上传返回 `400` |
| `MKCOL`        | 创建目录；父目录必须存在；已有资源返回 `405`，非空请求体返回 `415`                                                             |
| `PROPFIND`     | 支持 `allprop`、`propname`、指定属性和 `allprop + include`；集合支持 `Depth: 0` / `1`，无限深度返回 `403`                      |
| `PROPPATCH`    | 设置/删除自定义属性和 `displayname`；保留 XML 命名空间、混合内容、`xml:lang`；结果返回 `207`，需要检查各属性状态               |
| `COPY`         | 文件和递归目录复制；目录支持 `Depth: 0` / `infinity`，默认 `infinity`                                                          |
| `MOVE`         | 文件和递归目录移动；目录要求 `Depth: infinity`；复制成功后删除源，不提供跨对象事务                                             |
| `DELETE`       | 删除文件或递归目录；目录要求省略 Depth 或使用 `infinity`；已不存在的目标仍返回 `204`；禁止删除根目录                           |
| `Overwrite`    | COPY/MOVE 默认 `T`；`F` 拒绝已有目标，返回 `412`；`T` 覆盖目录时会先删除整个旧目标树                                           |
| WebDAV `If`    | 支持 ETag、`Not`、列表内 AND、列表间 OR 和带资源 URI 的条件；不提供锁令牌状态                                                  |
| 容量属性       | 显式请求 `quota-used-bytes` 时统计整个桶内的可见对象字节数；`quota-available-bytes` 返回属性级 `404`                           |

资源路径对应 R2 对象 key，例如 `/documents/report.txt` 对应 `documents/report.txt`。已有文件前缀形成的隐式目录可以被识别；新增文件和目录的父集合必须存在，服务不会自动创建缺失父目录。

COPY/MOVE 的 Destination 必须与请求同源；跨服务目标返回 `502`，源与目标相同或目录路径重叠返回 `403`。目录 MOVE 省略 Depth 时按 `infinity` 处理。

## 部署

### 1. 准备 Cloudflare 资源

1. 在 [Cloudflare Dashboard](https://dash.cloudflare.com/) 创建 R2 存储桶。
2. 创建目标 Worker，名称与 `wrangler.toml` 的 `name` 一致；默认是 `cfr2-webdav`。首次可以先发布默认示例代码，再配置绑定。
3. 在该 Worker 的生产环境设置以下运行时变量和绑定，并保存/部署使其生效：

| 名称       | 类型           | 用途                                    |
| ---------- | -------------- | --------------------------------------- |
| `USERNAME` | 变量或 Secret  | WebDAV 用户名；用户名不能包含冒号       |
| `PASSWORD` | Secret（推荐） | WebDAV 密码；支持 UTF-8 和冒号          |
| `BUCKET`   | R2 存储桶绑定  | 指向实际存储桶，绑定名称必须为 `BUCKET` |

`BUCKET_NAME` 是旧配置中的字段，当前存储访问由 `BUCKET` 绑定决定，不需要设置它。修改桶名变量不会切换存储桶，应修改 R2 绑定。

### 2. 理解配置保留方式

仓库中的 `wrangler.toml` 与 `wrangler.toml.template` 使用以下配置：

```toml
name = "cfr2-webdav"
main = "src/index.ts"
compatibility_date = "2023-01-01"
keep_vars = true

[[r2_buckets]]
binding = "BUCKET"
```

- `keep_vars = true` 保留 Dashboard 中的普通变量；Secret 由 Cloudflare 单独管理。账号密码不要写入仓库中的 `[vars]`，显式配置同名值仍可能覆盖控制台设置。参见 [Wrangler 配置说明](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)和 [Secret 配置说明](https://developers.cloudflare.com/workers/configuration/secrets/)。
- 本项目使用 Wrangler 4.148.0 的已有 R2 绑定继承能力：省略 `bucket_name`，部署时继承目标 Worker 已存在的同名 `BUCKET` 绑定。首次部署源码前必须先完成上一步的 Worker 和绑定配置。
- 如果桶使用特殊 `jurisdiction`，两份配置需要声明与已有绑定一致的值，例如 `jurisdiction = "eu"`。
- 修改 Worker 名称时同步修改两份 TOML。GitHub Actions 会将模板复制为配置文件，只改 `wrangler.toml` 不会改变 Actions 的部署目标。

### 3. 选择部署方式

#### GitHub Actions

1. Fork [本仓库](https://github.com/teiny/CFr2-webdav)，准备好上面的 Cloudflare 资源。
2. 按 [Cloudflare 官方说明](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)创建具有目标账户 Workers 部署权限的 API Token。
3. 在仓库的 **Settings → Secrets and variables → Actions** 添加 `CLOUDFLARE_API_TOKEN`。
4. 启用 Actions，将需要发布的代码合并或推送到 `main`。
5. 在 Actions 查看部署结果，部署成功后访问 Worker 的 HTTPS 地址。

实际工作流位于 [`.github/workflows/main.yml`](.github/workflows/main.yml)，使用 Node.js 22、`cloudflare/wrangler-action@v3` 和固定的 Wrangler 4.148.0。它只监听 `main` 推送，没有配置 `workflow_dispatch` 手动运行入口；推送其他分支不会触发这个工作流。账号、密码和桶绑定不从 GitHub Secrets 注入。

如果部署时无法自动选择 Cloudflare 账户，可在两份 TOML 中明确配置目标 `account_id`。API Token、WebDAV 密码与账户选择是不同配置，不要混用。

#### 本地命令行部署

安装 Node.js 22 或满足当前 Wrangler 要求的更高版本，使用包含目标功能的源码版本：

```sh
git clone https://github.com/teiny/CFr2-webdav.git
cd CFr2-webdav
npm ci
npx wrangler login
npm run typecheck
npm run deploy
```

先确认 `wrangler.toml` 的目标 Worker 名称及账户，再执行部署。Wrangler 会从 `src/index.ts` 打包部署；`npm run build` 生成的 `dist/worker.js` 用于本地构建检查，不是配置中的部署入口。

## 使用示例

在 WebDAV 客户端填写 Worker 的 HTTPS 根地址或子目录地址、`USERNAME` 和 `PASSWORD`。目录建议以 `/` 结尾，路径中的中文和特殊字符需要正确 URL 编码。

以下示例将 `https://webdav.example.com` 替换为实际地址，将 `dav-user` 替换为用户名。`curl -u dav-user` 会提示输入密码，避免把密码直接写入命令。Windows PowerShell 中可使用 `curl.exe`；示例中的多行续行写法适用于 POSIX shell，PowerShell 可合并成一行执行。

### 连接与目录查询

```sh
# 查看服务声明的方法
curl -i -X OPTIONS https://webdav.example.com/

# 查询根目录及直接子项
curl -i -u dav-user -X PROPFIND -H 'Depth: 1' https://webdav.example.com/

# 创建目录，父目录必须已存在
curl -i -u dav-user -X MKCOL https://webdav.example.com/dav-demo/
```

`PROPFIND` 省略 Depth 会按 `infinity` 处理，因此目录查询请显式发送 `Depth: 0` 或 `1`。`207 Multi-Status` 中可能同时包含成功和失败状态，客户端应读取 XML 内的 `status` / `propstat`。

### 上传、条件下载和范围下载

准备本地 `sample.txt` 文件：

```sh
# 仅在目标不存在时上传；已有目标返回 412
curl -i -u dav-user -X PUT -H 'If-None-Match: *' \
  --data-binary @sample.txt https://webdav.example.com/dav-demo/sample.txt

# 获取当前 ETag
curl -I -u dav-user https://webdav.example.com/dav-demo/sample.txt

# 将 etag-from-server 替换为上一响应的实际 ETag，保留双引号
curl -i -u dav-user -H 'If-None-Match: "etag-from-server"' \
  https://webdav.example.com/dav-demo/sample.txt

# 下载前 1024 字节；文件较小时范围会截断到文件末尾
curl -i -u dav-user -H 'Range: bytes=0-1023' \
  https://webdav.example.com/dav-demo/sample.txt
```

更新文件时发送 `If-Match: "实际ETag"` 可以拒绝过期版本覆盖。收到 `412` 后，客户端需要重新读取文件并决定如何合并或重试；无条件 PUT 仍会覆盖，服务不会自动合并文件内容。

### 自定义属性

将以下内容保存为 `props.xml`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<D:propertyupdate xmlns:D="DAV:" xmlns:x="urn:example:properties">
  <D:set>
    <D:prop>
      <D:displayname>示例文件</D:displayname>
      <x:note xml:lang="zh-CN">通过 WebDAV 保存的备注</x:note>
    </D:prop>
  </D:set>
</D:propertyupdate>
```

```sh
curl -i -u dav-user -X PROPPATCH -H 'Content-Type: application/xml' \
  --data-binary @props.xml https://webdav.example.com/dav-demo/sample.txt

curl -i -u dav-user -X PROPFIND -H 'Depth: 0' \
  https://webdav.example.com/dav-demo/sample.txt
```

自定义属性和 `displayname` 可修改；ETag、大小、内容类型、创建时间、最后修改时间、资源类型、容量及锁属性由服务保护。修改保护属性会返回属性级 `403`，同一请求中的其他变更返回 `424`，整批不写入。属性记录并发冲突返回 `412`。修改 `displayname` 不会重命名文件路径。

## 文件与属性存储

- 用户文件使用原始 R2 key，无需内容指针或数据布局迁移。
- 显式目录使用以 `/` 结尾的标记对象；已有子文件也可形成隐式目录。明确资源的 `creationdate` 保存在 R2 `customMetadata`，后续普通 PUT 保留；隐式目录可能没有可知的创建时间。
- WebDAV 自定义属性存为独立 JSON 对象：`.webdav-internal/properties/<资源路径的 SHA-256>.json`，不是放在用户文件的 R2 `customMetadata` 中。
- 单个属性记录最大 1 MiB。一个 PROPPATCH 请求的全部变更在同一条记录中通过 R2 条件写入保存；正文与属性记录之间没有跨对象事务。
- PUT 保留原属性，COPY/MOVE 复制属性，DELETE 清理属性；覆盖复制会清除旧目标属性。

`.webdav-internal/` 是服务保留命名空间，WebDAV 请求不可访问它，列表和用量统计也会排除它。部署前确认没有同名用户数据；备份或迁移需要保留内部属性记录。直接在 R2 控制台改名、复制或删除文件会绕过属性联动。回退旧版时，旧代码可能暴露内部对象，需同时处理兼容性。

## 限制、认证与性能

- **锁与同步**：不实现 LOCK/UNLOCK、锁存储、`sync-token` 或可靠的 `REPORT sync-collection`。文件正文 ETag 不随自定义属性变化，目录标记 ETag 也不代表整棵目录树版本。
- **条件删除**：R2 没有条件 DELETE 能力，需要条件保护的 DELETE 返回 `501`；WebDAV `If` 格式错误或条件不满足也可能先返回 `400` / `412`。
- **操作原子性**：MOVE 是复制后删除，删除前会检查已枚举源对象的版本，但检查与删除之间仍有竞争窗口。目录修改、正文与属性联动都可能部分完成；递归操作失败返回 `207`。`Overwrite: T` 清除旧目标后再复制，失败时不保证恢复旧目标。
- **局部更新**：不实现 PATCH、部分 PUT 和多范围响应；PATCH 返回 `405`，带 Content-Range 的 PUT 返回 `400`。范围下载与局部上传是两种功能。
- **容量与资源限制**：不实施硬/软配额，无法给出可靠可用容量。大目录操作受 Workers 单请求资源及子请求额度约束；显式查询用量会扫描整个桶。费用和额度以 [R2 定价](https://developers.cloudflare.com/r2/pricing/)与 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)为准。
- **认证**：所有文件共享一组账号密码，没有用户隔离或分目录权限。每个受保护请求都会校验凭据，没有登录会话、固定失效时间或注销接口。浏览器缓存凭据的期限由浏览器决定，关闭标签页不能保证退出。请通过 HTTPS 访问。
- **调用成本**：普通成功文件 GET、HEAD 各一次 R2 调用；范围 GET 通常需要 head + get；属性和目录操作增加相应读写/清理；条件下载命中 304 省去正文，但仍有网络往返和存储查询。
- **缓存与速度**：未添加边缘正文缓存，响应使用 `Cache-Control: private, no-cache`。客户端发送条件请求才能减少未变化文件的传输，不能保证跨地区访问延迟或变化文件下载速度。
- **日志**：记录方法、状态、请求处理时间和 R2 操作时间；这些耗时截至取得/构造响应，不包含客户端下载完整正文的时间。应用日志不主动记录认证头或文件正文，存储错误信息仍可能包含服务端上下文。

## 本地开发

```sh
npm ci
```

在项目根目录创建 `.dev.vars`，以下仅为本地测试示例，替换为自己的测试值：

```dotenv
USERNAME="local-user"
PASSWORD="replace-with-a-local-test-password"
```

`.dev.vars` 已被 Git 忽略；Dashboard 的运行时变量不会自动成为本地值。保留仓库中的 R2 绑定配置，然后运行：

```sh
npm run dev
```

默认本地开发使用模拟 R2；本地数据与生产桶隔离，并会保留在 `.wrangler/` 下。若 Wrangler 为本地资源生成配置，不要把模拟桶名带入生产配置。远端开发或 `remote` 绑定会改变这一行为，应明确区分所连接的环境。参见 [Cloudflare 本地开发说明](https://developers.cloudflare.com/workers/local-development/)。

可用检查命令：

```sh
npm run typecheck
npm run build
```

项目使用 TypeScript、saxes、Wrangler，构建检查输出到 `dist/worker.js`。GitHub 工作流当前执行部署，不包含独立的测试步骤。本地模拟结果不能代替生产 R2、真实客户端兼容性和线上速度测试。

## 常见问题

| 现象                          | 排查方向                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| 持续 `401`                    | 确认生产环境 USERNAME/PASSWORD 已生效，用户名没有冒号，客户端未继续使用旧凭据                       |
| 部署后变量又变了              | 检查两份 TOML 是否保留 `keep_vars = true`，以及是否重新加入同名 `[vars]`；确认部署的是同一个 Worker |
| 文件突然 `404`                | 检查 `BUCKET` 实际绑定与文件 key；BUCKET_NAME 不决定存储位置；检查路径编码                          |
| 上传或创建目录 `409`          | 先创建父目录；检查同一路径是否已被文件或目录占用                                                    |
| 目录查询 `403`                | 显式使用 `Depth: 0` / `1`；省略 Depth 等同 infinity                                                 |
| 更新返回 `412`                | ETag 已过期、目标已存在或属性记录被其他请求更新，重新读取后处理冲突                                 |
| 操作返回 `207`                | 解析 XML 内每个资源或属性的状态，不能把 207 一律视为完整成功                                        |
| 锁定或挂载失败                | 客户端可能要求 LOCK/UNLOCK 或其他未实现能力；检查客户端请求及服务日志                               |
| 缺少 `bucket_name` 的部署错误 | 确认目标 Worker 已有同名 BUCKET 绑定、jurisdiction 一致，并使用支持继承的 Wrangler 版本             |

## 项目入口与参考

- [`src/index.ts`](src/index.ts)：Worker 入口。
- [`src/handlers/`](src/handlers/)：认证、请求路由和 WebDAV 方法。
- [`src/utils/`](src/utils/)：条件请求、资源/集合操作、属性、XML、范围和日志。
- [`wrangler.toml`](wrangler.toml)：本地开发及命令行部署配置。
- [`wrangler.toml.template`](wrangler.toml.template)：GitHub Actions 使用的部署模板。
- [原项目 aigem/CFr2-webdav](https://github.com/aigem/CFr2-webdav)：项目来源参考。

欢迎通过 Issues 反馈客户端兼容性或协议问题，通过 Pull Requests 提交改进。

## 许可证

原 README 声明项目采用 MIT 许可证，当前仓库未包含独立的 `LICENSE` 文件。
