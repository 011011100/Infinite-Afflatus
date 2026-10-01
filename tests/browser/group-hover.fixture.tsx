import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HoldFeedbackProvider } from '@/components/canvas/hold-feedback';
import { MaterialCanvas } from '@/features/generation/material-canvas';
import { groupMaterials, newShot } from '../../src/shared/generation/workspace';
import type { ProjectSnapshot } from '../../src/shared/models';
import '../../src/renderer/src/styles.css';

const initial = newShot('shot', '悬停加入测试', { x: 0, y: 0 });
if (new URLSearchParams(location.search).has('zoom'))
  initial.viewport = { x: 120, y: 60, zoom: 0.6 };
initial.nodes = [
  {
    id: 'outside',
    type: 'text',
    text: '外部卡片',
    position: { x: 50, y: 190 },
  },
  {
    id: 'member',
    type: 'text',
    text: '目标组原成员',
    position: { x: 540, y: 220 },
  },
  { id: 'other', type: 'text', text: '另一组', position: { x: 960, y: 220 } },
];
const grouped = groupMaterials(
  groupMaterials(initial, ['member'], 'target'),
  ['other'],
  'second',
);
const target = grouped.groups[0];
if (target) target.parameters.duration = 12;
const snapshot: ProjectSnapshot = {
  project: { id: 'test', name: '隔离测试', folder: 'test', updatedAt: '' },
  assets: [],
  viewport: initial.viewport,
  canvas: { version: 1, revision: 0, cards: [] },
};
function Check() {
  const [shot, setShot] = useState(grouped);
  const [blocked, setBlocked] = useState(false);
  const [open, setOpen] = useState(true);
  return (
    <>
      <output id="state">{JSON.stringify(shot)}</output>
      <button type="button" id="block" onClick={() => setBlocked(true)}>
        迁移阻止编辑
      </button>
      <button type="button" id="close" onClick={() => setOpen(false)}>
        关闭
      </button>
      {open && (
        <MaterialCanvas
          shot={shot}
          snapshot={snapshot}
          blocked={blocked}
          longPressSplit
          saving={false}
          error={null}
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
