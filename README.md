# AutoPW

AutoPW 是一个代码驱动的 Web 应用审查插件：先读取源码并冻结风险测试计划，再通过 Playwright MCP、API、日志、状态回读和静态检查收集证据，最后生成固定格式的中文报告。

支持两种审查范围：完整审查 `FULL`，以及仅审查指定 commit 到当前工作区变化的 `COMMIT_TO_WORKTREE`。增量模式会覆盖该基线后的已提交、暂存、未暂存和未跟踪文件，并只测试受影响功能及其直接回归路径。

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

插件内置的是 Playwright MCP，用于现场浏览器探索、DOM、Console、网络与截图证据。它不等同于 Playwright Test：当任务要求生成和重复执行 `.spec.ts` 回归测试时，AutoPW 仍优先使用项目已有的 Playwright Test 配置，或创建一次性审查工具目录。

报告必须分别记录浏览器执行器、测试运行器和回退通道，不得把内置浏览器或其他自动化工具笼统写成 Playwright。

## Commit 到工作区增量审查

示例请求：

```text
只审查 commit 1a2b3c4 到当前工作区的改动，生成测试方案并执行相关验证。
```

AutoPW 会解析基线 SHA，使用 `git diff <baseline> --` 获取 tracked workspace 差异，再结合 `git status --short --untracked-files=all` 纳入未跟踪文件，并将冻结范围写入 `autopw-output/change-scope.md`。未变化且与变更无直接依赖的功能不进入问题清单或测试矩阵。
