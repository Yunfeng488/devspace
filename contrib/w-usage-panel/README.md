# W → DevSpace MCP 载荷用量面板

这是 8787 面板的独立、只读集成层。它不启动服务、不管理 tunnel，也不写 WorkBuddy 数据；它只读取 `usage.sqlite` 中的数字元数据，并提供 `GET /usage` 与四个 `GET /api/usage/*` 端点。

## 计量边界

`estimated_tokens` 是用固定的 `tiktoken==0.14.0` / `o200k_base` 估算的 DevSpace MCP 工具参数和模型可见返回载荷。任意 MCP 文本（包括形如 `<|endoftext|>` 的保留特殊标记）均按普通文本计数；该规则属于 `mcp-visible-v3` epoch。它不是 W 整回合、模型输出或推理、系统提示、历史上下文、工具定义、账单或额度用量。

精确事实（bytes、Unicode 字符、调用、耗时）与估算 Token 分开输出。缺失、排队失败或不支持的媒体绝不按零填充；API 返回 `UNKNOWN` 或 `PARTIAL`。

## 受控部署门禁（Owner 执行）

不要在日常开发或本地测试中执行这一步。由 Owner 先备份现有 panel/dist、进程命令行、监听端口与哈希清单，确认 7676 和 8787 都是既有的 loopback listener 后，才可：

1. 从构建产物 `dist/usage-runtime/manifest.json` 逐项校验发布文件哈希。该清单是部署完整性清单，不是可独立启动的 DevSpace 分发包；`deployment_contract` 必须为 `INTEGRITY_INVENTORY_REQUIRES_DEVSPACE_PACKAGE`，并且实际 DevSpace 包必须由同一构建的 `npm pack` 产物安装。
2. 使用 [`prepare-usage-runtime.ps1`](../../scripts/prepare-usage-runtime.ps1) 创建私有运行目录、HMAC identity key ACL、独立 Python 3.11 venv，并按完整 hash lock 安装依赖和预热缓存。该脚本只允许在部署门禁执行，并强制 `RuntimeDirectory` 以 `runtime\devspace-usage` 结尾；父目录解析结果必须与原始路径完全一致，否则拒绝运行。
3. 如需手工复核，在 `H:\workbuddy\runtime\devspace-usage\tiktoken-cache` 预热并验证编码缓存：

   ```powershell
   & $usagePython -m pip install -r scripts\requirements-usage-tokenizer.txt
   & $usagePython scripts\prewarm-usage-tokenizer.py --cache-dir H:\workbuddy\runtime\devspace-usage\tiktoken-cache
   ```

4. 仅向 DevSpace 的现有启动配置增加下列非秘密环境变量：

   ```text
   DEVSPACE_USAGE_DIR=H:\workbuddy\runtime\devspace-usage
   DEVSPACE_USAGE_PYTHON=<the Python 3.11 virtual-environment python.exe>
   DEVSPACE_USAGE_WORKER=<versioned-release>\usage-runtime\tiktoken-worker.py
   DEVSPACE_USAGE_WORKER_SHA256=<manifest 中该 worker 的 SHA-256>
   ```

   启用前没有历史记录，面板应显示 `UNKNOWN`。运行时 worker 要求已有且 SHA-256 已验证的缓存；缺失缓存会显示 `TOKENIZER_UNAVAILABLE`，而不会联网下载。

5. 在当前 8787 panel 的请求分派代码中、通用 404 之前接入：

   ```js
   import { readFileSync } from "node:fs";
   import { addUsageMonitorLink, createWUsagePanelIntegration } from "<deployed-path>/panel-integration.mjs";

   const handleWUsage = createWUsagePanelIntegration({
     usageDirectory: "H:\\workbuddy\\runtime\\devspace-usage",
   });

   // Each request after URL parsing:
   if (await handleWUsage(req, res, url)) return;

   // Existing GET / handler: preserve the panel and add one idempotent entry.
   const homeHtml = addUsageMonitorLink(readFileSync(existingPanelHtmlPath, "utf8"));
   ```

6. 直接重启现有 8787 进程后，只调用一次既有 `/api/restart` 切换 7676；不得运行完整登录启动脚本或改变 tunnel。确认只有一个 7676 和一个 8787 listener、`/api/usage/health` 的范围与缓存状态正确、`/usage` 不出现正文/路径/访问密钥/原始 session。

   DevSpace 的公开 `/healthz` 只返回 `ok/name`。详细用量健康位于 `/usage-healthz`，要求运行目录内 `usage-health.token` 文件的本地 Bearer；8787 集成层自动读取该文件，因此不要把它放进 URL、HTML、日志或 Git。缺失 token 时页面健康状态显示 `UNKNOWN`，不会降级为公开直读。

回滚时恢复原 panel 与 dist 并走同一受支持重启流程；新 usage 数据库保留但停止写入，不删除任何 WorkBuddy 数据。

## API

- `GET /api/usage/health`
- `GET /api/usage/snapshot?range=today|7d|30d|all|custom&from=YYYY-MM-DD&to=YYYY-MM-DD&calls_limit=50&interval=15m|30m|1h|4h`
- `GET /api/usage/overview?range=today|7d|30d|all|custom&from=YYYY-MM-DD&to=YYYY-MM-DD&interval=15m|30m|1h|4h`
- `GET /api/usage/calls?range=...&limit=1..100&cursor=<opaque-base64url>`

所有端点只接受 `GET`，为 `Cache-Control: no-store`，且响应固定标记 `metric_scope: "MCP_MODEL_VISIBLE_PAYLOAD_ESTIMATE"`。`by_session` 只覆盖仍保留的 90 天调用明细；长期日聚合不保留会话维度。

`interval` 是可选参数；省略时响应保持原契约。指定后，overview 增加 `interval`、`interval_scope: "RETAINED_CALLS_ONLY"`、`available_from` 和 `by_interval`。周期上限依次为 7、14、30、90 天；超过上限固定返回 `400 interval_range_too_large`，不支持的值固定返回 `400 unsupported_interval`。桶按 `Asia/Hong_Kong` 自然边界对齐，只从 `usage_calls` 明细聚合。连续覆盖内的空桶为精确零；覆盖起点前或完整覆盖缺口为 `UNKNOWN`，部分重叠与未完成当前桶为 `PARTIAL`。

健康面只公开固定故障类别及计数：worker 启动、worker 退出、协议、编码、超时、熔断、积压和关停不完整；不包含异常正文。页面同时显示最后一次 Token 成功时间、队列字节与最老排队年龄。连续失败触发熔断时，已排队项目会快速终结为明确的 `TOKENIZER_CIRCUIT_OPEN`，而不是无提示地保持 `PENDING`。

`UsageTelemetrySink` 是默认未配置、默认不导出的依赖注入接口，只接收工具名、结果、耗时、Token 覆盖状态以及通过格式校验的 `traceparent`/有界 `tracestate`。它不接收正文、路径、原始 session、凭据或 baggage；本实现未安装 exporter，也不会产生网络外发。

## 供应链与完整性

- `tiktoken==0.14.0`，官方上游 revision `4e71bbe0c078468e00fefbf94b39849389f346e5`。
- `o200k_base.tiktoken` 预热缓存 SHA-256 必须为 `446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d`。
- worker 启动时会校验 Python 包版本、缓存存在性与上述哈希；成功计数才会将 SQLite 的缓存状态置为 `VERIFIED`。
