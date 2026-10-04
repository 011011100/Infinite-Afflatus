# 桌面内部包

当前提供可重复执行的本机打包流程，产物用于内部验证，尚不代表正式可发布。打包使用锁定的 `electron-builder 26.15.3`、`@electron/asar 3.4.1` 与项目现有的 Electron `44.4.5`。配置采用 [electron-builder v26](https://www.electron.build/v26/docs/configuration/) 字段，未采用下一版 v27 的签名配置。

[`@electron/asar 3.4.1` 官方源码](https://github.com/electron/asar/blob/v3.4.1/src/disk.ts)的两个归档写入路径在源流结束后直接返回 `out.end()`，尚未等目标流完成；已核查安装的 `electron-builder 26.15.3` 中 `AsarPackager.executeElectronAsar` 也只等待这个 Promise。全量测试曾复现提前读取末尾文件得到空字节。因此本仓库通过 `pnpm patchedDependencies` 固定一个最小补丁：两个路径均使用 `finished()` 等待目标流完成，再返回原 Writable，保留既有 API。补丁随锁文件安装，直接完成时点与归档内容回归分别覆盖文件和流写入，不使用延时或重试。升级这两个依赖时应确认上游完成语义，再决定移除补丁。

## 构建与检查

使用项目规定的 Node.js 24 与 pnpm 11.1.3，在目标系统、目标 CPU 架构上执行：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:upgrade
pnpm test:browser
pnpm package:dir
pnpm package:local
```

- `package:dir` 先执行 `install-electron` 安装缺失的锁定版本运行时，再执行类型检查和生产构建，最后生成未压缩应用目录。
- `package:local` 同样先安装运行时并重新构建；macOS 生成含 `.app` 的内部 ZIP，Windows 生成 NSIS 内部安装程序。只构建本机架构，不提供跨平台打包参数。
- 输出位于已被 Git 忽略的 `release/`。macOS ARM64 示例为 `release/mac-arm64/Infinite Afflatus.app`；其他系统和架构以打包日志为准。内部压缩包／安装程序名称包含版本、系统、架构与 `internal`。
- 构建复用 `node_modules/electron/dist` 的本机 Electron，并核对版本。当前 Electron 包没有自动运行的 `postinstall`，打包命令明确调用其 `install-electron`；已有正确运行时会直接复用。首次打包仍可能下载 electron-builder 的官方图标转换器或 NSIS 构建工具。
- `electron-winstaller` 属于打包器带入的 Squirrel 依赖，本项目使用 NSIS，因此在 pnpm 的 `allowBuilds` 中明确禁用它的安装脚本。

每次打包都会自动核查 ASAR。也可手动传入未压缩目录复查，例如：

```bash
pnpm package:verify release/mac-arm64
```

脚本只读应用包，不启动它。打包本身也不会打开应用、访问用户项目库或安装程序。重复执行代表相同锁定工具链和文件范围可重建，不承诺包含时间戳的 ZIP／安装程序逐字节一致。

## 包内范围与身份

先将生产构建复制到本次独立创建的暂存目录，再交给打包器。应用 ASAR 仅包含 `out/main`、`out/preload`、`out/renderer` 的明确运行文件和精简 `package.json`；不复制源代码、测试、文档、`.env`、项目数据库、用户素材或工作区 `node_modules`。暂存目录在成功或失败后清理。Electron 自身框架、许可证与系统运行资源由官方运行时提供。

主进程与 preload 的导入通过语法树核查，只允许 Electron、Node 内置模块和已存在的本地构建文件；发现未打包依赖即失败。最终 ASAR 再核查文件白名单、符号链接、入口、preload、图标、页面 JS/CSS 与资源引用，拒绝 `app.asar.unpacked`。若将来引入原生扩展或主进程外部依赖，需要明确修改打包范围，不能直接忽略检查。

`appId` 固定为 `com.infiniteafflatus.desktop`，`productName` 和运行时 `app.setName` 保持 `Infinite Afflatus`，不因内部包增加版本或渠道后缀而改变应用数据目录。默认项目库与已有设置沿用运行时原有规则。NSIS 使用当前用户安装，可选择安装目录，卸载配置不删除应用数据，不在安装完成后自动启动应用。

配置保留现有蓝色无限符号图标，未引入新的图标素材。普通用户的启动与升级验证应使用独立测试账号或测试目录，避免把测试包直接连到日常项目库。

## 媒体工具与发布边界

本包**没有附带独立 `ffmpeg` 或 `ffprobe` 可执行工具**。视频轻量预览和成片导出仍依赖外部工具；`FFMPEG_PATH`、`FFPROBE_PATH` 和系统可执行路径由应用运行时检测。macOS 的 Finder 启动环境可能与终端不同，应使用应用设置中的视频处理检查确认。`pnpm doctor:media` 仅代表当前终端环境。这里没有自动下载媒体工具，也没有确定可再分发版本、许可证与来源清单。

构建脚本强制 `--publish never`，清除传入的签名环境变量并禁用证书自动发现。macOS 明确设置 `identity: null`、`notarize: false`、`hardenedRuntime: false`；Windows 使用 v26 的 `signExecutable: false` 保留图标／版本资源编辑，同时跳过签名。依据 [macOS 配置](https://www.electron.build/v26/docs/mac/) 与 [Windows 配置](https://www.electron.build/v26/docs/win/)，这些是内部未签名产物，不能据此宣称通过 Gatekeeper、SmartScreen 或正式发布验证。

手动触发的 `Desktop package validation` 工作流在 Windows/macOS 原生构建，上传内部 ZIP／NSIS 构建物，不发布 Release。包检查与隔离启动、保存、重启读取测试，分别与生产入口故障恢复、强杀草稿恢复、部分参考素材导入和 Windows 安装回归执行；这些仍不等于证书、公证、历史版本升级或不同系统版本的兼容性验收。

参考素材取消回归使用真实 512 MiB 文件；观察实际接收字节大于零且尚未完成后，分别点击取消按钮或关闭原生窗口。核对第一份完整素材引用保留、第二份仅有未完成部分文件、第三份没有开始，并在新进程重开后继续编辑保存；完整读取源文件并比对 SHA-256。该测试使用生产主进程、preload 和页面，只替换原生文件选择，不用模拟接收进度代替磁盘行为。

另有真实项目失联回归：512 MiB 合法 WAV 接收途中移走项目数据库，在页面已进入不可用状态后继续完成导入。核对全部完整引用留在原镜头及独立恢复草稿、返回被阻止且未重建空库，再放回原数据库、显式重试读取和保存任务。新进程重开后，引用唯一、音频元数据可读取、完整源文件哈希不变。

项目恢复另有确定性 React 回归：固定在后台参考素材已保存、界面未刷新时使项目离线，恢复原数据后检查编辑器与撤销记录继续使用；遗漏已保存引用的旧库、原素材变化和画布变化必须继续报冲突。该夹具使用模拟 IPC，主进程的一次性恢复快照与保存确认记录另由真实 SQLite 测试覆盖，不替代上述生产入口失联测试。

暂存清理回归同样使用真实接收、取消、预览、确认与新进程重开，并由固定历史提交创建旧部分文件和完整结果作为保护对照。只替换原生文件选择器，不模拟清理服务。历史写入需要完整 Git 历史，桌面工作流因此使用完整检出，缺少固定提交时必须失败。

`pnpm test:browser` 另用随机高端口、独立 Vite 缓存和临时 Electron 配置运行尺寸监听器、导入离开、暂存确认与媒体组件设置交互；不连接或重启现有开发服务。这些真实 React 夹具使用模拟 IPC，不能证明真实磁盘或云端调用。父进程在 Electron 结束后清理本次临时目录，处理中断和超时；Windows 不在仍持有文件的 Electron 进程内删除其 profile。锁定的 xyflow ESM 补丁及范围见 [依赖补丁说明](../patches/README.md)。

`tests/browser/media-tool-settings-desktop.cjs` 另在生产构建上验证三次独立启动：通过原生选择入口验证并保存两项路径、重启读取与单项重置、未知版本配置保留及明确清除。测试生成只返回版本的可执行程序，Windows 使用本机 .NET Framework 编译器生成可执行 `.exe`，缺少编译器时失败而不跳过；实际执行子进程、SQLite、preload 和页面，源程序哈希须不变。这证明组件配置链路，不证明 FFmpeg 编解码能力或系统安装器行为。

`tests/browser/project-edit-recovery.mjs` 使用生产入口、preload、页面和实际 SQLite，验证名称输入与真实视频裁剪手势保护后强杀重开、内容冲突与救援导出、提交成功但副本清理失败，以及连续两次丢失提交回执后的第三次名称输入恢复。原生故障注入只用于确定失败时点，原数据库、卡片、工作区、恢复副本与源素材哈希均有完整核对；视频为固定合成测试素材。另有名称、裁剪与公共恢复共 21 项模拟 IPC 界面场景，两类证据分别记录。

2026-10-05，提交 `9ccde342582c693cf0da35719e04d730bf773d72` 的 [内部包验证](https://github.com/011011100/Infinite-Afflatus/actions/runs/37216999812) 在 Windows 与 macOS 均通过：原生构建、ASAR 内容校验、实际包内程序启动、视频组件状态展示、文字保存及重启读取。Windows 构建了 NSIS 安装程序，但自动启动测试使用其未压缩应用目录，未执行安装器。

### Windows 安装回归

工作流另执行 `tests/browser/windows-installation.mjs`，仅允许 GitHub 托管的临时 Windows 机器运行。脚本拒绝已有安装注册项或默认应用数据目录，只在本次临时目录安装本次构建物，不接受外部路径参数，不在开发者电脑执行安装器。

测试使用安装后的真实程序与默认用户数据目录，创建项目、保存镜头文字、修改设置并保护未提交草稿；正常退出后执行同一版本覆盖安装，再次启动核对原内容。卸载后核对默认应用数据与项目文件的全部字节保持不变，并确认安装的主程序和 ASAR 已移除。清理只作用于带本次所有权标记且文件身份未变化的测试目录。

名称与裁剪恢复格式加入后，安装测试还通过安装程序的真实 preload 写入独立名称恢复流，在覆盖安装前后、重开并正常退出后、卸载后逐次核对完整记录与文件哈希；原有镜头恢复和项目字节核对保持。裁剪真实手势由上述生产入口测试覆盖，不在无视频的安装夹具中伪造。

2026-10-05，提交 `1ee25bcbceea9047ee464b3d1f5d7202d4485b77` 的 [内部包验证](https://github.com/011011100/Infinite-Afflatus/actions/runs/37218359821) 首次完成上述 Windows 安装／同版本覆盖／卸载保留数据实测；该次两端包内启动、三类启动故障与强杀草稿恢复也通过。测试验证同版本覆盖，不代表从历史安装版升级；签名、系统信任提示与历史版本升级仍分别验收。

提交 `3c4cdfe0692e50ed5110f0bab0ac529ebdcc5a8c` 的 [后续回归](https://github.com/011011100/Infinite-Afflatus/actions/runs/37218726447) 在两端再次通过上述流程，并新增真实生产程序的部分参考素材导入、继续编辑和重开验证；空文件的局部失败没有产生失效节点或使项目不可用。

提交 `57c753cb92893671ae0ae76c285563b189fbc1c8` 的[后续回归](https://github.com/011011100/Infinite-Afflatus/actions/runs/37220912617)在 Windows／macOS 均通过新增的真实大文件取消、原生关闭和项目失联恢复测试。原有包内启动、启动故障、异常退出草稿恢复及部分导入回归继续通过，Windows 安装、同版本覆盖和卸载保留数据也通过；两个内部构建物已由工作流上传，仍不是正式签名发行包。

提交 `3b10d76ed46fba737595da479f26b93db9281016` 的[后续验收](https://github.com/011011100/Infinite-Afflatus/actions/runs/37225856499)在两端全部通过：新增暂存清理实测、恢复基线与节点尺寸通知回归，两端各 25 项隔离界面场景保持严格控制台检查。原有包内启动、启动故障、异常退出草稿恢复、部分导入、取消和失联恢复继续通过；Windows NSIS 首次安装、同版本覆盖及卸载保留数据再次通过。已上传 [macOS 内部 ZIP](https://github.com/011011100/Infinite-Afflatus/actions/runs/37225856499/artifacts/11312132176)和 [Windows 内部构建物](https://github.com/011011100/Infinite-Afflatus/actions/runs/37225856499/artifacts/11312042459)，仍未签名，不能代替正式发行及历史安装版升级验证。

提交 `2de1b36f25a762e30123b0b8c712617160df44e4` 的[媒体组件配置验收](https://github.com/011011100/Infinite-Afflatus/actions/runs/37227675144)在两端全部通过：各 36 项严格界面场景、新增真实生产配置三进程重开，以及原有磁盘、强杀和恢复回归。Windows 实际运行测试生成的 `.exe` 完成选择与版本验证，安装／同版本覆盖／卸载保留数据再次通过。已上传 [macOS 内部 ZIP](https://github.com/011011100/Infinite-Afflatus/actions/runs/37227675144/artifacts/11312421768)和 [Windows 内部构建物](https://github.com/011011100/Infinite-Afflatus/actions/runs/37227675144/artifacts/11312810966)。版本程序仅证明配置链路，Windows 真实 FFmpeg 编码、正式签名与历史安装版升级仍待各自验收。

提交 `dd0a849ac0407ea81fe9c38ebcf1982ce373128e` 的[名称与裁剪恢复验收](https://github.com/011011100/Infinite-Afflatus/actions/runs/37230345190)在两端通过：各 57 项严格界面场景和新增 5 条生产恢复链路，原有包内启动、磁盘故障、导入取消、草稿恢复与暂存清理继续通过。Windows NSIS 首次安装、同版本覆盖、重开及卸载均验证独立名称恢复记录的原字节保留。已上传 [macOS 内部 ZIP](https://github.com/011011100/Infinite-Afflatus/actions/runs/37230345190/artifacts/11312759166)和 [Windows 内部构建物](https://github.com/011011100/Infinite-Afflatus/actions/runs/37230345190/artifacts/11313379646)，仍是未签名内部包。相同提交的三系统固定历史升级各 34 项通过；正式签名、历史安装版升级和云端 API 仍未验证。

正式分发前仍需确定支持平台与最低系统版本，补齐发行者信息、第三方许可审查、媒体工具分发方案、签名／公证、安装升级与卸载回归。云端 API 与账号计费没有因打包而接入；云端实测应单独记录。
