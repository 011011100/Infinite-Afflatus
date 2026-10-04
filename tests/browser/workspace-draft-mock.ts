import type { DesktopBridge } from '../../src/shared/desktop';
import type { GenerationWorkspace } from '../../src/shared/generation/workspace';
import {
  sameWorkspace,
  type WorkspaceDraftRecord,
  workspaceDraftState,
} from '../../src/shared/workspace-draft';

/** Renderer fixtures model the independent journal separately from project writes. */
export function workspaceDraftMock(read: () => GenerationWorkspace) {
  const records = new Map<string, WorkspaceDraftRecord>();
  const acknowledged = new Map<string, number>();
  const bridge: Pick<
    DesktopBridge,
    | 'protectWorkspaceDraft'
    | 'listWorkspaceDrafts'
    | 'acknowledgeWorkspaceDraft'
    | 'recoverWorkspaceDraft'
    | 'exportWorkspaceDraft'
  > = {
    protectWorkspaceDraft: async (projectId, input) => {
      const key = `${projectId}.${input.sessionId}`;
      const watermark = Math.max(
        acknowledged.get(key) ?? 0,
        records.get(key)?.seq ?? 0,
      );
      if (watermark >= input.seq) return watermark;
      records.set(key, {
        ...structuredClone(input),
        format: 'infinite-afflatus-workspace-draft',
        version: 1,
        project: { id: projectId, folder: projectId, name: '测试项目' },
        updatedAt: new Date().toISOString(),
        saved: false,
      });
      return input.seq;
    },
    listWorkspaceDrafts: async (projectId) => ({
      drafts: structuredClone(
        [...records.values()].filter((draft) => draft.project.id === projectId),
      ),
      issues: [],
    }),
    acknowledgeWorkspaceDraft: async (projectId, input) => {
      const key = `${projectId}.${input.sessionId}`;
      const record = records.get(key);
      if (!record || record.seq !== input.seq) return false;
      const current = read();
      if (
        workspaceDraftState(record, current) !== 'submitted' &&
        !(
          sameWorkspace(current, record.baseline) &&
          sameWorkspace(record.workspace, record.baseline)
        )
      )
        return false;
      records.delete(key);
      acknowledged.set(key, input.seq);
      return true;
    },
    recoverWorkspaceDraft: async () => {
      throw new Error('此fixture没有历史草稿；真实恢复由桌面回归覆盖');
    },
    exportWorkspaceDraft: async () => '/mock/镜头.afflatus-draft.json',
  };
  return { bridge, records };
}
