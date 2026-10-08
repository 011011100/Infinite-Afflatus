# macOS 集中验收

本入口用于「先完成一批开发，再把 Mac 检查集中运行」。在开发云端只准备计划、检查脚本与 Node 测试，不启动 Electron，不把这些检查写成 Mac 验收通过。

## 一次入口

```bash
pnpm test:mac --plan
pnpm test:mac
```

`--plan` 可在任意系统使用，只输出 JSON 计划，不构建、不创建报告目录、不启动 Electron。实际执行只允许原生 macOS；其他系统退出码为 2。执行前须已安装项目要求的 Node 24（至少 24.14.0）、pnpm、锁定依赖和对应 Mac 的 Electron 运行时。若运行时缺失，报告将明确阻断桌面阶段并提示单独运行 `pnpm exec install-electron`；验收入口不会替用户安装或下载。

2026-10-08 的集中验收增加了测试专用安全边界：在未打包 Electron 入口前同步替换 safeStorage，禁止触及真实系统钥匙串。新增 `preflight-safe-storage` 后计划为 50 阶段；逐进程证据核对替身安装与加解密调用。正式打包应用尚无已验证的早期防护入口，因此 `packaged-smoke` 目前在启动前明确记为 blocked，不会运行；目录包构建与内容验证仍执行。这个默认边界不会证明真实 Keychain 或打包启动通过，也不会自动解除阻塞以得到全绿报告。

运行默认串行完成：

1. 检查本机工具与既有 Electron，构建一次。
2. 将 `tests/browser/run-fixtures.mjs` 当前每个隔离场景（含 `ark-generation-controls`）分别运行。一个场景失败不会隐藏其他独立场景。
3. 运行桌面打包工作流的 Mac 生产检查、100/1000 视频资源检查和新增 `preview-cache-desktop.cjs`。每个顶层脚本单独保留结果；脚本内部失败后的子场景仍须按其日志判定，不能算作通过。
4. 运行媒体工具诊断。
5. 在本轮独有目录创建未签名应用目录包，再只从该目录查找唯一的 `.app`。当前 no-Keychain 边界阻止 packaged smoke 启动；仍保存已核对的本轮可执行路径，不会扫描旧 `release/` 输出作为替代。

隔离 renderer 场景不依赖生产构建，构建失败后仍可独立执行。生产 IPC、媒体资源和打包依赖本轮构建成功；打包失败则 packaged smoke 为 blocked。缺少 FFmpeg 不会阻断无需 FFmpeg 的独立桌面用例。媒体工具检查失败会使本轮自动检查不完整。

## 可选范围

```bash
# 本批尚未验证代码／历史升级，或需要同机完整复核时
pnpm test:mac --include-code

# 使用本机真实 FFmpeg/FFprobe 运行合成媒体导出测试与生产交付
pnpm test:mac --real-media --real-delivery

# 等价的真实导出测试开关；不会自动启用 real-delivery
AFFLATUS_MEDIA_TESTS=1 pnpm test:mac

# 只使用已经提供的本地、可验证工具包；不下载、不签名、不发布
pnpm test:mac --media-tools /absolute/path/to/verified-media-tools
```

`--include-code` 添加 `pnpm check`、`pnpm test`、`pnpm test:upgrade`，避免每次桌面集中验收都重复云端代码检查。默认报告将三者记为 skipped。所有非真实媒体阶段都显式设置 `AFFLATUS_MEDIA_TESTS=0`；`--real-media` 专门运行 `AFFLATUS_MEDIA_TESTS=1 node --import tsx --test tests/export-media.test.ts`，未选时明确 skipped，不把普通单元通过当作真实编码通过。

`--real-delivery` 在隔离项目中启动 `tests/browser/delivery.cjs`，检查真实合成视频、导出、项目包和重新打开。它需要本机 FFmpeg/FFprobe，必要时使用已经设置的 `FFMPEG_PATH`/`FFPROBE_PATH`。传入 `--media-tools` 只表示对该包执行本地目标/清单/哈希验证并收入本轮目录包，不自动批准其来源或再分发，也不会替代宿主机真实编码测试。

