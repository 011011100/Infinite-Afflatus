import type { DesktopBridge } from '../../src/shared/desktop';
import type { ProjectSnapshot } from '../../src/shared/models';
import {
  type ProjectEditDraftRecord,
  projectEditDraftState,
} from '../../src/shared/project-edit-draft';

/** Typed renderer-only journal; native durability is covered by the service and desktop tests. */
export function projectEditDraftMock(read: () => ProjectSnapshot) {
  const records = new Map<string, ProjectEditDraftRecord>();
  const acknowledged = new Map<string, number>();
  const bridge: Pick<
    DesktopBridge,
    'protectProjectEditDraft' | 'acknowledgeProjectEditDraft'
  > = {
    protectProjectEditDraft: async (_id, input) => {
      const watermark = Math.max(
        records.get(input.sessionId)?.seq ?? 0,
        acknowledged.get(input.sessionId) ?? 0,
      );
      if (watermark >= input.seq) return watermark;
      records.set(input.sessionId, {
        ...structuredClone(input),
        format: 'infinite-afflatus-project-edit-draft',
        version: 1,
        project: read().project,
        updatedAt: '',
      });
      return input.seq;
    },
    acknowledgeProjectEditDraft: async (_id, key) => {
      const record = records.get(key.sessionId);
      if (
        !record ||
        record.seq !== key.seq ||
        projectEditDraftState(record, read()) !== 'submitted'
      )
        return false;
      records.delete(key.sessionId);
      acknowledged.set(key.sessionId, key.seq);
      return true;
    },
  };
  return { bridge, records };
}
