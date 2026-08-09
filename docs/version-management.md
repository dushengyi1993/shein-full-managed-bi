# 版本与分支管理

## 唯一主线

- `main` 是唯一长期分支，也是创建 release 和生产部署的唯一源码主线。
- release tag 指向的提交必须已经可以从远端 `main` 到达；禁止先从功能分支打 tag、部署，事后再补主线。
- release tag 和 `archive/*` tag 都是不可变审计锚点，不删除、不移动、不复用名称。
- 生产仍按精确 Git 提交安装到不可变 release 目录；分支名不作为生产版本号。

## 功能分支与 worktree 生命周期

1. 从最新 `origin/main` 创建临时分支，命名为 `codex/<scope>-YYYYMMDD`。
2. 一个分支只服务一个明确任务；有并行实现需求时才创建额外 worktree。
3. 测试通过后提交、推送、创建 PR；PR 合并后再创建 release tag。
4. GitHub 已启用 `delete_branch_on_merge=true`；PR 合并后远端功能分支自动删除，本地分支在精确回读后立即删除。
5. worktree 必须先确认干净，再用 `git worktree remove <path>` 注销；禁止直接在资源管理器里删除。
6. 未合并分支默认不能删除。确认不应进入主线但必须保留审计时，先创建并推送 `archive/<name>-<date>` annotated tag，再删除分支。

## 发布门禁

发布前执行：

```bash
git fetch origin main --tags
npm run check:version-lineage -- --release-ref=HEAD --main-ref=origin/main
```

只有返回 `ok: true`，且目标提交、release tag 和生产 release 目录使用同一 SHA 时，才允许继续部署。CI 会在 `main` 和日期格式 release tag 的 push 上复核相同血缘。

## 本地删除保护

每个 clone 首次使用时执行：

```bash
npm run hooks:install
```

安装脚本同时启用本地 `fetch.prune=true`，避免已删除的远端跟踪分支长期残留。版本库内的 `pre-push` 门禁会拒绝：

- 删除或非 fast-forward 更新 `main`；
- 删除 release tag 或 `archive/*` tag；
- 推送尚未进入 `main` 的 release tag；
- 删除既未进入 `main`、也没有远端 archive tag 保全的分支。

当前 GitHub 私有仓库套餐不提供 ruleset/branch protection，因此本地 hook、CI 和发布前门禁必须同时保留。若以后升级 GitHub 套餐，应再启用：`main` 禁止删除/强推、必须经 PR、必须通过 `ci` 与版本血缘检查。

## 2026-08-09 收口记录

- `main` 已 fast-forward 到 release `2026.08.09.2` 的提交 `5edbc2be62cb7b0ca98ebddaced76714d732def6`。
- 旧 `codex/full-managed-bi-v1` 的五个独有提交由 `archive/full-managed-bi-v1-20260809` 保全；其余旧功能分支均已进入 `main`。
- 收口后 GitHub 与本地长期分支均只保留 `main`；任务分支按上述生命周期创建并及时删除。
