import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Modal } from '@/components/ui/modal';
import { MaterialCanvas } from '@/features/generation/material-canvas';
import { AppSettings } from '@/features/settings/app-settings';
import { useInputMethod } from '@/lib/input-method';
import { newShot } from '../../src/shared/generation/workspace';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type { LibraryState, ProjectSnapshot } from '../../src/shared/models';
import { referenceImportMock } from './reference-import-mock';
import '../../src/renderer/src/styles.css';

Object.assign(window, { desktop: referenceImportMock().bridge });

const library: LibraryState = {
  root: '/isolated-motion-test',
  projects: [],
  jobs: [],
  migration: null,
  writeBlocked: false,
  interactions: defaultInteractionSettings(),
};
const snapshot: ProjectSnapshot = {
  project: { id: 'test', name: '隔离动效验证', folder: 'test', updatedAt: '' },
  assets: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  canvas: { version: 1, revision: 0, cards: [] },
};
function Check() {
  useInputMethod();
  const [surface, setSurface] = useState('');
  const [shot, setShot] = useState(() =>
    newShot('test', '测试镜头', { x: 0, y: 0 }),
  );
  const [error, setError] = useState<string | null>(null);
  const [saves, setSaves] = useState(0);
  const [closed, setClosed] = useState(0);
  const resolveSave = useRef<(success: boolean) => void>(() => {});
  const close = () => {
    setClosed((count) => count + 1);
    setSurface('');
  };
  return (
    <main className="h-full bg-canvas p-8">
      <div className="flex gap-3">
        <Button
          id="open-page"
          onClick={() => {
            setError(null);
            setSurface('page');
          }}
        >
          素材画布
        </Button>
        <Button id="open-modal" onClick={() => setSurface('modal')}>
          弹窗
        </Button>
        <Button id="open-settings" onClick={() => setSurface('settings')}>
          设置
        </Button>
        <ContextMenu>
          <ContextMenuTrigger
            className="rounded-lg border p-2"
            id="menu-target"
          >
            右键菜单
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem id="menu-action">生成视频</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
      <output id="counts">{JSON.stringify({ saves, closed })}</output>
      <button
        type="button"
        hidden
        id="save-ok"
        onClick={() => resolveSave.current(true)}
      >
        保存成功
      </button>
      <button
        type="button"
        hidden
        id="save-fail"
        onClick={() => {
          setError('测试保存失败');
          resolveSave.current(false);
        }}
      >
        保存失败
      </button>
      <button
        type="button"
        hidden
        id="unmount-page"
        onClick={() => setSurface('')}
      >
        模拟外部卸载
      </button>
      {surface === 'page' && (
        <MaterialCanvas
          shot={shot}
          snapshot={snapshot}
          blocked={false}
          saving={false}
          error={error}
          longPressSplit
          onChange={setShot}
          onClose={close}
          retry={async () => true}
          beforeClose={() => {
            setSaves((count) => count + 1);
            return new Promise((resolve) => {
              resolveSave.current = resolve;
            });
          }}
        />
      )}
      {surface === 'modal' && (
        <Modal title="弹窗测试" onClose={close}>
          {(requestClose) => (
            <Button id="footer-close" onClick={requestClose}>
              取消
            </Button>
          )}
        </Modal>
      )}
      {surface === 'settings' && (
        <AppSettings
          library={library}
          error={null}
          run={async (operation) => {
            await operation();
          }}
          onClose={close}
        />
      )}
    </main>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Fixture root is missing');
createRoot(root).render(
  <StrictMode>
    <Check />
  </StrictMode>,
);
