import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useProjectEditDrafts } from '@/features/drafts/use-project-edit-drafts';
import { useWorkspaceDrafts } from '@/features/drafts/use-workspace-drafts';
import { usePendingSave } from '@/features/lifecycle/use-pending-save';
import { AppSettings } from '@/features/settings/app-settings';
import type { DesktopBridge } from '../../src/shared/desktop';
import { emptyWorkspace } from '../../src/shared/generation/workspace';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type { LibraryState } from '../../src/shared/models';
import type { ProjectEditDraftRecord } from '../../src/shared/project-edit-draft';
import type {
  RescueImportPreview,
  RescueImportResult,
} from '../../src/shared/rescue-import';
import type { WorkspaceDraftRecord } from '../../src/shared/workspace-draft';
import '../../src/renderer/src/styles.css';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const project = (id = 'A') => ({
  id,
  folder: `folder-${id}`,
  name: `项目${id}`,
});
const choices: ReturnType<typeof deferred<RescueImportPreview | null>>[] = [];
const confirmations: {
  preview: RescueImportPreview;
  pending: ReturnType<typeof deferred<RescueImportResult>>;
}[] = [];
const offered = new Map<string, RescueImportPreview>();
const workspace = new Map<string, WorkspaceDraftRecord[]>();
const edits = new Map<string, ProjectEditDraftRecord[]>();
const lists: { id: string; kind: string }[] = [];
let cancels = 0;
let flushes = 0;
let protections = 0;
let restores = 0;
let show: (value: boolean) => void = () => {};
let setDraft: (value: string) => void = () => {};
let block: (value: boolean) => void = () => {};
const bridge: Pick<
  DesktopBridge,
  | 'chooseRescueImport'
  | 'confirmRescueImport'
  | 'cancelRescueImport'
  | 'listWorkspaceDrafts'
  | 'listProjectEditDrafts'
  | 'protectWorkspaceDraft'
  | 'acknowledgeWorkspaceDraft'
  | 'recoverWorkspaceDraft'
  | 'recoverProjectEditDraft'
  | 'getAppBackups'
  | 'getMediaToolSettings'
> = {
  chooseRescueImport: async () => {
    const pending = deferred<RescueImportPreview | null>();
    choices.push(pending);
    return pending.promise;
  },
  confirmRescueImport: async (token) => {
    const preview = offered.get(token);
    if (!preview) throw new Error('预览无效');
    const pending = deferred<RescueImportResult>();
    confirmations.push({ preview, pending });
    return pending.promise;
  },
  cancelRescueImport: async () => {
    cancels++;
  },
  listWorkspaceDrafts: async (id) => {
    lists.push({ id, kind: 'workspace' });
    return { drafts: structuredClone(workspace.get(id) ?? []), issues: [] };
  },
  listProjectEditDrafts: async (id) => {
    lists.push({ id, kind: 'edit' });
    return { drafts: structuredClone(edits.get(id) ?? []), issues: [] };
  },
  protectWorkspaceDraft: async (_id, input) => {
    protections++;
    return input.seq;
  },
  acknowledgeWorkspaceDraft: async () => {
    protections++;
    return true;
  },
  recoverWorkspaceDraft: async () => {
    restores++;
    throw new Error('Import must not restore');
  },
  recoverProjectEditDraft: async () => {
    restores++;
    throw new Error('Import must not restore');
  },
  getAppBackups: async () => ({
    directory: '/fixture/app-backups',
    backups: [],
    issues: [],
    recovery: null,
  }),
  getMediaToolSettings: async () => ({
    paths: { ffmpeg: null, ffprobe: null },
    locations: {
      ffmpeg: { name: 'ffmpeg', command: 'ffmpeg', source: 'path' },
      ffprobe: { name: 'ffprobe', command: 'ffprobe', source: 'path' },
    },
    error: null,
  }),
};
Object.assign(window, {
  desktop: bridge,
  rescueControls: {
    state: () => ({
      choices: choices.length,
      confirmations: confirmations.length,
      cancels,
      lists,
      flushes,
      protections,
      restores,
    }),
    choose: (
      index = choices.length - 1,
      options: Partial<RescueImportPreview> | null = {},
    ) => {
      const request = choices[index];
      if (!request) throw new Error('No chooser');
      if (options === null) return request.resolve(null);
      const preview: RescueImportPreview = {
        token: `preview-${index}`,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        kind: 'workspace',
        sourceName: '镜头.afflatus-draft.json',
        sourceBytes: 1234,
        project: project(),
        updatedAt: '2026-10-05T08:00:00.000Z',
        state: 'matching',
        referenceCount: 2,
        shotCount: 3,
        nameTarget: null,
        nameBaseline: null,
        cardId: null,
        ...options,
      };
      offered.set(preview.token, preview);
      request.resolve(preview);
    },
    failChoose: (message: string) => choices.at(-1)?.reject(new Error(message)),
    confirm: (index = confirmations.length - 1, duplicate = false) => {
      const request = confirmations[index];
      if (!request) throw new Error('No confirmation');
      const { preview } = request;
      const sessionId = `imported-${index}`;
      if (preview.kind === 'workspace') {
        workspace.set(preview.project.id, [
          {
            format: 'infinite-afflatus-workspace-draft',
            version: 1,
            project: preview.project,
            updatedAt: preview.updatedAt,
            sessionId,
            seq: 1,
            saved: false,
            baseline: emptyWorkspace(),
            workspace: emptyWorkspace(),
          },
        ]);
      } else if (preview.kind === 'name') {
        edits.set(preview.project.id, [
          {
            format: 'infinite-afflatus-project-edit-draft',
            version: 1,
            project: preview.project,
            updatedAt: preview.updatedAt,
            sessionId,
            seq: 1,
            kind: 'name',
            baseline: preview.nameBaseline ?? '原名称',
            target: preview.nameTarget ?? '新名称',
          },
        ]);
      }
      request.pending.resolve({
        projectId: preview.project.id,
        kind: preview.kind,
        key: { sessionId, seq: 1 },
        duplicate,
      });
    },
    failConfirm: () =>
      confirmations
        .at(-1)
        ?.pending.reject(new Error('文件已经变化，请重新选择检查')),
    show: (value: boolean) => show(value),
    edit: (value: string) => setDraft(value),
    block: (value: boolean) => block(value),
  },
});
const library: LibraryState = {
  root: '/fixture/projects',
  projects: [project(), project('B')].map((p) => ({ ...p, updatedAt: '' })),
  jobs: [],
  migration: null,
  writeBlocked: false,
  interactions: defaultInteractionSettings(),
};
function CurrentEditors() {
  const shots = useWorkspaceDrafts('A');
  const names = useProjectEditDrafts('A', false, async () => {
    restores++;
  });
  const [text, setText] = useState('尚未保存的文字');
  setDraft = setText;
  usePendingSave('fixture当前文字', async () => {
    flushes++;
    return true;
  });
  return (
    <aside>
      <textarea
        aria-label="当前未保存文字"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <output data-draft-counts>
        {shots.drafts.length}:{names.drafts.length}
      </output>
    </aside>
  );
}
function Fixture() {
  const [visible, setVisible] = useState(true);
  const [blocked, setBlocked] = useState(false);
  show = setVisible;
  block = setBlocked;
  return (
    <>
      <CurrentEditors />
      {visible && (
        <AppSettings
          library={{ ...library, writeBlocked: blocked }}
          currentProjectId="A"
          onClose={() => setVisible(false)}
          run={async (operation) => {
            await operation();
          }}
          error={null}
        />
      )}
    </>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
