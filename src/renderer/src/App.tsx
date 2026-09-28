import {
  Background,
  BackgroundVariant,
  type Edge,
  type Node,
  Panel,
  ReactFlow,
} from '@xyflow/react';
import { useEffect, useState } from 'react';
import { CanvasControls } from '@/components/canvas/canvas-controls';

const emptyNodes: Node[] = [];
const emptyEdges: Edge[] = [];

export function App() {
  const [desktopError, setDesktopError] = useState(false);

  useEffect(() => {
    let active = true;
    if (!window.desktop) {
      setDesktopError(true);
      return;
    }

    void window.desktop
      .getAppInfo()
      .then((info) => {
        if (active) document.title = info.name;
      })
      .catch(() => {
        if (active) setDesktopError(true);
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-13 shrink-0 items-center gap-6 border-b bg-background px-6 select-none">
        <span className="text-[15px] font-semibold tracking-tight">
          Infinite Afflatus
        </span>
        <span className="text-[13px] text-muted-foreground">未命名项目</span>
      </header>

      {desktopError && (
        <div
          className="bg-warning px-6 py-2.5 text-sm text-warning-foreground"
          role="alert"
        >
          无法连接桌面功能，请通过桌面应用重新打开。
        </div>
      )}

      <main className="relative min-h-0 flex-1" aria-label="视频创作画布">
        <ReactFlow
          nodes={emptyNodes}
          edges={emptyEdges}
          minZoom={0.25}
          maxZoom={2}
          nodesConnectable={false}
          zoomOnDoubleClick={false}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="var(--canvas-dot)"
          />
          <CanvasControls />
          <Panel
            position="bottom-left"
            className="text-xs text-muted-foreground select-none"
          >
            拖动画布 · 滚轮缩放
          </Panel>
        </ReactFlow>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-muted-foreground select-none">
          <h1 className="mb-2.5 text-xl font-medium">从一个镜头开始</h1>
          <p className="text-sm">视频将在这里拼接成片</p>
        </div>
      </main>
    </div>
  );
}
