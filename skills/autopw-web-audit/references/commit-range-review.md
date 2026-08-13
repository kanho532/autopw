# Commit and workspace delta review

Use this reference when the audit targets changes since a commit, between two refs, or only from a baseline commit to the current workspace.

## Resolve the change set

```bash
git rev-parse --verify <baseline>^{commit}
git diff --find-renames --find-copies <baseline> --
git diff --find-renames --find-copies --name-status <baseline> --
git diff --stat <baseline> --
git status --short --untracked-files=all
```

`git diff <baseline> --` compares the baseline tree with the current tracked workspace, so it includes committed changes after the baseline plus staged and unstaged tracked changes. It does not include untracked files. Always pair it with `git status --short --untracked-files=all`; treat each relevant untracked source, configuration, migration, or test file as a whole-file addition.

Confirm named refs with `git rev-parse --verify` or `git log --oneline --all` before drawing conclusions. Resolve and record the full SHA. For shallow history or an unavailable ref, stop the scoped review and report the missing baseline instead of falling back to a full audit.

Do not silently replace the requested baseline with a merge base. If it is not an ancestor of `HEAD`, disclose that fact and still compare the requested commit tree to the workspace unless the user chooses another baseline.

## Freeze the scope

Before writing the test plan, create `autopw-output/change-scope.md` containing:

- scope mode `COMMIT_TO_WORKTREE`;
- requested baseline and resolved full SHA;
- current `HEAD` SHA;
- exact status snapshot;
- tracked changed, deleted, copied, and renamed paths;
- relevant untracked paths;
- generated, vendored, binary, or user-excluded paths not reviewed line by line;
- directly affected features and dependencies allowed as contextual reads.

After freezing this file, do not broaden the review because unrelated defects or old reports are discoverable in the repository.

## Review efficiently

- Review source, configuration, migrations, and tests deeply.
- Do not review generated output or lockfiles line by line.
- For lockfiles, inspect package-manager integrity, unexpected registries, install scripts, and dependency-tree errors.
- Map changed backend contracts to frontend consumers and changed UI behavior to API or persistence assertions.
- Attribute every planned regression case to a changed file, affected feature, or adjacent risk.
- Read unchanged callers, callees, schemas, routes, and tests only as necessary to interpret an in-scope change.
- Anchor every finding to an in-scope hunk or whole untracked file. An unchanged location may be supporting evidence, but cannot by itself justify an in-scope finding.
- Limit runtime verification to changed features and their direct regression paths. Do not turn a commit-to-worktree request into full-site dogfooding.

An empty review is valid only after checking the resolved baseline diff, full status including untracked files, generated files, and requested refs.

## Other range forms

For committed-only comparisons, use the explicit form the user requested:

```bash
git diff <commit> HEAD
git diff <base> <head>
```

Do not mix committed-only range results with workspace changes unless the selected scope mode is `COMMIT_TO_WORKTREE`.
