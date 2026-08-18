# 执行与证据通道

在把用例标记为 `BLOCKED` 前，完成与该用例有关的发现和回退步骤。不要因为项目没有声明 Playwright 依赖，就推断机器无法运行浏览器自动化。

## 1. 服务启动发现顺序

按顺序检查并记录结果：

1. 仓库文档、`package.json` scripts、`Makefile`、Compose、IDE/项目配置；
2. 项目包装器：`mvnw.cmd`、`gradlew.bat`、`npm.cmd`、`pnpm`、`yarn` 等；
3. 已有构建产物：可执行 JAR、`target/classes`、`dist/`、二进制文件；
4. `PATH`、环境变量以及已运行且命令行与当前项目匹配的进程；
5. 限定范围内的工具目录：仓库父目录、用户常见工具/缓存目录和任务上下文已经指出的位置。

不要从磁盘根目录进行无界搜索。Windows 上优先调用 `.cmd`/`.exe` 的绝对路径；发现 PATH 只差一个移动后的目录时，使用实际路径并在报告中记录。

## 2. Playwright Test 发现与 MCP 门禁

浏览器用例默认且首先使用 Playwright Test。按顺序检查并记录：

1. 项目包装器或明确的 Playwright Test 命令；
2. `package.json` 中的 Playwright Test script；
3. `playwright.config.*`、项目内 `@playwright/test` 和已安装浏览器；
4. 工作区或用户工具目录中的 Playwright Test、`%LOCALAPPDATA%/ms-playwright`、系统 Chrome/Edge；
5. 工作区外、本次运行专属且版本固定的临时 Playwright Test 工具目录，优先复用已下载浏览器。不得修改目标项目的 `package.json`、lockfile 或虚拟环境；
6. 如果策略、网络或系统条件禁止以上路径，写入结构化 `BLOCKED` 结果，同时继续 API、日志、状态和静态用例。

只有现有测试同时覆盖相同角色、前置数据、步骤和冻结断言，且可以精确选择运行时，才复用该测试。其余浏览器用例写入本次运行专属 `.spec.*`。配置 [../scripts/autopw-playwright-reporter.cjs](../scripts/autopw-playwright-reporter.cjs)，先执行 `playwright test --list` 核对用例 ID 映射，再通过一次 runner 调用批量执行。

Playwright Test 完成后，把冻结浏览器用例 ID 写入 `expected_case_ids`，再使用 [autopw-router.mjs](../scripts/autopw-router.mjs) 检查实际结果覆盖、计时和证据。缺失、重复、范围外或空结果直接无效，不能用 runner 的成功退出码代替用例结果。首次失败且证据不完整时只清洁重放一次；重放通过或失败签名变化时输出 `DONE` 与终态 `FLAKY`。此阶段不要启动或预检 MCP。

只有路由决定为 `START_MCP` 时才发现插件内置 `autopw-playwright` MCP 或宿主浏览器能力。按顺序尝试：

1. 插件内置 `autopw-playwright` MCP；
2. 当前宿主提供的浏览器控制能力；
3. 已安装的浏览器自动化 CLI，例如 `agent-browser`；先读取其核心说明，不猜测命令；
4. 如果以上路径均不可用，将该用例以 `BLOCKED` 和 `DIAGNOSTIC_UNAVAILABLE` 结构化原因收口，不影响其他用例。

不要硬编码某个宿主对 MCP 工具生成的完整名称；按服务器标识 `autopw-playwright` 和 `browser_*` 能力发现工具。每次运行记录：

- 浏览器执行器，例如 `Playwright MCP (@playwright/mcp 0.0.79)`、`Codex In-app Browser` 或 `agent-browser`；
- 测试运行器，例如 `Playwright Test 1.x`，未执行则写“未运行”；
- 回退通道及触发原因。

只有实际调用 Playwright Test 执行测试文件时，才能写“Playwright Test 已运行”。使用 Playwright MCP 可以写“Playwright MCP 浏览器验证已运行”，两者不得合并表述。

同一审查只在首次 `START_MCP` 后执行一次 MCP 预检。相关诊断复用一个隔离页面、登录状态和浏览器上下文，并只在关键检查点采集快照、网络和控制台证据。MCP 不得重跑完整回归。工作器结束后由主协调器校验结果并回填计划；运行时发现以 `DISCOVERED-<n>` 追加，不修改冻结用例的范围或断言。

安装临时依赖或下载新浏览器会产生网络/磁盘变更时，遵守当前环境的权限规则。优先复用已有浏览器，完成后清理一次性运行目录。

## 3. 证据通道选择

| 结论类型 | 最小充分证据 | 是否必须浏览器 |
|---|---|---|
| HTTP 状态、响应契约、匿名/跨用户 API 访问 | 请求与响应；必要时状态回读 | 否 |
| SQL 注入或搜索越界 | API 响应 + 服务端 SQL/状态证据 | 否 |
| 数据是否持久化、role 是否入库 | API/数据库权威回读 | 否 |
| 明文密码或敏感数据写日志 | 服务端日志 | 否 |
| 弱哈希、硬编码密钥、配置未使用 | 源码/配置；标记静态 | 否 |
| 页面提示、导航、空状态、响应式状态 | DOM/URL/截图 + console/network | 是 |
| CORS、cookie、storage、页面上下文请求 | 浏览器上下文/network | 是 |
| HTML 注入是否进入 DOM | DOM 证据 | 是 |
| XSS 是否执行 | 无害页面内标志 + DOM/截图 | 是 |
| 视觉或可访问性问题 | 浏览器渲染、DOM/可访问树、截图 | 是 |

“运行时已验证”并不等于“浏览器已验证”。API、日志或持久化状态同样可以完成运行时验证。报告中写明实际证据通道。

每个通道、用例和尝试记录 ISO 8601 的 `started_at`、`finished_at` 与 `duration_ms`。Playwright Test 使用 AutoPW reporter 自动记录每个 `test()`；API 和其他通道使用相同字段。保留第一次失败和清洁重放各自的时间，不能用第二次结果覆盖第一次。

## 4. 上游故障后的继续策略

核心登录、数据创建或其他上游流程失败时：

1. 先使用原始配置复现并保存故障证据；
2. 继续执行不依赖该流程的 API、静态和前端用例；
3. 如需验证下游功能，仅在本地/测试环境使用可逆、进程级、运行期绕行；
4. 在报告中分别写明原始缺陷、绕行方法、绕行后的发现和清理结果；
5. 不得将绕行后的成功结果用于否定原始缺陷。

## 5. 何时可以判定阻塞

只有同时满足以下条件时，才将单个用例标记为 `BLOCKED`：

- 已尝试所有安全且适用的发现/回退路径；
- 继续执行需要新的权限、凭据、破坏性操作或修改共享/生产环境；
- 其他证据通道不足以证明该用例断言；
- 报告记录了尝试过的命令/路径、失败原因和重新执行所需条件。
