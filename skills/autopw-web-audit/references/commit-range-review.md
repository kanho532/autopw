# Commit 与工作区差异审查

当审查目标是某次 commit 之后的变更、两个 ref 之间的变更，或仅从基线 commit 到当前工作区的变更时，使用本参考文档。

## 解析变更集

```bash
git rev-parse --verify <baseline>^{commit}
git diff --find-renames --find-copies <baseline> --
git diff --find-renames --find-copies --name-status <baseline> --
git diff --stat <baseline> --
git status --short --untracked-files=all
```

`git diff <baseline> --` 会将基线树与当前已跟踪工作区比较，因此包含基线之后的已提交变更，以及已暂存和未暂存的已跟踪变更。它不包含未跟踪文件。始终配合 `git status --short --untracked-files=all` 使用；将每个相关的未跟踪源码、配置、迁移或测试文件视为新增的完整文件。

得出结论前，使用 `git rev-parse --verify` 或 `git log --oneline --all` 确认具名 ref。解析并记录完整 SHA。对于浅克隆历史或不可用的 ref，停止范围审查并报告基线缺失，不要回退到全量审查。

不要静默将请求的基线替换为 merge base。如果它不是 `HEAD` 的祖先，披露这一事实，并仍然将请求的 commit 树与工作区比较，除非用户选择其他基线。

## 冻结范围

编写测试计划前，创建 `autopw-output/change-scope.md`，其中包含：

- 范围模式 `COMMIT_TO_WORKTREE`；
- 请求的基线和解析后的完整 SHA；
- 当前 `HEAD` SHA；
- 确切的状态快照；
- 已跟踪的修改、删除、复制和重命名路径；
- 相关的未跟踪路径；
- 不逐行审查的生成、供应商、二进制或用户排除路径；
- 允许作为上下文读取的直接受影响功能和依赖；
- 一句话业务意图、判断依据和置信度 `CONFIRMED`、`INFERRED` 或 `UNKNOWN`。

### 最简业务意图识别

此步骤仅用于 `COMMIT_TO_WORKTREE`：

1. 按用户当前请求、commit message、范围内 diff、直接相邻测试或文档的顺序寻找依据，不搜索整个仓库的业务资料。
2. 用一句话说明这些改动试图实现的用户或业务行为，不要只是复述代码修改。
3. 有明确需求依据时标记 `CONFIRMED`；只能从变更推断时标记 `INFERRED`；证据冲突或无法判断时标记 `UNKNOWN`。不得把推断写成已确认需求。
4. 如果不确定性会改变测试预期，冻结测试计划前只询问一个简短问题；否则保留 `INFERRED` 并继续审查。

冻结该文件后，不得因为在仓库中发现无关缺陷或旧报告而扩大审查范围。

## 高效审查

- 深入审查源码、配置、迁移和测试。
- 不要逐行审查生成输出或 lockfile。
- 对于 lockfile，检查包管理器完整性、异常 registry、安装脚本和依赖树错误。
- 将变更的后端契约映射到前端使用方，并将变更的 UI 行为映射到 API 或持久化断言。
- 将每个计划回归用例归因到变更文件、受影响功能或相邻风险。
- 仅在解释范围内变更所必需时，阅读未修改的调用方、被调用方、schema、路由和测试。
- 将每个发现锚定到范围内 hunk 或完整的未跟踪文件。未修改位置可以作为辅助证据，但不能单独证明某项发现属于本次范围。
- 将运行时验证限制在已变更功能及其直接回归路径。不要把 commit 到工作区的请求扩展为全站 dogfooding。

只有检查了解析后的基线 diff、包含未跟踪文件的完整状态、生成文件和请求的 ref 后，空审查结果才有效。

## 其他范围形式

对于仅比较已提交内容的请求，使用用户要求的明确形式：

```bash
git diff <commit> HEAD
git diff <base> <head>
```

除非选择的范围模式为 `COMMIT_TO_WORKTREE`，否则不要把仅提交范围的结果与工作区变更混合。
