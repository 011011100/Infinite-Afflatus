# 本地依赖补丁

- `@electron/asar@3.4.1`：既有补丁，等待 ASAR 输出流完成后再返回；本次保留不变。
- `@xyflow/react@12.12.0`：`useResizeHandler` 容器尺寸观察器与 `useResizeObserver` 节点尺寸观察器将测量合并到下一动画帧，避免在尺寸交付中发布 React store 更新导致已交付的浅层画布再次变化；初始化和窗口 resize 保持即时测量。节点测量按 ID 保留最新目标，取消观察时按目标身份丢弃待测项，断开时取消待执行帧。容器清理直接断开它拥有的观察器；React 卸载和 StrictMode 重放会先清空 DOM ref，原先按 ref 决定是否取消观察会漏清理。
- `@xyflow/system@0.0.83`：仅公开实例的最终 `destroy` 释放视口范围观察器；选框期间内部解除缩放监听的同名函数不释放观察器，后续缩放仍采用最新尺寸。

xyflow 补丁覆盖应用消费的 ESM 浏览器入口 `dist/esm/index.js` 与 Node ESM 入口 `index.mjs`；未修改应用不消费的 UMD 压缩包。版本由锁文件固定，升级 xyflow 时应核对上游实现后移除或重新生成补丁。安装验证使用 `pnpm install --frozen-lockfile`。

`tests/browser/xyflow-lifecycle.cjs` 使用隔离 renderer Vite，检查 StrictMode、循环挂载卸载、真实框选时缩放监听重绑、窗口区域尺寸变化后的缩放中心、真实 store 的尺寸合并与卸载取消，以及控制台。节点回归让真实 `useStore` 测量结果显示在画布上方的信息条：旧节点观察器会在交付中令浅层画布从 420 px 变为 392 px，产生浏览器原生的 `ResizeObserver loop completed with undelivered notifications`；补丁后在下一帧更新且无警告。它还验证快速改尺寸、待测节点移除后复用同 ID、待测时关闭画布。原 `reference-import-controls.cjs` 验证导入完成及返回首页的实际画布链路，不过滤 ResizeObserver 警告。
