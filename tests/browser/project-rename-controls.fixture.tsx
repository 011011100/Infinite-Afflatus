import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@/components/ui/button';
import { projectEditRecoveryGuards } from '@/features/drafts/project-edit-recovery-guards';
import { pendingSaves } from '@/features/lifecycle/pending-saves';
import { ProjectRenameDialog } from '@/features/projects/project-rename-dialog';
import { useProjectRename } from '@/features/projects/use-project-rename';
import type { DesktopBridge } from '../../src/shared/desktop';
import type { ProjectSnapshot } from '../../src/shared/models';
import type {
  NameEditDraftInput,
  ProjectEditDraftKey,
  ProjectEditDraftRecord,
} from '../../src/shared/project-edit-draft';
import '../../src/renderer/src/styles.css';

const project = {
  id: 'project',
  folder: 'project',
  name: '原名称',
  updatedAt: '',
};
const snapshot = (name: string): ProjectSnapshot => ({
  project: { ...project, name },
  assets: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  canvas: { version: 1, revision: 0, cards: [] },
});
const record = (input: NameEditDraftInput): ProjectEditDraftRecord => ({
  ...input,
  format: 'infinite-afflatus-project-edit-draft',
  version: 1,
  project,
  updatedAt: new Date().toISOString(),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let stored: ProjectEditDraftRecord | null = null;
let saved = snapshot(project.name);
let refreshes = 0;
let refreshFails = false;
let readFails = false;
const reads: string[] = [];
const protections: {
  input: NameEditDraftInput;
  pending: ReturnType<typeof deferred<number>>;
}[] = [];
const discards: {
  key: ProjectEditDraftKey;
  pending: ReturnType<typeof deferred<boolean>>;
}[] = [];
const recoveries: {
  key: ProjectEditDraftKey;
  pending: ReturnType<typeof deferred<ProjectSnapshot>>;
}[] = [];
const exports: unknown[] = [];
const bridge: Pick<
  DesktopBridge,
  | 'protectProjectEditDraft'
  | 'recoverProjectEditDraft'
  | 'acknowledgeProjectEditDraft'
  | 'discardProjectEditDraft'
  | 'exportProjectEditDraft'
  | 'listProjectEditDrafts'
  | 'openProject'
> = {
  openProject: async () => {
    reads.push(saved.project.name);
    if (readFails) throw new Error('项目读取暂不可用');
    return structuredClone(saved);
  },
  protectProjectEditDraft: async (_id, input) => {
    if (input.kind !== 'name') throw new Error('Wrong kind');
    const pending = deferred<number>();
    protections.push({ input: structuredClone(input), pending });
    return pending.promise;
  },
  listProjectEditDrafts: async () => ({
    drafts: stored ? [structuredClone(stored)] : [],
    issues: [],
  }),
  recoverProjectEditDraft: async (_id, key) => {
    const pending = deferred<ProjectSnapshot>();
    recoveries.push({ key, pending });
    return pending.promise;
  },
  acknowledgeProjectEditDraft: async (_id, key) => {
    if (
      stored?.kind !== 'name' ||
      stored.seq !== key.seq ||
      stored.target.trim() !== saved.project.name
    )
      return false;
    stored = null;
    return true;
  },
  discardProjectEditDraft: async (_id, key) => {
    const pending = deferred<boolean>();
    discards.push({ key, pending });
    return pending.promise;
  },
  exportProjectEditDraft: async (_id, input) => {
    exports.push(input);
    return '/name-recovery.json';
  },
};
let editor: ReturnType<typeof useProjectRename> | null = null;
let show: (value: boolean) => void = () => {};
let refresh: (value: ProjectSnapshot) => void = () => {};
let block: (value: boolean) => void = () => {};
let endRecovery: (() => void) | null = null;
Object.assign(window, {
  desktop: bridge,
  nameControls: {
    state: () => ({
      protections: protections.map((p) => p.input),
      discards: discards.map((p) => p.key),
      recoveries: recoveries.map((p) => p.key),
      stored,
      saved,
      refreshes,
      reads,
      exports,
      editor: editor?.editor,
    }),
    input: (value: string) => editor?.setValue(value),
    open: () => editor?.open(),
    restore: () => {
      const draft = record({
        kind: 'name',
        sessionId: 'restore-session',
        seq: 9,
        baseline: project.name,
        target: '恢复的输入',
      });
      stored = draft;
      return editor?.open(draft);
    },
    protect: (index = protections.length - 1, fail = false) => {
      const request = protections[index];
      if (!request) throw new Error('No protection');
      if (fail) return request.pending.reject(new Error('磁盘空间不足'));
      stored = record(request.input);
      request.pending.resolve(request.input.seq);
    },
    discard: (success = true) => {
      const request = discards.at(-1);
      if (!request) throw new Error('No discard');
      if (success) {
        if (stored?.seq !== request.key.seq)
          throw new Error('Wrong discard sequence');
        stored = null;
      }
      request.pending.resolve(success);
    },
    recover: (fail = false, lostReply = false) => {
      const request = recoveries.at(-1);
      if (!request || stored?.kind !== 'name' || request.key.seq !== stored.seq)
        throw new Error('No matching recovery');
      if (fail)
        return request.pending.reject(
          new Error('项目名称已变化，恢复副本已保留'),
        );
      saved = snapshot(stored.target.trim());
      stored = null;
      if (lostReply) return request.pending.reject(new Error('保存回执丢失'));
      request.pending.resolve(saved);
    },
    flush: () => pendingSaves.flush(),
    capture: () => pendingSaves.capturePending(),
    refresh: (name = project.name) => refresh(snapshot(name)),
    block: (value: boolean) => block(value),
    show: (value: boolean) => show(value),
    failRefresh: (value: boolean) => {
      refreshFails = value;
    },
    failRead: (value: boolean) => {
      readFails = value;
    },
    recovering: (value: boolean) => {
      if (value) endRecovery = projectEditRecoveryGuards.begin(project.id);
      else {
        endRecovery?.();
        endRecovery = null;
      }
    },
  },
});

function Editor() {
  const [current, setCurrent] = useState(saved);
  const [blocked, setBlocked] = useState(false);
  refresh = setCurrent;
  block = setBlocked;
  const rename = useProjectRename(current, {
    blocked,
    onSaved: async (next) => {
      refreshes++;
      if (refreshFails) throw new Error('项目已保存，刷新暂时失败');
      setCurrent(next);
    },
    onDraftsChanged: () => {},
  });
  editor = rename;
  return (
    <>
      <h1>{current.project.name}</h1>
      <Button onClick={() => rename.open()}>修改项目名称</Button>
      <ProjectRenameDialog
        rename={rename}
        unavailableNotice={
          blocked ? <p role="alert">项目暂时不可用，请重试读取。</p> : null
        }
      />
    </>
  );
}
function Fixture() {
  const [visible, setVisible] = useState(true);
  show = setVisible;
  return visible ? <Editor /> : <p>已卸载名称编辑</p>;
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
