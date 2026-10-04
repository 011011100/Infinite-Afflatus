# Infinite Afflatus 应用图标设计稿

用户已确认采用[第三版：右侧弧面修整](v3-notes.md)，图稿为 `infinite-afflatus-icon-v3.png`。应用源资产位于 `src/shared/assets/app-icon.png`，与第三版 PNG 完全一致。

## 应用接入

- Electron 窗口与 macOS Dock 使用同一个 PNG。
- 开发与构建后的 renderer 共用该 PNG 作为 favicon，构建时自动复制到输出目录。
- 历史草稿保留用于对比，不作为运行时资源。
- 正式安装包尚未配置；`.icns`／`.ico`、小尺寸及透明边缘整理在安装包阶段处理。

## 设计方向

以用户指定的无限符号 ♾️ 为主体：一条从浅蓝到钴蓝的连续缎带，中央交叉处带轻微立体感；浅色圆角底板呼应现有界面的蓝色主题。

- 文件：`infinite-afflatus-icon.png`，透明背景 PNG。
- 使用内置 imagegen 生成，并进行一次边缘修整。
- 第一版为历史设计原稿，正式采用的第三版接入范围见上文。
- 不包含文字，以便在不同语言环境下使用。

## 第二版：增加层次

用户认可蓝色方向，希望减少素净感。第二版保留无限符号，强化缎带交叠光影，在浅蓝底板加入光晕与柔和的流动轮廓。

- 文件：`infinite-afflatus-icon-v2.png`，由内置 imagegen 基于第一版编辑，保留第一版便于对比。
- 仍是设计稿，未替换应用图标；透明边缘尚有零散像素，正式使用前需清理，并检查深浅背景和小尺寸效果。

### 第二版提示词

```text
Edit this icon into a richer, more memorable second design for the desktop creative app Infinite Afflatus. User feedback: the blue palette matches the product and should stay, but the design feels a little too plain. Keep the unmistakable horizontal infinity symbol ♾️ and the centered rounded-square application tile. One icon only.

Art direction: a beautifully sculpted, broad continuous satin-blue ribbon, azure to royal blue #2563EB to deep cobalt. Add visible, elegant thickness and a refined bevel to the ribbon, with clear lit upper surfaces, darker blue side faces, deeper crossover occlusion and subtle blue reflected light. The infinity should feel tangible and dimensional, like an expertly crafted folded strip, while its two holes and continuous silhouette remain extremely legible at small sizes. Soft controlled studio light, not excessive shiny plastic.

Enrich the pale rounded-square tile with a soft icy-blue translucent ceramic appearance and a broad, subtle blue halo behind the infinity mark. A delicate luminous edge around the tile is enough. A few broad flowing tonal contours within the tile can echo the continuous ribbon and the idea of a boundless creative canvas, but must be restrained and barely visible. Keep the main symbol bold, uncluttered and dominant. Increase the visual richness through material and light, not added objects. No extra stars, sparkles, dots, decorative text, play symbols, letters, checkerboard, or rainbow colors. Front-on orthographic composition. Generous consistent transparent margin, one clean rounded-square silhouette with pristine smooth antialiased alpha edges; no flecks or stray pixels outside it. High-resolution square app-icon art, not a mockup, no surrounding scene. Preserve transparent background outside the tile.
```

## 初稿提示词

```text
Create one exceptionally polished desktop application icon for "Infinite Afflatus", a spatial creative canvas app for AI image and video creation. This is logo-brand artwork, not a mockup presentation. The user explicitly requires the infinity symbol ♾️: it must be the immediately recognizable central shape, a horizontal infinity loop with two open negative-space holes and a clear crossover, not a letter, knot, or chain link.

Design a single broad, continuous sculpted ribbon forming this infinity symbol, with smoothly squared yet generous curves suggesting a boundless canvas. Clean iconic silhouette, beautifully balanced optical weight, elegant restrained dimensionality. Ribbon transitions from luminous azure at the upper left into rich royal blue #2563EB and deeper cobalt at the lower right. At the central crossover one ribbon passes clearly over the other, with a subtle soft contact shadow. Sophisticated satin material with gentle light on the edges, no chrome, no glitter, no iridescent rainbow, no glass transparency. Avoid tiny details, thin lines, decorative stars, video play triangles, cameras, or extra symbols.

Center the large infinity mark on a warm-white / very pale cool-white rounded-square app tile with continuous smooth corners. Straight-on orthographic view. Subtle edge bevel and a quiet soft shadow integrated into the tile, minimal professional desktop application finish. The tile occupies about 88% of the square image, centered; the infinity occupies about 75% of tile width and 46% of tile height. Generous breathing room. Absolutely no text, letters, words, captions, grids, devices, or surrounding scene. ONE icon only, not variants and not multiple sizes. High resolution square output. Outside the rounded-square tile must be fully transparent with clean alpha edges. Legible and distinct at 32 pixels.
```

## 最终修整提示词

以前一张生成图作为参考。

```text
Refine this app icon for final delivery. Preserve the beautiful central blue ribbon infinity symbol exactly in spirit, its two open loops, its light cyan to cobalt blue colors, its dimensional crossover, and the pale white rounded-square tile. Make the outer tile boundary perfectly smooth, clean, geometric and continuous. Remove ALL ragged fringes, tiny stray white pixels, floating flecks, wispy white artifacts, and noisy speckle outside the tile. Transparent background beyond the tile. Use a very restrained soft shadow or no external shadow so the silhouette is absolutely pristine. Precisely center the icon on a square canvas with consistent transparent margin on all four sides. Do not add text, new symbols, or alter this into a mockup. One polished high-resolution icon only.
```
