import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type Node,
  Panel,
  ReactFlow,
} from '@xyflow/react';
import { useEffect, useState } from 'react';

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
    <div className="application">
      <header className="application-header">
        <span className="application-name">Infinite Afflatus</span>
        <span className="project-name">未命名项目</span>
      </header>

      {desktopError && (
        <div className="desktop-error" role="alert">
          无法连接桌面功能，请通过桌面应用重新打开。
        </div>
      )}

      <main className="canvas" aria-label="视频创作画布">
        <ReactFlow
          nodes={emptyNodes}
          edges={emptyEdges}
          minZoom={0.25}
          maxZoom={2}
          nodesConnectable={false}
          zoomOnDoubleClick={false}
          ariaLabelConfig={{
            'controls.zoomIn.ariaLabel': '放大画布',
            'controls.zoomOut.ariaLabel': '缩小画布',
          }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="#dce3ed"
          />
          <Controls
            showFitView={false}
            showInteractive={false}
            position="bottom-right"
          />
          <Panel position="bottom-left" className="canvas-hint">
            拖动画布 · 滚轮缩放
          </Panel>
        </ReactFlow>

        <div className="canvas-empty-state">
          <h1>从一个镜头开始</h1>
          <p>视频将在这里拼接成片</p>
        </div>
      </main>
    </div>
  );
}
