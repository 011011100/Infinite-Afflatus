# 开发与验证

## 开发环境

- Node.js 24，最低 24.14.0；仓库的 `.node-version` 与初始化开发环境一致。
- pnpm 11.1.3；版本固定在 `package.json` 的 `packageManager` 字段。
- FFmpeg/FFprobe 可选，当前空画布不依赖它们。

```bash
pnpm install
pnpm dev
```

一次 `pnpm dev` 同时管理 Electron 构建、渲染开发服务器和桌面窗口。渲染服务器绑定 `127.0.0.1:5173`，固定端口；如端口被占用，先确认是否已有本项目在运行，不通过悄悄换端口重复启动。

Electron 44 改为按需下载运行时，而 electron-vite 5 启动时直接读取运行时路径。因此 `dev` 和 `start` 都先调用依赖自带的 `install-electron`；已安装时它会直接退出，首次使用时需要网络。仅做类型检查和构建的 CI 不下载桌面运行时。

页面改动由 HMR 更新。需要重启主进程时先结束原开发进程，避免多个窗口使用不同代码。

## 目录

```text
src/
  main/                 Electron 主进程
  preload/              受限桌面能力桥接
  renderer/
    index.html          本地页面入口和 CSP
    src/
      components/ui/    共用 shadcn/ui 组件
      components/canvas/ 画布业务组件
      lib/              界面工具函数
      styles.css        Tailwind 入口与主题变量
  shared/               跨进程接口类型
scripts/                开发辅助脚本
docs/                   产品、交互、架构和实施计划
out/                    构建产物，不提交
```

不要为了未来可能用到的功能预建大量空目录。出现明确的功能边界后再拆分模块。

UI 组件与样式遵循 [UI 基础与组件约定](ui-foundation.md)。`@/` 只映射到渲染界面的 `src/renderer/src/`；Electron 主进程不使用这个别名。

## 常用检查

```bash
pnpm check
pnpm build
pnpm doctor:media
```

`check` 检查代码规范、导入顺序、格式和 TypeScript 类型。`build` 构建主进程、preload、renderer 三部分。

`pnpm start` 打开已经构建的桌面应用，不等同于生成安装包。当前没有安装包签名、自动更新或跨平台发布命令。

需要指定媒体工具位置时，设置进程环境变量 `FFMPEG_PATH` 和 `FFPROBE_PATH`，值为可执行文件完整路径，不包含参数。检测脚本直接读取环境变量，不自动加载 `.env`。

```bash
FFMPEG_PATH=/path/to/ffmpeg FFPROBE_PATH=/path/to/ffprobe pnpm doctor:media
```

依赖构建仅允许 Electron 和 esbuild，配置位于 `pnpm-workspace.yaml`。Electron 运行时仍由启动命令显式安装。新增具有安装脚本的依赖前检查其必要性。

## 桌面冒烟检查

初始化阶段应至少检查：

1. 应用成功打开，显示中文空画布而非白屏。
2. 放大／缩小和拖动画布可操作。
   - 缩放达到边界后，对应按钮禁用；反向缩放后恢复。
   - 悬停和键盘聚焦时显示中文提示，Tab 焦点可见，Enter／Space 可以操作按钮。
3. preload 正常加载，应用信息 IPC 可以返回，不出现桌面连接错误。
4. 生产构建入口可以加载本地文件，不依赖开发服务器。
5. 关闭应用能够退出相应进程；macOS 保留应用并允许重新打开窗口的行为遵循系统约定。

上述检查只验证工程基础。视频拼接、预览流畅性、FFmpeg 输出、真实云端生成和 Windows 安装包必须各自验证。

## 提交约定

- 提交前检查 `git diff --check`、`pnpm check`、`pnpm build`。
- CI 使用 `pnpm install --frozen-lockfile`，依赖调整时同步提交 lockfile。
- 产品行为发生变化时同步更新相应文档，尤其区分「已确认」「建议」「已实现」。
- 不提交个人环境配置、密钥、私有媒体、数据库或 `out/`。
- 不在仓库为空或暂无自动化测试时，把「没有失败」写成完整测试通过。
- 按用户约定，完成修改后提交并推送到当前工作分支。
