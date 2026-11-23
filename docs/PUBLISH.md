# 上架流程（照这个走）

## 已经做好的

| 东西 | 位置 |
| --- | --- |
| npm 包 tarball | `D:\dsh5\dsh-task-cost\dsh-task-cost-0.1.0.tgz`（17.6 KB，11 个文件） |
| 干净目录安装验证 | 装进空目录 → 文件齐、`import` 成功、`exports: apply,inject,name` |
| package.json 元数据 | 已删 `private`，补 license/author/repository/homepage/bugs/keywords/engines/publishConfig |
| 市场条目 YAML | `D:\dsh5\dsh-task-cost\docs\awesome-entry.yml` |

## 还差的两步（都需要你的账号）

### 1. 建仓库并推代码

```bash
# 在 GitHub 上新建 public 仓库 GYCgy/dsh-task-cost（不要勾 README）
cd /d/dsh5/dsh-task-cost
git init -b main
git add -A
git commit -m "dsh-task-cost 0.1.0: task cost panel with budget-aware estimates"
git remote add origin https://github.com/GYCgy/dsh-task-cost.git
git push -u origin main
```

建好后去仓库 **About → Topics** 加 `dsh-plugin`（收录要求）。

> 注意：仓库创建要**满 1 天**才能提 PR，CI 会自动卡这一条。今天建、明天提就行。

### 2.（可选但推荐）发 npm 包

```bash
PNPM="C:/Users/GYCgy/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
EXE="C:/Users/GYCgy/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe"

# 先登录一次（会写 ~/.npmrc，之后 publish 不用再输）
"$EXE" "$PNPM" login

cd /d/dsh5/dsh-task-cost
"$EXE" "$PNPM" publish --no-git-checks --access public
```

发 npm 的好处：别人装的时候跳过构建授权步骤（市场里显示「预构建安装」）。

不发 npm 也行——那就把 `dsh-task-cost-0.1.0.tgz` 传到 GitHub Release，
然后在条目的 YAML 里加一行：

```yaml
tarball: https://github.com/GYCgy/dsh-task-cost/releases/latest/download/dsh-task-cost.tgz
```

⚠️ 资产名别带版本号，否则下次发版这个链接就 404。

### 3. 提 PR

市场列表的数据在 `data/plugins/`，一个插件一个文件，**不手改 README**。

```bash
# 1) fork 后克隆
git clone https://github.com/<你的GitHub账号>/awesome-dsh-plugin.git
cd awesome-dsh-plugin

# 2) 拷条目（文件名必须是 owner__repo.yml）
cp /d/dsh5/dsh-task-cost/docs/awesome-entry.yml data/plugins/GYCgy__dsh-task-cost.yml

# 3) 提 PR
git checkout -b add-dsh-task-cost
git add data/plugins/GYCgy__dsh-task-cost.yml
git commit -m "Add GYCgy/dsh-task-cost"
git push -u origin add-dsh-task-cost
```

然后在 GitHub 上开 PR 到 `awesome-dsh-plugin/awesome-dsh-plugin:main`。

## 收录要求对照（我们是否满足）

| 要求 | 状态 |
| --- | --- |
| 仓库声明 `dsh.bundle` manifest | ✅ `dsh.bundle.patch: ./cordis.patch.yml` |
| 仓库根有 `cordis.patch.yml` | ✅ |
| 有真实可用的代码 | ✅ index.js 674 行 + client.js 500 行，本机跑通 |
| 仓库满 1 天 | ⏳ 建库后等一天 |
| 加 `dsh-plugin` topic | ⏳ 建库后加 |
| 描述属实、不带营销词 | ✅ 条目里只写了实际有的功能 |
| 分类贴合 | ✅ `usage`（花费/用量） |

## 关于「奖励」

查过：DSH 官方没有插件上架奖励计划；市场（dshmarket）只是索引，
README 里只有赞助商位，并写明「收录 ≠ 背书」。所以上架能拿到的是曝光和 star，不是钱。