每项固定超时（renderer 3 分钟，多数生产检查 5 分钟，构建/打包和可选代码检查 10 分钟）。按 Ctrl+C 会停止当前阶段所属的子进程组，记录 interrupted，尚未运行的阶段记录 blocked；不会关闭用户的其他应用。不要同时启动多个验收批次或让其他进程改写本 checkout 的 `out/`。各用例沿用自己的临时配置、项目库和原生对话框替身，不连接已打开的用户开发应用。runner 不递归清理输出；中断留下的临时材料须结合用例所有权标记人工处理，不能删除用户目录。

## 报告与结论

每轮创建新的 `release/acceptance/<UTC时间>-<随机后缀>/`（由现有 `release/` 忽略规则覆盖），保留：

- `report.json`：commit、dirty、平台/架构、macOS 与 Node/pnpm/Electron/应用版本、所选范围、每阶段状态/时间/耗时、手工待验项。
- `<阶段>.stdout.log`、`<阶段>.stderr.log`、`<阶段>.json`：成功、失败、超时、阻断或跳过分别记录；没有运行的阶段不会写成 passed。
- `media-resources/`：资源用例本轮诊断和截图；其他用例自行报告的临时证据路径仍见其日志。
- `package/`：本轮独有应用目录包，绝不复用/删除上轮包。

报告逐阶段更新，终端会打印确切路径。不转储环境变量或凭据。返回 0 只表示所选自动阶段通过；报告的 `acceptanceStatus` 仍为 `requires-manual-validation`，不能据此宣称正式发行验收完成。失败、超时、blocked 返回 1，因此在当前 packaged-smoke 默认阻塞的边界下，其他可执行阶段全部通过仍会返回 1；必须读取逐阶段结果，不能把它误报成产品断言失败或完整通过。SIGINT/SIGTERM 分别返回 130/143。强制 SIGKILL 无法执行收尾，已有报告中的 running/pending 必须按未完成处理。

汇总所有失败到 `docs/verification-issues.md` 后集中修复，再复验受影响范围。不要为了得到绿色结果跳过失败用例、更新历史数据期望或反复重跑掩盖问题。

## 必须另行记录的真实 Mac 边界

- B19-05：真实方向键第二次显示标签气泡的现象，核对视口和事件证据；不能凭其他夹具成功关闭旧问题。
- B19-06：生产快捷键设置按钮的系统激活/实际焦点；记录各内部进程是否真正执行，后续未运行不是通过。
- 真实中文输入法：组合输入、候选选择、Enter/Escape、快捷键拦截、失败保存焦点/选区、原生关闭。合成键盘事件不等于输入法验收。
- 新增 staged-reference 读取：隔离暂存中已完整接收但尚未保存的图片/视频/音频/文本，在等待保存、目录不可用与迁移期间可读；Range、中止与租约释放、并发保存清理、保存完成、重载/重启后引用一致。Node 存储/协议测试不能替代这些原生 IPC/播放器证据。
- 预览缓存：在用流重叠、暂停播放、重载/关闭、迁移交错、大小写文件系统、大项目哈希检查响应性。新增桌面夹具的替身代理不等于真实 FFmpeg 转码。
- Ark UI/service 集成点：已注册隔离 `ark-generation-controls` 控件夹具；生产服务新增独立桌面脚本时，加入 `productionChecks`，保留独立阶段。原生凭据存储/重启与生产结果采用链路仍须桌面证据，计划中的 `ark-integration` 保持 manual。中国区真实 Ark 凭据、参考素材上传、费用和真实结果接收须另行明确配置、授权/验收；控件替身与 Node 服务检查不等于真实云调用。
- 目标 OS/架构分别验收；本轮 Mac 不覆盖 Windows 或其他架构。目录包不覆盖安装、覆盖安装、卸载保留数据、历史已安装版本升级、签名、公证或 Gatekeeper。
- FFmpeg/FFprobe 的来源、许可证、声明文件、编码器兼容性与再分发许可单独审核；本轮不自动下载媒体包，也不签署协议。

## runner 自身的 Node 检查

```bash
node --test tests/mac-acceptance.test.mjs
```

这些测试验证计划覆盖、串行依赖/继续策略、跳过/阻断/中断结果、日志、超时、环境隔离和新包定位。测试中的子进程只有 Node，没有 Electron；成功只证明验收入口自身行为，不代表 Mac 桌面已验收。
