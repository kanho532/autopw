# AutoPW

AutoPW 是一个代码驱动的 Web 应用审查插件：先读取源码并冻结风险测试计划，再并行执行 API 与 Playwright Test，使用确定性规则仅在浏览器失败证据不足时启动 Playwright MCP 诊断，并通过日志、状态回读和静态检查补充证据，最后生成带每次测试耗时的固定格式中文报告。

核心边界固定为：`Plan` 表达测试意图，`Result` 保存执行事实，`Decision` 只决定下一步动作，`Report` 负责解释结果。Agent 负责理解业务、设计用例与判定根因；`autopw-run.mjs`、Router 和 Validator 负责执行纪律。

支持三种审查范围：完整审查 `FULL`、指定 commit 到当前工作区的 `COMMIT_TO_WORKTREE`，以及两个已提交 SHA 之间的 `COMMIT_TO_COMMIT`。两种增量模式均只测试受影响功能及其直接回归路径，且不会相互混入工作区语义。

## 运行要求

- Node.js 18 或更高版本。
- `npx` 可用；首次启动 `autopw-playwright` 时需要从 npm 获取固定版本 `@playwright/mcp@0.0.79`。
- 只测试你有权审查的本地或可信测试环境。

## 支持的宿主

本仓库是单一源码的通用发行版，同时包含以下入口：

- Codex：`.codex-plugin/plugin.json`
- Claude Code：`.claude-plugin/plugin.json`
- CodeBuddy：`.codebuddy-plugin/plugin.json`
- WorkBuddy：`.workbuddy-plugin/plugin.json`
- 其他支持 Agent Skills 与 MCP 的工具：`skills/` 与 `.mcp.json`

四个入口共用同一个 `skills/` 和 `.mcp.json`，不要复制并单独修改技能内容。

## 本地加载

### Codex

通过已配置的 Codex 本地 marketplace 安装或更新本目录中的 `autopw`。安装后新建任务，使新技能和插件内置 MCP 工具进入任务上下文。

### Claude Code

```bash
claude --plugin-dir /absolute/path/to/autopw
```

加载后可使用 `/autopw:autopw-web-audit`、`/autopw:autopw-exploratory-testing` 和 `/autopw:autopw-browser-diagnostics`。修改插件后运行 `/reload-plugins`。

### CodeBuddy

```bash
codebuddy --plugin-dir /absolute/path/to/autopw
```

修改插件后运行 `/reload-plugins`。CodeBuddy 也兼容仓库中的 Claude Code 清单，但保留 `.codebuddy-plugin/plugin.json` 便于明确识别。

### WorkBuddy

WorkBuddy 当前按 Skills 与 MCP 两部分接入：

1. 将 `skills/` 下的三个技能目录导入或复制到工作区的 `.codebuddy/skills/`。
2. 将 `.mcp.json` 中的 `autopw-playwright` 配置合并到项目级 `.workbuddy/mcp.json` 或用户级 `~/.workbuddy/mcp.json`。
3. 重新打开任务，并确认 MCP 工具列表中出现 `autopw-playwright` 的 `browser_*` 工具。

`.workbuddy-plugin/plugin.json` 是为识别 Claude Code 兼容插件清单的 CodeBuddy/WorkBuddy 系宿主保留的兼容入口；不能自动加载插件目录的 WorkBuddy 版本仍需执行上面的分步安装。

### 其他工具

将三个技能目录安装到宿主支持的 Agent Skills 目录，并把 `.mcp.json` 中 `mcpServers.autopw-playwright` 合并到该宿主的 MCP 配置。若宿主不支持插件自动启动 MCP，这两步必须分别完成。

## Playwright 执行边界

浏览器用例默认使用 Playwright Test。AutoPW 先复用能够精确覆盖冻结用例的现有测试，只为覆盖缺口生成本次运行专属 `.spec.*`，并通过一次 runner 调用批量执行。项目没有 Playwright Test 时，使用工作区外、本次运行专属且版本固定的临时工具目录，不修改目标项目依赖或 lockfile。

插件内置的 Playwright MCP 只用于定向诊断，不参与初始执行。Playwright Test 首次失败且证据不足时总是清洁重放一次；即使同一业务不变量出现 API 通过、浏览器失败，也不能跳过重放。重放通过或失败特征变化时标记为疑似 flaky；只有相同失败再次出现、证据仍不足，且冻结的 MCP 触发条件与实际原因精确匹配时，确定性路由器才允许启动 MCP。

报告必须分别记录浏览器执行器、测试运行器和回退通道，不得把内置浏览器或其他自动化工具笼统写成 Playwright。

## 多 Agent 与确定性路由

宿主支持子 agent 时，主协调器在计划冻结后并行派发独立的 API 和 Playwright Test 工作器，并继续静态审查。工作器只写各自的 `autopw-output/runs/<run-id>/<lane>/`；范围、计划、问题编号、定级和最终报告始终由主协调器单写。宿主不支持子 agent 时，使用相同结构化协议退化为隔离进程或串行执行。

`skills/autopw-web-audit/scripts/autopw-run.mjs` 读取冻结计划并调用统一的 `executeCase(testCase, context)` 执行器接口，按依赖和资源锁调度用例、自动完成一次清洁重放，并保存 lane 与 Router 制品。Router 只输出 `DONE`、`REPLAY_ONCE`、`START_MCP` 或 `INVALID_RESULT`；终态单独使用 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN` 或 `FLAKY`。失败特征与重放执行上下文均以可读字段逐项保存和比较。

服务通过 run 专属的 `runtime.spawn()` 启动：Windows `.cmd/.bat` 自动适配，PID 与命令写入进程账本，并在正常或异常退出时清理进程树。Checkpoint 支持同一冻结计划与执行器的 `--resume`，避免从头重跑已完成用例。MCP 证据通过 staging 导入器复制进 run root 并记录 SHA-256 清单。

## 测试时间记录

每次审查在 `audit-session.json` 记录完整墙钟时间、每次调用、恢复间隔、启动、首次执行、清洁重放、MCP、制品与清理阶段；通道、用例和尝试继续分别记录计时。Playwright Test reporter 同时区分断言、定位器和真正的超时，避免错误触发重放或 MCP。

## 最终输出验证

`skills/autopw-web-audit/scripts/autopw-validate.mjs` 是审查交付前的确定性验收门。JSON Schema 由 AJV 在运行时执行，Validator 只补充跨制品语义检查：冻结计划、lane 归属、浏览器路由、MCP 授权闭环、证据文件、计时、报告引用和五种终态计数。结果为 `valid: true` 时才允许交付报告。

## Commit 到工作区增量审查

示例请求：

```text
只审查 commit 1a2b3c4 到当前工作区的改动，生成测试方案并执行相关验证。
```

AutoPW 会解析基线 SHA，使用 `git diff <baseline> --` 获取 tracked workspace 差异，再结合 `git status --short --untracked-files=all` 纳入未跟踪文件，并将冻结范围写入 `autopw-output/change-scope.md`。未变化且与变更无直接依赖的功能不进入问题清单或测试矩阵。

## 开发校验

安装依赖并运行确定性路由器、Orchestrator、最终输出验证器和 Playwright Test reporter 测试：

```bash
npm ci
npm test
```

发布前还应运行 Skill 与插件验证器，并在不包含目标项目依赖修改的真实 Web 应用上执行一次前向测试。
