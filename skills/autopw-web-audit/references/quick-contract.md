# AutoPW Quick Contract

## 1. 职责边界

Agent 负责理解源码和业务风险、设计测试用例、生成冻结计划，以及解释最终结果。

Core 负责 Schema 校验、调度、replay、MCP gate、artifact 校验和 final validation。

不要在 Agent 中重新实现 Router、Orchestrator、重放状态机或 Validator 的规则。

## 2. 范围模式

- `FULL`：审查请求覆盖的完整应用或仓库。
- `COMMIT_TO_WORKTREE`：审查 baseline 到当前工作区的差异。
- `COMMIT_TO_COMMIT`：审查两个完整 commit SHA 之间的差异。

增量模式必须先冻结 `change-scope.md`，不得把范围外旧问题混入结果。

## 3. 必须产物

每次审查使用独立的 `<audit-root>`，并按需生成：

- 增量模式：`change-scope.md`
- `test-plan.md`
- `execution-plan.json`
- `runs/<run-id>/`
- `report.md`
- `validation.json`

开始执行前先运行 `autopw-preflight.mjs`，读取其 `preflight.json`，再决定服务和浏览器执行器。

## 4. 状态与 Router action

终态只有：`PASS`、`FAIL`、`BLOCKED`、`NOT_RUN`、`FLAKY`。

Router action 只有：`DONE`、`REPLAY_ONCE`、`START_MCP`、`INVALID_RESULT`。

浏览器首次 `FAIL` 且证据不完整时只允许清洁 replay 一次。replay 通过，或失败 signature 发生变化，终态为 `FLAKY`。相同 `FAIL`、证据仍不完整且冻结的 trigger 匹配时，才允许 `START_MCP`。

## 5. Agent 禁止事项

- 不修改冻结断言或静默替换审查范围。
- 不绕过 Router 直接调 MCP。
- 不伪造、手工拼接或引用 run root 外的 evidence。
- 不自行修改最终状态或把 `FLAKY` 当成 `PASS`。
- 不把静态怀疑写成运行时缺陷。

## 6. 常用命令

```bash
node <skill-dir>/scripts/autopw-preflight.mjs --root <target-repo> --output <audit-root>/preflight.json
node <skill-dir>/scripts/autopw-run.mjs --plan <audit-root>/execution-plan.json --run-root <audit-root>/runs/<run-id> --executor-module <audit-root>/executors.mjs --output <audit-root>/run-summary.json
node <skill-dir>/scripts/autopw-validate.mjs --plan <audit-root>/execution-plan.json --run-root <audit-root>/runs/<run-id> --report <audit-root>/report.md --output <audit-root>/validation.json
```

## 7. 详细文档按需读取

- 增量范围：`commit-range-review.md`
- 执行器、浏览器和 evidence：`execution-and-evidence.md`
- 调度、checkpoint 或 replay：`deterministic-orchestration.md`
- Router 授权 MCP 后：读取同级 `autopw-browser-diagnostics` Skill
- Validator 报具体 Schema 或 artifact 错误：只读取对应 Schema 或实现文件
