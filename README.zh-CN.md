# cpa-authfile-cleaner

[English](README.md)

清理 CLIProxyAPI 管理端中的无效 auth 文件，但只会在能明确确认该 auth 已经是未授权状态（`401`）时才删除。

这个工具适合希望更稳妥地做清理的运维场景：不是看一眼报错文本就删，而是基于可验证的条件再动手。

## 功能

- 从 Management API 拉取 auth 文件列表
- 支持按 provider 过滤
- 支持安全的 `dry-run` 预览模式
- 仅在 auth 被确认为无效时删除
- 输出 JSON 报告，方便审计和复查

## 判定模式

### `status`

只有在以下条件同时满足时才删除：

- 运行时 `status` 不存在，或等于 `error`
- `status_message` 是合法 JSON
- 解析后的结构中存在 `status = 401`

### `probe`

- 对每个 auth 调用一次 `POST /api-call`
- 只有 probe 返回 HTTP `401` 时才删除

`probe` 更慢，但也更严格；如果你想用真实请求确认 auth 是否失效，这个模式更稳。

## 快速开始

### 从源码运行

环境要求：

- Node.js `>= 18`
- pnpm

安装依赖并构建：

```bash
pnpm install
pnpm build
```

创建配置文件：

```bash
cp cleaner.config.example.json cleaner.config.json
```

先预览：

```bash
./run.sh --dry-run true
```

正式删除：

```bash
./run.sh --dry-run false
```

### 使用发布好的二进制

从 GitHub Releases 下载对应平台压缩包：

- `linux-x64`
- `linux-arm64`
- `win-x64`

然后：

1. 解压压缩包
2. 把 `cleaner.config.example.json` 复制为 `cleaner.config.json`
3. 填入 `baseUrl` 和 `managementKey`
4. 运行可执行文件

示例：

```bash
./cpa-authfile-cleaner --help
./cpa-authfile-cleaner --dry-run true
```

Windows：

```bat
cpa-authfile-cleaner.exe --help
cpa-authfile-cleaner.exe --dry-run true
```

## 配置

默认配置文件名：`cleaner.config.json`

示例：

```json
{
  "baseUrl": "https://your-host.example.com/v0/management",
  "managementKey": "",
  "mode": "status",
  "dryRun": true,
  "concurrency": 2,
  "retries": 0,
  "output": "report.json",
  "onlyProvider": "codex",
  "includeDisabled": false
}
```

字段说明：

- `baseUrl`：Management API 基础路径
- `managementKey`：管理密钥；如果设置了 `MANAGEMENT_KEY`，这里可以留空
- `mode`：`status` 或 `probe`
- `dryRun`：只预览，不删除
- `concurrency`：并发 worker 数量
- `retries`：`probe` 模式重试次数
- `output`：报告输出路径
- `onlyProvider`：按 provider 过滤
- `includeDisabled`：是否包含 disabled 的 auth 文件

`managementKey` 的兜底读取顺序：

1. `--management-key`
2. `cleaner.config.json`
3. `MANAGEMENT_KEY`
4. `CPA_MANAGEMENT_KEY`

## CLI 用法

```bash
./run.sh --help
```

常用命令：

```bash
./run.sh --dry-run true
./run.sh --mode probe --dry-run true
./run.sh --mode probe --dry-run false
./run.sh --base-url https://example.com/v0/management
./run.sh --only-provider codex
./run.sh --config ./prod-cleaner.json
```

## 输出

控制台摘要示例：

```text
total=120 delete=17 keep=103 dryRun=true
```

如果设置了 `output`，工具还会写出一份 JSON 报告。

## 使用到的 API

基础路径：`.../v0/management`

- `GET /auth-files`
- `DELETE /auth-files?name=<file.json>`
- `POST /api-call`

## 发布自动化

GitHub Actions 会构建以下平台的二进制：

- Linux x64
- Linux arm64
- Windows x64

当推送 tag（例如 `v0.1.0`）时，工作流会自动构建、上传产物，并发布到 GitHub Releases。

## 备注

- Linux 发布产物基于 `glibc`
- Windows 二进制未签名
- 公开仓库里别提交真实 `managementKey`，这个坑很经典
