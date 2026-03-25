# cpa-authfile-cleaner

[English](README.md)

这个工具不再只是“删失效 auth”，而是更稳妥地管理 CLIProxyAPI 的 auth 文件：明确 `401` 才删除，临时异常先禁用，连续成功后再恢复启用。

## 功能

- 从 Management API 拉取 auth 文件列表
- 支持按 provider 过滤
- 支持安全的 `dry-run` 预览模式
- 仅在 auth 被明确确认是 `401` 时删除
- 对非 `401` 失败执行禁用，而不是直接删除
- 仅对“本工具禁用”的 auth，在连续 `2` 次 probe 成功后恢复启用
- 输出 JSON 报告、本地状态文件，以及可选的 Prometheus textfile 指标

`dry-run` 说明：

- `dryRun=true` 时，不会删除、禁用、启用，也不会写入 `auth-state.json`
- `dryRun=false` 时，才会真正执行远端动作并保存本地状态

如果你只记住一条规则：

- 明确 `401` -> 删除
- 不是 `401`，但看起来不健康 -> 先禁用
- 后面恢复正常了 -> 连续成功几次后再启用

## 各个文件是干嘛的

大多数人最关心这几个：

- `cleaner.config.json`：你真正要改的本地配置文件
- `run.sh`：从源码运行时最省事的入口
- `report.json`：单次运行结果；想知道这轮发生了什么，先看它
- `auth-state.json`：工具的“记忆”，跨多轮运行保留状态

默认思路：

- 大多数场景下，只需要 `baseUrl` 和 `managementKey`
- 默认先让管理端自己决定怎么探测
- `onlyProvider` 和 `probeUrl` 是可选覆盖项，不是日常必填项

兼容性说明：

- 已验证旧行为：CLI Proxy API `v6.9.1` + 管理中心 `v1.7.15`，可以接受不带 `url` 的 `POST /api-call`
- 已验证新行为：CLI Proxy API `v6.9.2` + 管理中心 `v1.7.16`，如果不带 `url`，会返回 `400 {"error":"missing url"}`
- 工具现在会在启动时只试一次，自动判断管理端是否要求 `url`，需要时自动回退到默认 probe 地址

代码和支撑文件：

- `src/index.ts`：CLI 主入口；读配置、选模式、调度整个流程
- `src/http.ts`：对 Management API 的一层薄封装
- `src/probe.ts`：发起探测请求，用来判断某个 auth 还能不能用
- `src/state.ts`：负责本地 state 的读取、清理、保存、修复
- `src/metrics.ts`：负责输出 Prometheus textfile 指标
- `src/types.ts`：项目共用的 TypeScript 类型定义
- `cleaner.config.example.json`：新环境初始化时用的配置模板
- `scripts/build-release.mjs`：构建发布二进制和压缩包

大多是生成产物：

- `dist/`：TypeScript 编译后的输出
- `build/`、`releases/`、`release-bundles/`：打包产物，通常不用手改

## 模式

### `reconcile`

推荐默认模式。

- 执行分层巡检
- 删除已确认 `401` 的 auth
- 禁用 probe 非 `401` 失败的 auth
- 把历史状态写入 `auth-state.json`

### `recover`

- 只检查之前由本工具禁用的 auth
- 达到 `recoverAfterSuccesses` 次连续 probe 成功后自动启用

### 兼容旧模式

- `status`：只有 `status_message` 能证明 `401` 时才删除
- `probe`：probe 选中的 auth，只有返回 `401` 时才删除

兼容模式说明：

- `status` 和 `probe` 保持原来的“只删除”行为
- 只有 `reconcile` 和 `recover` 才会使用本地状态、禁用/启用流程、分层巡检和恢复逻辑

## 为什么要本地状态文件

CLIProxyAPI 的 `status`、`status_message`、`unavailable` 这些字段，只能说明“此刻看起来怎样”，不代表长期真相。成功一次调用、或者重启一下，它们就可能消失。

所以工具会维护自己的 `auth-state.json`，专门记住：

- 哪些 auth 是它禁用的
- 某个 auth 原本是否已经被禁用
- 连续成功/失败次数
- 什么时候该进入退避，暂时别继续 probe

这个 state 文件的行为：

- 每次非 `dry-run` 执行后，都会自动清理陈旧的本地状态项
- 只有当 auth 已经不在远端列表里，且不是仍由工具管理的 disabled 项时，才会被移除
- 落盘时会对 state 做稳定排序并使用原子写入，减少 diff 噪音和半截写入风险
- 一些过时的本地字段会在下次真正写盘时顺手清掉
- 遇到损坏或无效的 state 文件时，会先自动改名备份，再从空 state 恢复继续运行

## 分层巡检

面对大量 auth，不会每轮都全量 probe。

- 全量轻扫：所有 auth 都从 `GET /auth-files` 看一遍
- 深度 probe 优先级：可疑 auth、被本工具禁用的 auth、健康样本
- 失败退避：连续失败越多，下次 probe 间隔越长

这样几千个 auth 也能跑得住，不会把上游敲烦。

当前 `reconcile` 行为：

- 可疑 auth 永远优先 probe
- 被本工具禁用的 auth 永远会进入恢复判断
- 所有可疑 auth 都会被 probe，不受健康抽样预算限制
- 被本工具禁用的 auth 也都会进入恢复判断
- `maxProbeCandidatesPerRun` 只限制健康抽样，不限制可疑 auth 和已禁用 auth

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

