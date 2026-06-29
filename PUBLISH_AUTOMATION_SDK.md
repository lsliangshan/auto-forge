对，`@auto-forge/automation-sdk` 现在只是仓库里的 workspace 包，还没有发布到 npm。所以第三方用户不在当前仓库内开发时，不能直接：

```bash
npm install @auto-forge/automation-sdk
```

目前有 4 种可行方式，推荐顺序如下。

**方案 1：发布到 npm，最正式**

这是第三方生态最合理的方式。

准备 SDK 包：

```bash
cd /Users/liangshan/Downloads/workspace/workspace_qisi/auto-forge
npm run build:sdk
npm pack --dry-run -w @auto-forge/automation-sdk
```

确认包内容没问题后发布：

```bash
npm publish -w @auto-forge/automation-sdk --access public
```

发布后第三方用户就可以：

```bash
npm install @auto-forge/automation-sdk
```

如果暂时不想公开，可以发布到私有 npm registry，例如 Verdaccio、GitHub Packages、公司私有 npm 源。

**方案 2：用 npm tarball 分发，适合早期内测**

在 AutoForge 仓库里打包：

```bash
npm run build:sdk
npm pack -w @auto-forge/automation-sdk
```

会生成类似：

```txt
auto-forge-automation-sdk-0.1.0.tgz
```

第三方用户拿到这个文件后：

```bash
npm install ./auto-forge-automation-sdk-0.1.0.tgz
```

然后正常写：

```ts
import { defineTool } from "@auto-forge/automation-sdk";
```

这个方式适合没有发布 npm 前的小范围试用。

**方案 3：用 Git 地址安装，适合未发布但有远程仓库**

如果 SDK 还在 AutoForge 主仓库里，可以这样装：

```bash
npm install git+https://your-git-host/your-org/auto-forge.git
```

但注意：npm 从 monorepo 子包安装体验不如正式发布稳定。更好的做法是把 `packages/automation-sdk` 单独拆成一个 SDK 仓库，然后第三方安装：

```bash
npm install git+https://your-git-host/your-org/automation-sdk.git
```

**方案 4：临时复制类型文件，不推荐**

可以把 SDK 的 `dist/index.d.ts` 和 `dist/index.js` 放进第三方项目，但这会导致版本不可控，后续升级很麻烦。只适合极短期验证。

我的建议是：

- 内测阶段：用 `npm pack` 生成 `.tgz` 分发。
- 有 2 个以上第三方工具要接入时：发布到 npm 或私有 npm registry。
- 长期：把 SDK 当作独立包维护，使用语义化版本，例如 `0.1.x`、`0.2.x`、`1.0.0`，并在 AutoForge 桌面端记录兼容的 SDK 版本范围。

第三方用户真正的起步命令应该是下面这样，而不是依赖本地路径：

```bash
mkdir my-auto-forge-tool
cd my-auto-forge-tool
npm init -y
npm install ./auto-forge-automation-sdk-0.1.0.tgz
npm install -D typescript
```

等 SDK 发布后再切换成：

```bash
npm install @auto-forge/automation-sdk
```
