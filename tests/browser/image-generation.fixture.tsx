import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HoldFeedbackProvider } from '@/components/canvas/hold-feedback';
import { MaterialCanvas } from '@/features/generation/material-canvas';
import { newShot } from '../../src/shared/generation/workspace';
import type { Asset, ProjectSnapshot } from '../../src/shared/models';
import { referenceImportMock } from './reference-import-mock';
import '../../src/renderer/src/styles.css';

Object.assign(window, { desktop: referenceImportMock().bridge });

const queryKind = new URLSearchParams(location.search).get('asset');
const kind: Asset['kind'] =
  queryKind === 'video' || queryKind === 'audio' ? queryKind : 'image';
const initial = newShot('image-shot', '图片生成交互测试', { x: 0, y: 0 });
initial.nodes = [
  {
    id: 'text',
    type: 'text',
    text: '蓝色圆球放在浅色桌面上，柔和的自然光。',
    position: { x: 110, y: 150 },
  },
  {
    id: 'reference',
    type: 'asset',
    assetId: 'reference-asset',
    position: { x: 470, y: 150 },
  },
];
const snapshot: ProjectSnapshot = {
  project: { id: 'test', name: '隔离测试', folder: 'test', updatedAt: '' },
  assets: [
    {
      id: 'reference-asset',
      name: `合成参考.${kind === 'image' ? 'svg' : 'wav'}`,
      kind,
      relativePath: `reference.${kind === 'image' ? 'svg' : 'wav'}`,
      size: 0,
      sha256: '',
    },
  ],
  viewport: initial.viewport,
  canvas: { version: 1, revision: 0, cards: [] },
};

function Check() {
  const [shot, setShot] = useState(initial);
  const [open, setOpen] = useState(true);
  return (
    <>
      <output id="state">{JSON.stringify(shot)}</output>
      {open && (
        <MaterialCanvas
          shot={shot}
          snapshot={snapshot}
          blocked={false}
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
