import { StrictMode, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@/components/ui/button';
import { ProjectEditDraftNotice } from '@/features/drafts/project-edit-draft-notice';
import { projectEditRecoveryGuards } from '@/features/drafts/project-edit-recovery-guards';
import { useProjectEditDrafts } from '@/features/drafts/use-project-edit-drafts';
import { pendingSaves } from '@/features/lifecycle/pending-saves';
import { ProjectRenameDialog } from '@/features/projects/project-rename-dialog';
import { useProjectRename } from '@/features/projects/use-project-rename';
import type { DesktopBridge } from '../../src/shared/desktop';
import type { ProjectSnapshot } from '../../src/shared/models';
import type {
  ProjectEditDraftList,
  ProjectEditDraftRecord,
} from '../../src/shared/project-edit-draft';
import '../../src/renderer/src/styles.css';

const mode = new URLSearchParams(location.search).get('mode');
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const asset = {
  id: 'video',
  name: '片段.mp4',
  relativePath: 'media/video.mp4',
  size: 100,
  sha256: 'a'.repeat(64),
  kind: 'video' as const,
};
const card = { id: 'card', position: { x: 0, y: 0 }, assetIds: [asset.id] };
const snapshot = (id = 'A'): ProjectSnapshot => ({
  project: { id, folder: id, name: `项目${id}`, updatedAt: '' },
  assets: [asset],
  canvas: { version: 1, revision: 0, cards: [card] },
  viewport: { x: 0, y: 0, zoom: 1 },
});
const draft = (id = 'A'): ProjectEditDraftRecord => ({
  format: 'infinite-afflatus-project-edit-draft',
  version: 1,
  project: snapshot(id).project,
  sessionId: `stream-${id}`,
  seq: 3,
  updatedAt: new Date().toISOString(),
  ...(mode === 'name'
    ? { kind: 'name' as const, baseline: `项目${id}`, target: `恢复名称${id}` }
    : {
        kind: 'trim' as const,
        baseline: card,
        target: { ...card, trims: { video: { start: 1, end: 4 } } },
        assets: [asset],
      }),
});
const stored = new Map<string, ProjectEditDraftRecord>([
  ['A', draft()],
  ['B', draft('B')],
]);
let delayedLists = false;
const lists: {
  id: string;
  value: ProjectEditDraftList;
  pending: ReturnType<typeof deferred<ProjectEditDraftList>>;
}[] = [];
const recoveries: {
  id: string;
  pending: ReturnType<typeof deferred<ProjectSnapshot>>;
}[] = [];
const presentations: {
  id: string;
  pending: ReturnType<typeof deferred<void>>;
}[] = [];
const accepted: string[] = [];
const exports: string[] = [];
const protections: unknown[] = [];
const acknowledgements: string[] = [];
const leaves: { done: boolean; result: boolean | null }[] = [];
let writes = 0;
const bridge: Pick<
  DesktopBridge,
  | 'listProjectEditDrafts'
  | 'recoverProjectEditDraft'
  | 'acknowledgeProjectEditDraft'
  | 'exportProjectEditDraft'
  | 'protectProjectEditDraft'
  | 'discardProjectEditDraft'
  | 'openProject'
> = {
  openProject: async (id) => snapshot(id),
  listProjectEditDrafts: async (id) => {
    const pending = deferred<ProjectEditDraftList>();
    const value = {
      drafts: stored.has(id)
        ? [structuredClone(stored.get(id) as ProjectEditDraftRecord)]
        : [],
      issues: [],
    };
    lists.push({ id, value, pending });
    if (!delayedLists) pending.resolve(value);
    return pending.promise;
  },
  recoverProjectEditDraft: async (id) => {
    const pending = deferred<ProjectSnapshot>();
    recoveries.push({ id, pending });
    return pending.promise;
  },
  acknowledgeProjectEditDraft: async (id) => {
    acknowledgements.push(id);
    stored.delete(id);
    return true;
  },
  exportProjectEditDraft: async (id) => {
    exports.push(id);
    return `/recovery-${id}.json`;
  },
  protectProjectEditDraft: async (id, input) => {
    protections.push(input);
    stored.set(id, {
      ...input,
      format: 'infinite-afflatus-project-edit-draft',
      version: 1,
      project: snapshot(id).project,
      updatedAt: '',
    });
    return input.seq;
  },
  discardProjectEditDraft: async (id, key) => {
    if (stored.get(id)?.seq !== key.seq) return false;
    stored.delete(id);
    return true;
  },
};
let current: ProjectSnapshot = snapshot();
if (mode === 'conflict')
  current = {
    ...current,
    canvas: {
      ...current.canvas,
      cards: [{ ...card, position: { x: 50, y: 0 } }],
    },
  };
let switchProject: (id: string) => void = () => {};
let recovery: ReturnType<typeof useProjectEditDrafts> | null = null;
let rename: ReturnType<typeof useProjectRename> | null = null;
Object.assign(window, {
  desktop: bridge,
  editControls: {
    state: () => ({
      current,
      lists: lists.map((item) => item.id),
      recoveries: recoveries.map((item) => item.id),
      presentations: presentations.map((item) => item.id),
      accepted,
      exports,
      protections,
      acknowledgements,
      leaves,
      writes,
      busy: recovery?.busy,
      restoring: recovery?.restoring,
      canRecover: recovery?.canRecover,
      nameEditor: rename?.editor,
    }),
    recover: (fail = false, index = recoveries.length - 1) => {
      const request = recoveries[index];
      if (!request) throw new Error('No pending native recover');
      if (fail)
        return request.pending.reject(
          new Error('原裁剪范围已变化，恢复副本已保留'),
        );
      const value = snapshot(request.id);
      const record = stored.get(request.id);
      if (!record) throw new Error('No saved draft');
      if (record.kind === 'trim')
        value.canvas = { ...value.canvas, cards: [record.target] };
      else value.project.name = record.target.trim();
      stored.delete(request.id);
      request.pending.resolve(value);
    },
    present: (index = presentations.length - 1, fail = false) => {
      const request = presentations[index];
      if (!request) throw new Error('No pending presentation');
      if (fail) request.pending.reject(new Error('刷新项目失败'));
      else request.pending.resolve();
    },
    list: (index = lists.length - 1) => {
      const request = lists[index];
      if (!request) throw new Error('No list');
      request.pending.resolve(request.value);
    },
    delayLists: (value: boolean) => {
      delayedLists = value;
    },
    switchProject: (id: string) => switchProject(id),
    leave: () => {
      const entry = { done: false, result: null as boolean | null };
      leaves.push(entry);
      const pending = pendingSaves.capturePending();
      void Promise.all([pending, pendingSaves.flush()]).then(
        ([captured, flushed]) => {
          entry.result = captured && flushed;
          entry.done = true;
        },
      );
    },
    edit: () => {
      if (!projectEditRecoveryGuards.isRecovering(current.project.id)) writes++;
    },
  },
});

function Fixture() {
  const [project, setProject] = useState(current);
  current = project;
  switchProject = (id) => setProject(snapshot(id));
  useLayoutEffect(
    () =>
      projectEditRecoveryGuards.register(
        project.project.id,
        () => true,
        (_record, value) => accepted.push(value.project.id),
      ),
    [project.project.id],
  );
  const edits = useProjectEditDrafts(
    project.project.id,
    false,
    async (_record, value) => {
      const pending = deferred<void>();
      presentations.push({ id: value.project.id, pending });
      await pending.promise;
      if (current.project.id === value.project.id) setProject(value);
    },
  );
  const names = useProjectRename(project, {
    blocked: edits.restoring,
    onSaved: async (value) => setProject(value),
    onDraftsChanged: edits.refresh,
  });
  recovery = edits;
  rename = names;
  return (
    <>
      <h1>{project.project.name}</h1>
      <Button
        onClick={() => {
          if (!projectEditRecoveryGuards.isRecovering(project.project.id))
            writes++;
        }}
      >
        编辑当前项目
      </Button>
      <ProjectEditDraftNotice
        recovery={edits}
        snapshot={project}
        blocked={false}
        activeNameSession={names.editor?.sessionId ?? null}
        nameEditing={!!names.editor}
        openName={(record) => {
          if (projectEditRecoveryGuards.canRecover(project.project.id))
            names.open(record);
        }}
      />
      <ProjectRenameDialog rename={names} />
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
