import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useShotWorkspace } from '@/features/generation/use-shot-workspace';
import { SaveLifecycleStatus } from '@/features/lifecycle/save-lifecycle-status';
import { usePendingSave } from '@/features/lifecycle/use-pending-save';
import { useSaveLifecycle } from '@/features/lifecycle/use-save-lifecycle';
import type { DesktopBridge } from '../../src/shared/desktop';
import { emptyWorkspace, newShot } from '../../src/shared/generation/workspace';
import { referenceImportMock } from './reference-import-mock';
import { workspaceDraftMock } from './workspace-draft-mock';
import '../../src/renderer/src/styles.css';

const original = {
  ...emptyWorkspace(),
  shots: [newShot('shot', 'original', { x: 0, y: 0 })],
};
let stored = structuredClone(original);
let failing = false;
let nativeClose: (() => Promise<boolean>) | null = null;
let cancelClose: (() => void) | null = null;
let releaseSlowSave: (() => void) | null = null;
let holdNextSave = false;
let requestCount = 0;
let writes = 0;
let gate: Promise<unknown> | null = null;
let releaseHealth: (() => void) | null = null;
let releasePackage: (() => void) | null = null;
let releaseExport: (() => void) | null = null;
const drafts = workspaceDraftMock(() => stored);
window.desktop = {
  ...referenceImportMock().bridge,
  ...drafts.bridge,
  cancelProjectHealth: async () => releaseHealth?.(),
  cancelProjectPackage: async () => releasePackage?.(),
  cancelExportPreparation: async () => releaseExport?.(),
  getGenerationWorkspace: async () => structuredClone(stored),
  saveGenerationWorkspace: async (_projectId, workspace) => {
    writes += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (failing) throw new Error('测试磁盘不可写');
    stored = { ...structuredClone(workspace), revision: stored.revision + 1 };
    return structuredClone(stored);
  },
  onSaveBeforeLeave: (listener) => {
    nativeClose = listener;
    return () => {
      nativeClose = null;
    };
  },
  onLeaveCancelled: (listener) => {
    cancelClose = listener;
    return () => {
      cancelClose = null;
    };
  },
} as DesktopBridge;

function Editor() {
  const shots = useShotWorkspace('project', false);
  return (
    <>
      <output id="draft">{shots.shots[0]?.name}</output>
      <button
        type="button"
        id="edit"
        disabled={!shots.loaded}
        onClick={() =>
          shots.updateShot('shot', (shot) => ({
            ...shot,
            name: 'unsaved draft',
          }))
        }
      >
        Edit
      </button>
      <button
        type="button"
        id="edit-again"
        onClick={() =>
          shots.updateShot('shot', (shot) => ({
            ...shot,
            name: 'draft after timeout',
          }))
        }
      >
        Edit after timeout
      </button>
    </>
  );
}
function Check() {
  const lifecycle = useSaveLifecycle();
  const [open, setOpen] = useState(true);
  const [result, setResult] = useState('');
  const [nativeResults, setNativeResults] = useState<
    { request: number; saved: boolean; name: string | undefined }[]
  >([]);
  usePendingSave(
    'writer behind long-running read/copy gate',
    async () => {
      await gate;
      return true;
    },
    -20,
  );
  usePendingSave(
    'slow editor after the shot',
    async () => {
      if (!holdNextSave) return true;
      holdNextSave = false;
      await new Promise<void>((resolve) => {
        releaseSlowSave = resolve;
      });
      return true;
    },
    20,
  );
  const snapshot = () =>
    setResult(
      JSON.stringify({
        name: stored.shots[0]?.name,
        writes,
        recoveryDrafts: drafts.records.size,
      }),
    );
  return (
    <>
      {open && <Editor />}
      <output id="page">{open ? 'editor' : 'home'}</output>
      <output id="result">{result}</output>
      <output id="native-results">{JSON.stringify(nativeResults)}</output>
      <button
        type="button"
        id="hold-gate"
        onClick={() => {
          gate = Promise.all([
            new Promise<void>((resolve) => {
              releaseHealth = resolve;
            }),
            new Promise<void>((resolve) => {
              releasePackage = resolve;
            }),
            new Promise<void>((resolve) => {
              releaseExport = resolve;
            }),
          ]);
        }}
      >
        Hold read/copy gate
      </button>
      <button
        type="button"
        id="hold-save"
        onClick={() => {
          holdNextSave = true;
        }}
      >
        Hold next save
      </button>
      <button type="button" id="timeout-close" onClick={() => cancelClose?.()}>
        Timeout native close
      </button>
      <button
        type="button"
        id="release-save"
        onClick={() => releaseSlowSave?.()}
      >
        Release slow save
      </button>
      <button
        type="button"
        id="fail"
        onClick={() => {
          failing = true;
        }}
      >
        Fail writes
      </button>
      <button
        type="button"
        id="recover"
        onClick={() => {
          failing = false;
        }}
      >
        Recover writes
      </button>
      <button
        type="button"
        id="home"
        onClick={() =>
          void lifecycle.prepare().then((saved) => {
            if (saved) setOpen(false);
            snapshot();
          })
        }
      >
        Home
      </button>
      <button
        type="button"
        id="native-close"
        onClick={() => {
          const request = ++requestCount;
          void nativeClose?.().then((saved) => {
            setResult(JSON.stringify({ saved, name: stored.shots[0]?.name }));
            setNativeResults((results) => [
              ...results,
              { request, saved, name: stored.shots[0]?.name },
            ]);
          });
        }}
      >
        Native close
      </button>
      <SaveLifecycleStatus {...lifecycle} />
    </>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Check />);