先预览一次巡检：

```bash
./run.sh --mode reconcile --dry-run true
```

正式执行：

```bash
./run.sh --mode reconcile --dry-run false
```

执行恢复检查：

```bash
./run.sh --mode recover --dry-run false
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

## 配置

默认配置文件名：`cleaner.config.json`

示例：

```json
{
  "baseUrl": "https://your-host.example.com/v0/management",
  "managementKey": "",
  "mode": "reconcile",
  "dryRun": true,
  "concurrency": 8,
  "retries": 0,
  "disableAfterFailures": 2,
  "output": "report.json",
  "includeDisabled": true,
  "stateFile": "auth-state.json",
  "recoverAfterSuccesses": 2,
  "healthSampleRate": 0.1,
  "maxProbeCandidatesPerRun": 200,
  "metrics": {
    "enabled": false,
    "output": "metrics.prom"
  }
}
```

字段说明：

- `baseUrl`：Management API 基础路径
- `managementKey`：管理密钥；如果设置了 `MANAGEMENT_KEY`，这里可以留空
- `mode`：`status`、`probe`、`reconcile`、`recover`
- `dryRun`：只预览，不修改远端 auth 状态
- `concurrency`：probe / 执行动作的并发数
- `retries`：probe 重试次数
- `disableAfterFailures`：非 `401` 连续失败多少次后才执行禁用
- `output`：JSON 报告输出路径
- `includeDisabled`：是否把 disabled auth 纳入源列表
- `stateFile`：本地状态文件路径
- `recoverAfterSuccesses`：恢复启用前需要连续成功的 probe 次数
- `healthSampleRate`：每轮对健康 auth 的抽样 probe 比例
- `maxProbeCandidatesPerRun`：单轮深度 probe 数量上限
- `metrics.enabled`：是否写出 Prometheus textfile 指标
- `metrics.output`：Prometheus textfile 输出路径

可选高级覆盖项：

- `onlyProvider`：只处理某一种 provider；适合灰度清理或单独排查
- `probeUrl`：强制指定探测地址；只有在你不想让管理端自动选择时才需要

默认建议：

- 先不填写 `probeUrl`
- 如果管理端支持省略 `url`，就继续让管理端自己决定探测目标
- 如果管理端不支持，工具会在本轮自动回退到默认 probe 地址
- 只有你想强制指定某个探测地址时，才手动填写 `probeUrl`

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
./run.sh --mode reconcile --dry-run true
./run.sh --mode reconcile --dry-run false
./run.sh --mode recover --dry-run false
./run.sh --only-provider codex
./run.sh --probe-url https://api.openai.com/v1/models
./run.sh --metrics-enabled true --metrics-output ./metrics.prom
```

## 输出文件

- `report.json`：这轮运行的结果单；做了什么、为什么这么做，都看这里
- `auth-state.json`：工具自己的记账本；避免误删，也支撑后续恢复逻辑
- `metrics.prom`：可选的 Prometheus textfile 指标输出

指标补充：

- `cpa_authfiles_state_pruned_total`：本轮被压缩掉的陈旧本地状态条目数量
- `cpa_authfiles_state_changed`：本轮有效 state 内容是否发生变化
- `cpa_authfiles_state_normalized`：本轮加载的 state 是否需要规范化
- `cpa_authfiles_state_recovered`：本轮是否从损坏的 state 文件恢复
- `cpa_authfiles_state_save_duration_seconds`：本轮保存本地 state 花费的时间
- `report.json` 也会包含 `prunedStateEntries`、`stateChanged`、`stateNormalized`、`stateRecovered`、`stateRecoveryBackupPath` 和 `stateSaved`

测试提示：

- 如果 management 接口返回的是 HTML 而不是 JSON，通常说明 `baseUrl` 指到了前端页面或错误的反代路由

控制台摘要示例：

```text
total=120 delete=3 disable=11 enable=2 keep=96 skip=8 pruned=14 stateChanged=true stateSaved=true dryRun=false mode=reconcile
```

## 使用到的 API

基础路径：`.../v0/management`

- `GET /auth-files`
- `DELETE /auth-files?name=<file.json>`
- `POST /api-call`
- `PATCH /auth-files/status`

## 调度建议

推荐：

- `reconcile`：每 `15` 分钟一次
- `recover`：每 `30` 分钟一次

示例 cron：

```cron
*/15 * * * * /path/to/cpa-authfile-cleaner --config /path/to/cleaner.config.json --mode reconcile --dry-run false
*/30 * * * * /path/to/cpa-authfile-cleaner --config /path/to/cleaner.config.json --mode recover --dry-run false
```

## 发布自动化

GitHub Actions 会构建以下平台的二进制：

- Linux x64
- Linux arm64
- Windows x64

当推送 tag（例如 `v0.1.0`）时，工作流会自动构建、上传产物，并发布到 GitHub Releases。

如果只是本机 ARM64 环境自测，可以单独构建 ARM64 包，不影响 GitHub Actions 的多平台发布流程：

```bash
pnpm release:linux-arm64
```

## 备注

- Linux 发布产物基于 `glibc`
- Windows 二进制未签名
- 公开仓库里别提交真实 `managementKey`
- Prometheus textfile 输出适合接给 node-exporter 的 textfile collector
