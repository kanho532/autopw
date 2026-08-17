# 确定性多 Agent 编排

## 目录

1. [不变量](#1-不变量)
2. [执行计划](#2-执行计划)
3. [工作器](#3-工作器)
4. [Playwright Test 选择](#4-playwright-test-选择)
5. [计时](#5-计时)
6. [失败证据](#6-失败证据)
7. [清洁重放](#7-清洁重放)
8. [MCP 门禁](#8-mcp-门禁)
9. [制品与合并](#9-制品与合并)
10. [降级](#10-降级)

## 1. 不变量

- 由主协调器唯一写入 `change-scope.md`、`test-plan.md`、`execution-plan.json` 和 `report.md`。
- 在执行前冻结范围、用例、断言、依赖、资源锁、证据契约、执行器和 MCP 触发条件。
- 将 `API` 作为直接请求证据通道，将 `PLAYWRIGHT_TEST` 作为浏览器用例默认执行器。
- 默认完全不启动 Playwright MCP。只有路由脚本输出 `START_MCP` 时才允许启动一个定向诊断工作器。
- 不使用哈希表示失败。直接保存并逐字段比较可读的 `failure_signature`。
- 每个用例和每次尝试记录 ISO 8601 的开始、结束时间以及 `duration_ms`。
- 每个工作器只写自己的运行目录并返回结构化结果，不直接定级、编号或扩展范围。
- 最终报告必须通过 `autopw-validate.mjs` 的整体验收后才能交付。

## 2. 执行计划

主协调器同时生成面向人的 `test-plan.md` 和面向机器的 `execution-plan.json`。后者遵循
[execution-plan.schema.json](execution-plan.schema.json)。每个用例至少包含：

- `id`；
- `channel`: `API`、`BROWSER`、`STATIC` 或 `LOG_STATE`；
- `executor`: `DIRECT_API`、`PLAYWRIGHT_TEST`、`STATIC` 或 `LOG_STATE`；
- 来源、前置条件、步骤和断言；
- 证据契约；
- 依赖和资源锁；
- 是否修改状态以及清理责任；
- `mcp_trigger`。

浏览器用例一律先冻结为 `PLAYWRIGHT_TEST`。不得因页面复杂、定位器未知或 MCP 可用而预先改为 MCP。

## 3. 工作器

宿主支持子 agent 时，在计划冻结后并行派发两个有界任务：

1. `API` 工作器：执行直接请求、鉴权边界和权威状态回读；
2. `PLAYWRIGHT_TEST` 工作器：发现或创建 runner，映射 spec，执行浏览器用例并收集事件证据。

主协调器继续执行静态审查。日志和状态观察可以并入 API 工作器；只有资源完全隔离且并发槽充足时才单独派发。工作器输入必须列出允许执行的用例 ID、制品目录、资源锁、数据前缀和清理责任。

资源锁使用可读名称，例如：

```text
account:user-a
record:diary:autopw-20260817-001
browser_context
storage_state:user-a
service_config
port:8080
```

同一资源锁上的修改操作不得并发。

## 4. Playwright Test 选择

按以下顺序发现 runner：

1. 项目包装器或明确的测试命令；
2. `package.json` 中的 Playwright Test script；
3. `playwright.config.*` 和项目内 `@playwright/test`；
4. 工作区或用户工具目录中的现有 Playwright Test；
5. 工作区外、本次运行专属且版本固定的临时工具目录。

不得修改目标项目的依赖或 lockfile。只有现有测试同时覆盖相同角色、前置数据、步骤和冻结断言，且可以精确选择运行时，才标记为复用。其他覆盖缺口写入本次运行专属 spec。

每个冻结浏览器用例必须映射到一个包含用例 ID 的 `test()`。执行前运行 `playwright test --list`，验证没有漏项、重复 ID 或范围外测试。相关流程通过一次 runner 调用批量执行。将冻结的浏览器 ID 原样写入路由输入的 `expected_case_ids`；路由器会再次校验实际结果不缺、不重、不多。runner 退出码为 0 但结果为空仍是无效执行，不能标记通过。

配置 `scripts/autopw-playwright-reporter.cjs` 记录每个测试的开始、结束和耗时。导航前注册 `console`、`pageerror`、`requestfailed` 和相关响应监听器。

## 5. 计时

所有时间使用 ISO 8601。允许使用 UTC `Z` 或带偏移的时间，但同一运行保持一致。每项结果必须包含：

```json
{
  "timing": {
    "started_at": "2026-08-17T03:20:10.000Z",
    "finished_at": "2026-08-17T03:20:11.250Z",
    "duration_ms": 1250
  }
}
```

浏览器尝试还必须直接写出可读的 `execution_context`：runner 与版本、浏览器与 build、viewport、locale、timezone、spec 路径、测试标题、storage-state 契约、步骤、断言和 locator 契约；另写本次 `isolation_id`。不使用哈希或摘要代替这些字段。

开始、结束与持续时间的误差不得超过 1000 毫秒。Playwright reporter 将每个 `test()` 的计时写入 `autopw-playwright-timings.json`。API 工作器为每个请求用例记录同样字段。主协调器在报告中汇总每个通道和每个用例的耗时，不用发现数量代替用例数量。

## 6. 失败证据

使用 [lane-result.schema.json](lane-result.schema.json) 返回结果。失败类型和最小证据：

| 类型 | 最小证据 |
|---|---|
| `ASSERTION` | 预期、实际、错误、最终 URL、DOM 状态、trace |
| `LOCATOR` | locator、最终 URL、DOM 状态、截图、trace |
| `REQUEST_FAILED` | 方法、URL、状态码或网络错误、trace |
| `PAGE_ERROR` | 错误、堆栈、trace |
| `NAVIGATION` | 起始/最终 URL、状态或重定向链、trace |
| `TIMEOUT` | 等待条件、最终 URL、DOM 状态、待定/失败请求、trace |
| `INFRASTRUCTURE` | 健康检查、命令、退出码或端口状态 |

失败签名直接包含以下字段：

```json
{
  "case_id": "BROWSER-003",
  "failure_type": "LOCATOR",
  "route": "/diaries",
  "assertion": "日记标题可见",
  "locator": "getByRole('link', { name: '测试日记' })",
  "http_method": null,
  "http_status": null,
  "top_stack_frame": "generated/diary.spec.ts:42"
}
```

比较时规范空白并逐字段比较。不要比较时间戳、临时目录、随机数据 ID、动态端口或证据文件名。

## 7. 清洁重放

首次 Playwright Test `FAIL` 且证据不完整时，路由器总是输出 `REPLAY_ONCE`；API/浏览器不一致也不得绕过这一步。只允许清洁重放一次，并满足：

- 同一用例、断言、runner、浏览器、viewport、locale 和 timezone；
- 使用新的隔离测试数据；
- 恢复约定的 storage state；
- 不修改 locator、步骤或断言；
- 保留第一次证据。

路由器逐字段比较两次 `execution_context`，并要求 `isolation_id` 不同。任何 runner、browser build、spec、setup、步骤、断言、locator 或 storage-state 契约变化都输出 `INVALID_REPLAY_CONTEXT`，不能被认定为 flaky，也不能启动 MCP。

第二次通过或失败签名变化时输出 `FLAKY_CANDIDATE`，不得启动 MCP。第二次失败证据完整时输出 `DONE_FAIL`。

## 8. MCP 门禁

使用 [router-input.schema.json](router-input.schema.json) 组织路由输入，运行：

```bash
node <skill-dir>/scripts/autopw-router.mjs --input <router-input.json> --output <decisions.json>
```

从本 `SKILL.md` 的位置解析 `<skill-dir>`，不要假设当前工作目录是 Skill 根目录。

输出遵循 [router-decision.schema.json](router-decision.schema.json)。只有以下情况允许 `START_MCP`：

1. 同一业务不变量的 API 用例通过，且 Playwright Test 清洁重放出现相同失败签名、失败证据仍不完整；
2. Playwright Test 清洁重放出现相同失败签名，且证据仍不完整。

计划中必须预先冻结与实际原因精确匹配的 `mcp_trigger`。否则输出 `BLOCKED_DIAGNOSTIC`。基础设施错误、已充分证明的失败、第一次失败、重放后通过或签名变化均不得启动 MCP。

MCP 工作器只回答一个明确诊断问题，默认最多一个会话、12 次有意义操作、5 分钟，并复用一个隔离浏览器上下文。它不得执行完整回归、修改源码、改变断言或直接写报告。

## 9. 制品与合并

建议目录：

```text
autopw-output/runs/<run-id>/
├── api/
├── playwright/
│   ├── generated/
│   ├── result-attempt-1.json
│   ├── result-attempt-2.json
│   ├── autopw-playwright-timings.json
│   ├── traces/
│   └── screenshots/
├── router/decisions.json
└── mcp/
```

主协调器校验结果字段、计时和证据路径后再回填计划。工作器只提交候选问题和候选新增覆盖；主协调器统一分配 `DISCOVERED-<n>` 与问题编号，并按根因去重。

报告完成后运行：

```bash
node <skill-dir>/scripts/autopw-validate.mjs \
  --plan <audit-root>/execution-plan.json \
  --run-root <audit-root>/runs/<run-id> \
  --report <audit-root>/report.md \
  --output <audit-root>/validation.json
```

验证器检查计划 ID、用例覆盖、尝试顺序、通道归属、冻结时间、路由终态、MCP 诊断闭环、证据路径、报告本地链接、用例引用和最终状态计数。`valid: false` 是制品或流程错误，不得通过删除失败用例、改变冻结断言或手工伪造计数绕过。
最终交付使用 `--output` 保存 `validation.json`；只读或中间预检可以省略该参数并从 stdout 读取同一结果。

## 10. 降级

宿主不支持子 agent 时，使用相同 `execution-plan.json` 和路由脚本，将 API 与 Playwright Test 作为隔离进程并行；不能并行时串行执行。无法使用 MCP 时，仅把路由为 `START_MCP` 的用例标记为 `BLOCKED_DIAGNOSTIC`，其他通道继续。确定性来自冻结计划、结构化结果和脚本决策，不依赖宿主工具名称。
