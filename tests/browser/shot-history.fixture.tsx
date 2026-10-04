import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HoldFeedbackProvider } from '@/components/canvas/hold-feedback';
import { MaterialCanvas } from '@/features/generation/material-canvas';
import { useShotWorkspace } from '@/features/generation/use-shot-workspace';
import type { DesktopBridge } from '../../src/shared/desktop';
import {
  emptyWorkspace,
  groupMaterials,
  newShot,
} from '../../src/shared/generation/workspace';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type { ProjectSnapshot } from '../../src/shared/models';
import { workspaceDraftMock } from './workspace-draft-mock';
import '../../src/renderer/src/styles.css';

const initial = newShot('one', '镜头一', { x: 10, y: 20 });
initial.nodes = [
  {
    id: 'text-one',
    type: 'text',
    text: '第一段自写文本',
    position: { x: 100, y: 130 },
  },
  {
    id: 'text-two',
    type: 'text',
    text: '第二段自写文本',
    position: { x: 420, y: 130 },
  },
  {
    id: 'image',
    type: 'asset',
    assetId: 'image',
    position: { x: 740, y: 130 },
  },
];
initial.labels = [
  {
    id: 'label',
    name: '场景',
    color: '#336699',
    pinned: false,
    position: { x: 100, y: 550 },
  },
];
let stored = {
  ...emptyWorkspace(),
  shots: [initial, newShot('two', '镜头二', { x: 300, y: 600 })],
};
let failing = false;
let writes = 0;
window.desktop = {
  ...workspaceDraftMock(() => stored).bridge,
  getGenerationWorkspace: async () => structuredClone(stored),
  saveGenerationWorkspace: async (_id, workspace) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (failing) throw new Error('模拟磁盘写入失败');
    stored = { ...structuredClone(workspace), revision: stored.revision + 1 };
    writes++;
    return structuredClone(stored);
  },
  importReferences: async () => ({ assetIds: ['imported'], errors: [] }),
  readReferenceText: async () => '磁盘文本保持不变',
} as DesktopBridge;
const snapshot: ProjectSnapshot = {
  project: {
    id: 'project',
    folder: 'project',
    name: '历史测试',
    updatedAt: '',
  },
  viewport: { x: 0, y: 0, zoom: 1 },
  canvas: { version: 1, revision: 0, cards: [] },
  assets: [
    {
      id: 'image',
      name: 'image.png',
      relativePath: 'image.png',
      kind: 'image',
      sha256: '',
      size: 0,
    },
    {
      id: 'imported',
      name: 'imported.txt',
      relativePath: 'imported.txt',
      kind: 'text',
      sha256: '',
      size: 0,
    },
  ],
};

function Check() {
  const [blocked, setBlocked] = useState(false);
  const [shortcuts, setShortcuts] = useState(
    defaultInteractionSettings().shortcuts,
  );
  const [flushed, setFlushed] = useState<boolean | null>(null);
  const shots = useShotWorkspace('project', blocked);
  const opened = useRef(false);
  useEffect(() => {
    if (shots.loaded && !opened.current) {
      opened.current = true;
      shots.open('one');
    }
  }, [shots.loaded, shots.open]);
  const active = shots.activeShot;
  return (
    <>
      <output id="state">
        {JSON.stringify({
          shots: shots.shots,
          active: shots.activeId,
          firstHistory: shots.historyFor('one'),
          secondHistory: shots.historyFor('two'),
          saving: shots.saving,
          error: shots.error,
          flushed,
          writes,
          stored,
        })}
      </output>
      <button id="open-one" type="button" onClick={() => shots.open('one')}>
        镜头一
      </button>
      <button id="open-two" type="button" onClick={() => shots.open('two')}>
        镜头二
      </button>
      <button
        id="group"
        type="button"
        onClick={() =>
          shots.updateShot('one', (shot) =>
            groupMaterials(shot, ['text-one', 'text-two'], 'group'),
          )
        }
      >
        组成视频组
      </button>
      <button
        id="image-group"
        type="button"
        onClick={() =>
          shots.updateShot('one', (shot) =>
            groupMaterials(shot, ['image'], 'image-group'),
          )
        }
      >
        无文字视频组
      </button>
      <button
        id="external-undo"
        type="button"
        onClick={() => shots.historyFor('one').undo()}
      >
        测试外部恢复
      </button>
      <button
        id="view-change"
        type="button"
        onClick={() =>
          shots.updateShot('one', (shot) => ({
            ...shot,
            position: { x: 700, y: 800 },
            viewport: { x: 12, y: 34, zoom: 1.2 },
          }))
        }
      >
        移动视角
      </button>
      <button
        id="space-shortcut"
        type="button"
        onClick={() =>
          setShortcuts((value) => ({
            ...value,
            play: null,
            undo: { key: 'Space', mod: false, alt: false, shift: false },
          }))
        }
      >
        空格撤销
      </button>
      <button
        id="default-shortcuts"
        type="button"
        onClick={() => setShortcuts(defaultInteractionSettings().shortcuts)}
      >
        默认快捷键
      </button>
      <button
        id="fail"
        type="button"
        onClick={() => {
          failing = true;
        }}
      >
        写入失败
      </button>
      <button
        id="recover"
        type="button"
        onClick={() => {
          failing = false;
        }}
      >
        恢复写入
      </button>
      <button
        id="flush"
        type="button"
        onClick={() => void shots.flush().then(setFlushed)}
      >
        保存
      </button>
      <button
        id="blocked"
        type="button"
        onClick={() => setBlocked((value) => !value)}
      >
        切换迁移
      </button>
      {active && (
        <MaterialCanvas
          key={active.id}
          shot={active}
          snapshot={snapshot}
          blocked={blocked}
          longPressSplit
          saving={shots.saving}
          error={shots.error}
          history={shots.historyFor(active.id)}
          shortcuts={shortcuts}
          onChange={(update, options) =>
            shots.updateShot(active.id, update, options)
          }
          onClose={shots.dismiss}
          beforeClose={shots.flush}
          retry={shots.retry}
        />
      )}
    </>
  );
}
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <HoldFeedbackProvider>
      <Check />
    </HoldFeedbackProvider>,
  );
