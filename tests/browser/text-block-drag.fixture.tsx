import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GroupStage } from '@/features/generation/group-stage';
import {
  detachMaterial,
  groupMaterials,
} from '../../src/shared/generation/material-groups';
import { newShot } from '../../src/shared/generation/workspace';
import '../../src/renderer/src/styles.css';

const initial = newShot('shot', '拖动回归', { x: 0, y: 0 });
const count = Number(new URLSearchParams(location.search).get('count') ?? 3);
initial.nodes = Array.from({ length: count }, (_, i) => ({
  id: `text-${i + 1}`,
  type: 'text',
  text: `独立文本 ${i + 1}`,
  position: { x: i * 300, y: 0 },
}));
const grouped = groupMaterials(
  initial,
  initial.nodes.map((node) => node.id),
  'group',
);
function Check() {
  const [shot, update] = useState(grouped);
  const [open, setOpen] = useState(true);
  const group = shot.groups[0];
  return (
    <>
      <output id="saved-state">{JSON.stringify(shot.nodes)}</output>
      <button type="button" id="reopen" onClick={() => setOpen(true)}>
        打开
      </button>
      {open && group && (
        <GroupStage
          shot={shot}
          group={group}
          assets={[]}
          projectId="isolated-test"
          disabled={false}
          saving={false}
          error={null}
          origin={() => ({ x: 50, y: 50, width: 300, height: 200 })}
          update={update}
          detach={(id, at) => update((s) => detachMaterial(s, id, at))}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Fixture root is missing');
createRoot(root).render(
  <StrictMode>
    <Check />
  </StrictMode>,
);
