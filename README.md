# Infinite Afflatus · 无限画布

一个以视频卡片为中心的本地桌面创作工具。主画布用来组织视频；进入镜头内部后，再准备参考图、分镜文本并通过云端 API 生成内容。

**核心交互：两张视频卡片左右吸附后合为一张组合卡片，使用一个播放入口，从左到右播放。**

## 当前状态

项目处于工程初始化阶段，当前可运行的是桌面空画布，不是完整的交互原型。

- 已建立 React、TypeScript、React Flow、Electron 和 electron-vite 工程。
- 已接入窗口、受限 preload/IPC、画布平移和缩放。
- 已接入 shadcn/ui、Tailwind CSS，以及共用按钮和悬浮提示。
- 已加入类型检查、代码检查、构建和本地媒体工具检测命令。
- 视频导入、拼接、播放、裁剪、镜头编辑、项目保存仍待实现。
- 云端生成和 FFmpeg 媒体处理尚未接入。当前不包含账号、计费或 ComfyUI。

## 本地开发

使用 Node.js 24（最低 24.14.0）和 pnpm 11.1.3。

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会检查并按需下载 Electron 运行时，然后启动开发服务器并打开桌面窗口。首次启动需要访问 Electron 下载源。复用已有开发进程，界面代码支持热更新。

```bash
pnpm check         # 代码规范与类型检查
pnpm build         # 构建到 out/，不产生安装包
pnpm start         # 打开构建后的桌面应用
pnpm doctor:media  # 检查本机 ffmpeg / ffprobe
```

当前空画布运行不依赖 FFmpeg。媒体处理阶段才需要可用的 FFmpeg/FFprobe 二进制文件；安装包内置方式待确定。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [一期产品范围与页面](docs/product.md) | 已确定的方向、页面职责、待决定事项 |
| [交互规范](docs/interactions.md) | 卡片拼接、唯一播放入口、镜头编辑、裁剪及验收规则 |
| [技术架构](docs/architecture.md) | 进程分工、数据概念、本地媒体和云端生成边界 |
| [本地项目管理](docs/project-management.md) | 统一保存目录、独立项目、SQLite、素材与项目包 |
| [生成与保存](docs/generation-saving.md) | 独立磁盘暂存、保存队列、迁移期间等待及恢复 |
| [UI 基础与组件约定](docs/ui-foundation.md) | 组件库选择、主题、共用组件与画布的分工 |
| [开发与验证](docs/development.md) | 环境、目录、命令、检查、提交约定 |
| [实施顺序](docs/roadmap.md) | 初始化、交互原型、真实媒体、云端生成的阶段划分 |

## 技术选择

React 19、React Flow 12（`@xyflow/react`）、Electron 44、TypeScript、shadcn/ui（Base UI）、Tailwind CSS 4、electron-vite 5、Vite 7、pnpm、Biome。

Vite 7 位于当前 electron-vite 5 声明的兼容范围内。依赖具体版本以 `package.json` 和 `pnpm-lock.yaml` 为准。

软件内的本地后台逻辑由 Electron 承担，不额外启动 HTTP 后端。开发时的 Vite 服务仅服务于热更新。

本地数据库已确定使用 SQLite；在设置中统一指定项目保存目录，新建项目只填名称，由软件自动创建独立子目录。生成与保存分开，结果先下载到独立磁盘暂存区，保存队列在目录迁移期间等待，切换成功后写入新位置。旧重复数据按清单清理，保留用户其他文件。具体方案见 [本地项目管理](docs/project-management.md) 和 [生成与保存](docs/generation-saving.md)，当前尚未实现持久化。

远端仓库：[011011100/Infinite-Afflatus](https://github.com/011011100/Infinite-Afflatus)。
