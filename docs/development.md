# 开发与验证

## 开发环境

- Node.js 24，最低 24.14.0；仓库的 `.node-version` 与初始化开发环境一致。
- pnpm 11.1.3；版本固定在 `package.json` 的 `packageManager` 字段。
- FFmpeg/FFprobe 可选，当前项目管理、视频导入与浏览器支持编码的预览不依赖它们。

```bash
pnpm install
pnpm dev
```

一次 `pnpm dev` 同时管理 Electron 构建、渲染开发服务器和桌面窗口。渲染服务器绑定 `127.0.0.1:5173`，固定端口；如端口被占用，先确认是否已有本项目在运行，不通过悄悄换端口重复启动。

Electron 44 改为按需下载运行时，而 electron-vite 5 启动时直接读取运行时路径。因此 `dev` 和 `start` 都先调用依赖自带的 `install-electron`；已安装时它会直接退出，首次使用时需要网络。仅做类型检查和构建的 CI 不下载桌面运行时。

页面改动由 HMR 更新。需要重启主进程时先结束原开发进程，避免多个窗口使用不同代码。

新增／更新运行时依赖后，不能只凭热更新或独立回归页通过就交付：完整刷新 Electron 窗口，再从项目首页打开已有项目。开发窗口可能残留旧的预构建模块，与新模块混用导致 `Invalid hook call`／`useRef` 空引用。当前显式去重 React、React DOM 与 GSAP，并将动画依赖纳入首次预构建；修改开发配置需重新启动原开发进程，不另开第二个实例。画布渲染异常由独立边界显示恢复入口，支持返回列表或重新加载，不清理已保存的项目数据。

## 目录

```text
src/
  main/
    desktop/            窗口、受限 IPC、受管素材协议
    projects/           项目与独立项目数据库
    saving/             固定暂存区、持久化保存队列
    migration/          迁移流程、文件清单、精确清理
    storage/            应用数据库、文件安全、写入屏障、组合入口
  preload/              受限桌面能力桥接
  renderer/
    index.html          本地页面入口和 CSP
    src/
      components/ui/    共用 shadcn/ui 组件
      components/canvas/ 画布业务组件
      features/projects/ 项目首页、项目状态
      features/settings/ 保存目录、迁移、队列状态
      features/workspace/ 画布、视频卡片与放大预览
      lib/              界面工具函数
      styles.css        Tailwind 入口与主题变量
  shared/               跨进程接口类型
scripts/                开发辅助脚本
tests/                  真实 SQLite、临时文件和子进程中断场景
docs/                   产品、交互、架构和实施计划
out/                    构建产物，不提交
```

不要为了未来可能用到的功能预建大量空目录。出现明确的功能边界后再拆分模块。

UI 组件与样式遵循 [UI 基础与组件约定](ui-foundation.md)。`@/` 只映射到渲染界面的 `src/renderer/src/`；Electron 主进程不使用这个别名。

## 常用检查

```bash
pnpm check
pnpm test
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

涉及对应功能的修改，至少检查：

1. 应用成功打开，显示项目首页；输入名称创建项目后进入空画布。
2. 放大／缩小和拖动画布可操作。
   - 缩放达到边界后，对应按钮禁用；反向缩放后恢复。
   - 悬停和键盘聚焦时显示中文提示，Tab 焦点可见，Enter／Space 可以操作按钮。
3. preload 正常加载，应用信息 IPC 可以返回，不出现桌面连接错误。
4. 生产构建入口可以加载本地文件，不依赖开发服务器。
5. 关闭应用能够退出相应进程；macOS 保留应用并允许重新打开窗口的行为遵循系统约定。

6. 导入测试视频，确认单个播放入口、放大播放、退出预览、项目重新打开后素材可用。
7. 选择空目录并确认迁移预览；完成后检查新目录项目可用、旧受管副本已清理、额外放入的测试文件仍存在。

可在非打包环境设置 `AFFLATUS_USER_DATA` 和 `AFFLATUS_PROJECTS_DIR` 为两个互不包含的临时目录，隔离桌面验证数据。不要用真实项目做破坏性故障测试。

`pnpm test` 使用真实 SQLite、临时文件和主动退出的子进程，不接云端服务、不依赖 FFmpeg。Node 24.14 的内置 SQLite 会输出实验性 API 提示；访问封装在 `storage/database.ts`，业务模块无需依赖底层绑定。

视频拼接、长视频性能、FFmpeg 输出、真实云端生成和 Windows 安装包必须各自验证。

## 提交约定

- 提交前检查 `git diff --check`、`pnpm check`、`pnpm test`、`pnpm build`。
- CI 使用 `pnpm install --frozen-lockfile`，依赖调整时同步提交 lockfile。
- 产品行为发生变化时同步更新相应文档，尤其区分「已确认」「建议」「已实现」。
- 不提交个人环境配置、密钥、私有媒体、数据库或 `out/`。
- 不在仓库为空或暂无自动化测试时，把「没有失败」写成完整测试通过。
- 按用户约定，完成修改后提交并推送到当前工作分支。
