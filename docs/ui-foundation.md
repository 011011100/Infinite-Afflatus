# UI 基础与组件约定

更新时间：2026-09-28。

## 已确定的选择

使用 **shadcn/ui + Tailwind CSS**，配合 React Flow 构建界面。选择可在项目内修改源码的基础组件，服务于简洁的视频画布设计。

当前采用 shadcn/ui 的 `base-nova` 配置，交互基础为 Base UI，图标为 Lucide。这是工程组件配置，不表示用户已经确认了一整套页面样式。字体使用本机系统字体，不需要联网加载。

| 层次 | 职责 |
| --- | --- |
| shadcn/ui + Base UI | 共用按钮、提示；未来按页面需要加入弹窗、菜单、输入框等 |
| Tailwind CSS | 页面布局、间距、状态样式；语义颜色和圆角由主题变量统一 |
| React Flow | 视口平移、缩放、节点定位、选择与拖动能力 |
| 业务组件 | 单视频卡片、组合卡片、左右吸附、唯一播放入口、镜头编辑 |

视频卡片不直接套用通用 Card 的默认结构。主画布只放视频，图片和分镜文本仍收在镜头内部；组合只有一个播放入口。

## 当前已接入

- `components.json` 记录组件风格、源码目录和别名。
- `components/ui/button.tsx`、`tooltip.tsx` 为官方 CLI 加入后由项目维护的组件源码。
- `components/canvas/canvas-controls.tsx` 使用共用按钮和提示，控制 React Flow 的缩放。
- `styles.css` 引入 Tailwind、动画工具、shadcn 样式和 React Flow 样式，定义浅色主题。
- `lib/utils.ts` 提供统一的 `cn` 类名合并入口。

目前只加入实际使用的 Button 和 Tooltip。弹窗、表单、裁剪控件在相应页面实现时再加入。当前没有暗色模式切换，也没有确定镜头编辑最终采用子画布还是浮层。

## 维护规则

1. 新页面优先复用 `components/ui`，不要各自实现按钮、焦点和禁用状态。
2. 页面布局使用 Tailwind；颜色使用 `bg-background`、`text-muted-foreground` 等语义变量。修改全局颜色和圆角时集中改 `styles.css`。
3. 图标按钮必须有明确的中文可访问名称。提示补充含义，不代替名称；键盘焦点必须可见。
4. 画布控件放在 React Flow 的 Panel 中；节点内部的按钮、输入和拖动控件按需使用 `nodrag`、`nopan`、`nowheel`，避免手势冲突。
5. UI 组件不访问文件系统、FFmpeg 或云端服务；桌面业务仍经过受限 preload 接口。
6. Tailwind 在 React Flow 样式之前引入；升级时检查画布尺寸、节点定位和控件样式是否正常。

按需加入组件，使用仓库内锁定版本的 CLI。例如需要弹窗时：

```bash
pnpm exec shadcn add dialog
```

生成后检查依赖和源码差异，适配项目主题与格式，再运行 `pnpm check`、`pnpm build` 和相关桌面交互检查。共用组件修改需要检查已使用它的页面。

## 依据

- [shadcn/ui 手动接入](https://ui.shadcn.com/docs/installation/manual)
- [shadcn/ui 组件配置](https://ui.shadcn.com/docs/components-json)
- [Tailwind CSS 的 Vite 集成](https://tailwindcss.com/docs/installation/using-vite)
- [React Flow 样式约定](https://reactflow.dev/learn/customization/theming)
