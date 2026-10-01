import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HoldFeedbackProvider } from '@/components/canvas/hold-feedback';
import { MaterialCanvas } from '@/features/generation/material-canvas';
import {
  groupMaterials,
  newShot,
  ungroupMaterials,
} from '../../src/shared/generation/workspace';
import type { ProjectSnapshot } from '../../src/shared/models';
import '../../src/renderer/src/styles.css';

const initial = newShot('test', '卡片与标签测试', { x: 0, y: 0 });
initial.nodes = [
  { id: 'text', type: 'text', text: '镜头内容', position: { x: 100, y: 130 } },
  {
    id: 'asset',
    type: 'asset',
    assetId: 'image',
    position: { x: 550, y: 130 },
  },
];
initial.labels = [
  {
    id: 'north',
    name: '红色上方标签',
    color: '#ef4444',
    pinned: true,
    position: { x: 300, y: -1300 },
  },
  {
    id: 'local',
    name: '当前标签',
    color: '#2563eb',
    pinned: false,
    position: { x: 600, y: 500 },
  },
];
const snapshot: ProjectSnapshot = {
  project: { id: 'test', name: '隔离测试', folder: 'test', updatedAt: '' },
  assets: [
    {
      id: 'image',
      name: '源素材.png',
      kind: 'image',
      relativePath: 'test.png',
      size: 0,
      sha256: '',
    },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
  canvas: { version: 1, revision: 0, cards: [] },
};
function Check() {
  const [shot, setShot] = useState(initial);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        type="button"
        id="group"
        onClick={() =>
          setShot((current) =>
            groupMaterials(
              current,
              current.nodes.map((node) => node.id),
              'group',
            ),
          )
        }
      >
        测试组
      </button>
      <button
        type="button"
        id="ungroup"
        onClick={() => setShot((current) => ungroupMaterials(current, 'group'))}
      >
        解组
      </button>
      <output id="state">{JSON.stringify(shot)}</output>
      <button type="button" id="reopen" onClick={() => setOpen(true)}>
        重开
      </button>
      <button type="button" id="reset" onClick={() => setShot(initial)}>
        重置
      </button>
      {open && (
        <MaterialCanvas
          shot={shot}
          snapshot={snapshot}
          blocked={false}
          saving={false}
          error={null}
          longPressSplit
          onChange={setShot}
          onClose={() => setOpen(false)}
          beforeClose={async () => true}
          retry={async () => true}
        />
      )}
    </>
  );
}
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <HoldFeedbackProvider>
        <Check />
      </HoldFeedbackProvider>
    </StrictMode>,
  );
