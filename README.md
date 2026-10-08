# Cloudflare R2 WebDAV Server

这个项目实现了一个基于 Cloudflare Workers 和 R2 存储的 WebDAV 服务器。它允许用户通过 WebDAV 协议访问和管理存储在 Cloudflare R2 中的文件和目录。

[R2免费额度](https://developers.cloudflare.com/r2/pricing/)  [视频教程](https://www.bilibili.com/video/BV1mh4peNECe/)

![部署Cloudflare R2 WebDAV服务，超简单拥有自己的私人网盘](https://raw.githubusercontent.com/aigem/CFr2-webdav/main/%E5%85%8D%E8%B4%B9%E4%B8%80%E9%94%AE%E9%83%A8%E7%BD%B2Cloudflare%20R2%20WebDAV%E6%9C%8D%E5%8A%A1%EF%BC%8C%E8%B6%85%E7%AE%80%E5%8D%95%E6%8B%A5%E6%9C%89%E8%87%AA%E5%B7%B1%E7%9A%84%E7%A7%81%E4%BA%BA%E7%BD%91%E7%9B%98-%E5%B0%81%E9%9D%A2.jpg)


## 特性

- 提供基本的 WebDAV 文件访问，协议支持范围见下文
- 基于 Cloudflare Workers，无需管理服务器
- 使用 Cloudflare R2 作为存储后端（免费额度慷慨）
- 支持基本的身份验证
- 支持文件上传、下载、删除、移动和复制操作
- 支持目录创建和列表

## 一键部署到 Cloudflare Workers

点击下面的按钮，一键将此项目部署到您的Cloudflare Workers账户：

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aigem/CFr2-webdav)

注需要有Cloudflare账户才能使用此功能。如果您还没有账户，可以在[Cloudflare官www.cloudflare.com)注册。

## 手动部署步骤 [Githut Actions]

如果您需要自定义配置或想要深入了解部署流程，请按以下步骤操作：

### 前提条件

- Cloudflare 账户
- 已创建的 R2 存储桶
- GitHub 账户

### 步骤 1: 配置 Cloudflare

1. 【获取API令牌】在 Cloudflare 仪表板中，创建一个新的 API 令牌，确保它有足够的权限来管理编辑Workers(和 R2)。
2. 【获取桶名称】创建的 R2 存储桶

3. 在 Cloudflare Dashboard 的 `cfr2-webdav` Worker 中设置运行时变量 `USERNAME`、`PASSWORD`（密码建议使用 Secret），并将 R2 绑定 `BUCKET` 指向实际存储桶。`BUCKET_NAME` 如需保留可在 Dashboard 设置；代码实际通过 `BUCKET` 绑定访问存储。

部署配置使用 `keep_vars = true`，且不再定义账号、密码或桶名的默认值。R2 配置只声明绑定名 `BUCKET`，后续 Wrangler 部署继承已有的同名 R2 绑定。首次使用时需先创建目标 Worker 并配置这些变量和绑定；已被覆盖的值需要在 Dashboard 恢复一次。R2 绑定若使用特殊 jurisdiction，需要在配置中声明相同 jurisdiction 才能继承。

### 步骤 2: 准备仓库

Fork 这个仓库到您的 GitHub 账户。
```
https://github.com/aigem/CFr2-webdav
```

### 步骤 3: 配置 GitHub Secrets

在您的 GitHub 仓库中，转到 Settings -> Secrets and variables -> Actions，添加以下 secrets：

- `CLOUDFLARE_API_TOKEN`: 步骤1的 Cloudflare API 令牌 (必须)

账号、密码和 R2 绑定统一在 Cloudflare Dashboard 管理；工作流不再从 GitHub Secrets 注入或回退这些参数。工作流固定使用 Wrangler 4.148.0，以支持已有 R2 绑定继承。

### 步骤 4: 配置 GitHub Actions

1. 在您的 GitHub 仓库设置中，启用 GitHub Actions。
2. workflow 文件已经存在，请选择： .github/workflow/main.yml

### 步骤 6: 触发部署

按上面操作完成后就会自动进行部署到CF Worker中，或将任何更改推送到 GitHub 仓库的 `main` 分支，或者手动运行 GitHub Actions 工作流。GitHub Actions 将自动触发部署流程。

您可以在 GitHub 仓库的 Actions 标签页中查看部署进度。部署成功后，您可以在 Cloudflare Workers 仪表板中找到您的 Worker URL。

## 使用方法

使用任何支持 WebDAV 协议的客到您的 Worker URL，使用配置的用户名和密码进行身份验证。


## 本地开发（可选）

如果您需要在本地进行开发和测试，请按以下步骤操作：

0. 同上面步骤1 ：配置 Cloudflare

1. 克隆仓库到本地：
   ```bash
   git clone https://github.com/aigem/CFr2-webdav.git
   cd cf-r2-webdav
   ```

2. 安装依赖：
   ```bash
   npm install
   ```

3. 将 `wrangler.toml.template` 复制为 `wrangler.toml`。本地认证值放在被忽略的 `.dev.vars` 中；线上变量不会自动下载到本地。配置省略桶名时，Wrangler 本地开发使用本地模拟 R2；不要将本地生成的桶名提交或用于线上部署。
  
4. 使用 Wrangler 进行本地开发：
   ```bash
   npx wrangler dev --local
   ```

注意：本地开发可能无法完全模拟 Cloudflare Workers 环境，特别是 R2 存储的操作。

## 注意事项

- 确保妥善保管您的 API 令牌和其他敏感信息。
- 定期更新您的依赖以确保安全性。
- 遵守 Cloudflare 的使用政策和条款。

## 条件同步与协议支持

- GET、HEAD、PROPFIND 和成功 PUT 响应使用带双引号的 ETag。
- GET/HEAD 支持条件请求：未变化返回 `304` 且不传输正文，版本前置条件失败返回 `412`。
- PUT 支持 `If-Match` 和 `If-None-Match: *`，写入条件由 R2 在存储操作中检查。创建返回 `201`，覆盖返回 `204`；冲突返回 `412`，客户端需重新下载、合并并上传。
- 无条件 PUT 保留原有覆盖行为；服务端不能合并加密 KDBX，也不能保护不发送条件头的客户端。
- PROPFIND 支持 Depth 0、1，allprop、propname 和指定属性；修正根目录、隐式子目录、编码路径和未知属性响应。集合的无限深度查询返回 `403`。
- COPY/MOVE 拒绝同路径和跨服务器目标，支持 `Overwrite: F`。集合 COPY/MOVE 与条件 DELETE 返回 `501`。MOVE 仍是复制再删除，不具备跨对象事务或源对象并发删除保护。
- 不实现 LOCK/UNLOCK、WebDAV `If` 锁令牌或递归集合修改；不宣称完整 WebDAV 合规。
- 请求日志记录处理时间和 R2 调用时间，不打印认证信息、文件内容或完整属性 XML。处理时间到响应构造完成为止，不包含客户端下载正文的时间。

这一版未添加边缘正文缓存。客户端缓存需要重验证；只有客户端发送条件请求，才能减少未变化文件的传输。

安装依赖后执行 `npm run typecheck`、`npm run build`。线上速度仍需在部署后实测。

## 贡献

欢迎提交 Pull Requests 或创建 Issues 来改进这个项目。

## 许可证

本项目采用 MIT 许可证。
