# Infinite Afflatus · 无限画布

一个以视频卡片为中心的本地桌面创作工具。主画布用来组织视频；进入镜头内部后，再准备参考图、分镜文本并通过云端 API 生成内容。

**核心交互：两张视频卡片左右吸附后合为一张组合卡片，使用一个播放入口，从左到右播放。**

## 当前状态

已完成本地项目、存储和主画布交互第一版。导入视频后可自由排列、左右拼接、拆分、撤销，并在全窗口编辑页按组合顺序播放、拖动片段两端裁剪。镜头素材子画布支持框选成组，成组后留在画布，手动展开时从原位置进入悬浮编辑区，自动保存本地草稿。

- 已建立 React、TypeScript、React Flow、Electron 和 electron-vite 工程。
- 已接入窗口、受限 preload/IPC、画布平移和缩放。
- 已接入 shadcn/ui、Tailwind CSS，以及共用按钮和悬浮提示。
- 已实现项目首页、新建／打开／改名，每项目独立 SQLite 保存素材与画布视口。
- 已实现视频导入和单卡片放大播放、统一保存目录、迁移预览／取消／恢复／精确清理。
- 已实现独立磁盘暂存和 SQLite 保存队列；目录切换后，待保存结果自动写入新目录。
- 已加入真实文件与 SQLite 集成测试（包括进程中断恢复）、类型检查、构建和媒体工具检测。
- 已实现卡片拖动、左右吸附提示与拼接、组合内片段选择、拆出选中片段并保留前后各自的连续组合、撤销／重做；卡片坐标与播放顺序独立持久化。
- 已实现双击卡片播放、长按片段后松开拆分；设置中可关闭长按、修改播放／拆分／撤销／重做快捷键并保存。
- 组合只有一个播放按钮，正常播放采用双播放器缓冲：预加载下一段，准备好首帧后切换；当前不保证音频无缝衔接。
- 已实现统一时间轨道、秒数刻度、当前片段与播放指针；拖动入点／出点即时预览、松手保存、撤销／重做、恢复原片。裁剪参数保存在项目 SQLite，源文件不变。
- 镜头素材子画布：文本、图片、视频、音频卡片自由排列；框选成组后留在画布并选中新组，手动「展开编辑」后显示左侧弧形素材轮盘、中间多文本块大卡片与右侧 Seedance 参数，原画布保留为背景。文本块可长按排序、拖出移回画布；无文本时补空块。已有组可与卡片或其他组继续合并。每镜头独立保存素材与多个生成组，支持上传、项目素材选择、解除组合和旧草稿转换。主画布仍只显示视频与待生成镜头。
- 素材卡片支持独立重命名和尺寸调整；镜头子画布新增可改名、改色、固定的标签，按住 `L` 显示方向气泡并跳转，快捷键可在设置中修改。
- 中间切开、片段重排、画面裁切、图片生成任务、候选结果历史、项目包导入导出仍待实现。
- 已接入 FFmpeg 轻量代理：拖动时使用低分辨率预览，松手或停留 150 ms 后等待原片对应帧就绪再切换。云端生成、成片导出、账号、计费和 ComfyUI 尚未接入。

## 本地开发

使用 Node.js 24（最低 24.14.0）和 pnpm 11.1.3。

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会检查并按需下载 Electron 运行时，然后启动开发服务器并打开桌面窗口。首次启动需要访问 Electron 下载源。复用已有开发进程，界面代码支持热更新。

```bash
pnpm check         # 代码规范与类型检查
pnpm test          # 真实文件、SQLite、迁移与保存恢复测试
pnpm test:upgrade  # 历史版本写入 → 当前版本读写 → 独立进程重启核对
pnpm build         # 构建到 out/，不产生安装包
pnpm start         # 打开构建后的桌面应用
pnpm doctor:media  # 检查本机 ffmpeg / ffprobe
pnpm exec electron tests/browser/material-tools.cjs # 复用开发服务的隔离交互回归
```

项目管理、视频导入和原片预览不依赖 FFmpeg。拖动时的轻量预览需要本机 `ffmpeg` 和 `ffprobe`，可通过 `FFMPEG_PATH`、`FFPROBE_PATH` 指定可执行文件；缺失或转码失败时自动使用原片。代理在首次进入编辑页时后台生成并缓存，时间截取仍使用原片播放参数。安装包内置工具和成片导出待实现。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [一期产品范围与页面](docs/product.md) | 已确定的方向、页面职责、待决定事项 |
| [交互规范](docs/interactions.md) | 卡片拼接、唯一播放入口、镜头编辑、裁剪及验收规则 |
| [播放与裁剪实现](docs/sequence-editing.md) | 全窗口编辑页、时间轨道、入出点与验证边界 |
| [画布实现与验证](docs/canvas-implementation.md) | 当前交互、数据格式、撤销边界与验证记录 |
| [技术架构](docs/architecture.md) | 进程分工、数据概念、本地媒体和云端生成边界 |
| [本地项目管理](docs/project-management.md) | 统一保存目录、独立项目、SQLite、素材与项目包 |
| [生成与保存](docs/generation-saving.md) | 独立磁盘暂存、保存队列、迁移期间等待及恢复 |
| [镜头素材子画布](docs/video-generation.md) | 素材节点、框选组合、Seedance 参数与镜头草稿 |
| [存储实现与验证](docs/storage-implementation.md) | 实际模块、恢复行为、测试和当前限制 |
| [UI 基础与组件约定](docs/ui-foundation.md) | 组件库选择、主题、共用组件与画布的分工 |
| [开发与验证](docs/development.md) | 环境、目录、命令、检查、提交约定 |
| [版本升级数据回归](docs/data-upgrade-testing.md) | GitHub 三系统测试、历史数据基线、验证范围与维护规则 |
| [实施顺序](docs/roadmap.md) | 初始化、交互原型、真实媒体、云端生成的阶段划分 |

## 技术选择

React 19、React Flow 12（`@xyflow/react`）、Electron 44、TypeScript、shadcn/ui（Base UI）、Tailwind CSS 4、electron-vite 5、Vite 7、pnpm、Biome。

Vite 7 位于当前 electron-vite 5 声明的兼容范围内。依赖具体版本以 `package.json` 和 `pnpm-lock.yaml` 为准。

软件内的本地后台逻辑由 Electron 承担，不额外启动 HTTP 后端。开发时的 Vite 服务仅服务于热更新。

本地数据库使用 Node 内置 SQLite；在设置中统一指定项目保存目录，新建项目只填名称，由软件自动创建独立子目录。生成与保存分开，结果先进入独立磁盘暂存区，保存队列在目录迁移期间等待，切换成功后写入新位置。旧重复数据按清单清理，保留用户其他文件。设计见 [本地项目管理](docs/project-management.md) 和 [生成与保存](docs/generation-saving.md)，已实现范围见 [存储实现与验证](docs/storage-implementation.md)。

远端仓库：[011011100/Infinite-Afflatus](https://github.com/011011100/Infinite-Afflatus)。
