import type { GenerationWorkspace } from '../../shared/generation/workspace';
import type { ProjectSummary } from '../../shared/models';
import {
  sameWorkspace,
  type WorkspaceDraftList,
  type WorkspaceDraftRecord,
  workspaceDraftState,
} from '../../shared/workspace-draft';
import { errorMessage } from '../storage/database';
import { DraftFiles } from './draft-files';
import { draftId, draftInput, draftKey, draftRecord } from './draft-validation';
import { exportDraft } from './export-draft';

/** Independent of the library database, project volume and project write gate. */
export class WorkspaceDraftService {
  readonly files: DraftFiles;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private active = new Set<Promise<unknown>>();
  private acknowledged = new Map<string, number>();
  constructor(userData: string) {
    this.files = new DraftFiles(userData);
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('恢复草稿服务正在关闭'));
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => undefined);
    return pending;
  }

  private name(projectId: string, sessionId: string) {
    return `${draftId(projectId)}.${draftId(sessionId)}.json`;
  }

  protect(project: ProjectSummary, input: unknown) {
    const value = draftInput(input);
    const record = draftRecord({
      ...value,
      format: 'infinite-afflatus-workspace-draft',
      version: 1,
      project,
      updatedAt: new Date().toISOString(),
      saved: false,
    });
    return this.run(async () => {
      const name = this.name(project.id, value.sessionId);
      const acknowledged = this.acknowledged.get(name) ?? 0;
      if (acknowledged >= value.seq) return acknowledged;
      const previous = await this.files.read(name);
      if (previous && previous.seq > value.seq) return previous.seq;
      if (previous?.seq === value.seq) {
        if (
          !sameWorkspace(previous.baseline, value.baseline) ||
          !sameWorkspace(previous.workspace, value.workspace) ||
          JSON.stringify(previous.lastSubmitted) !==
            JSON.stringify(value.lastSubmitted)
        )
          throw new Error('相同草稿顺序不能替换不同内容');
        return previous.seq;
      }
      if (previous && previous.project.folder !== project.folder)
        throw new Error('恢复草稿项目身份已变化，原草稿已保留');
      await this.files.write(name, record, previous);
      return record.seq;
    });
  }

  list(projectId: string): Promise<WorkspaceDraftList> {
    const prefix = `${draftId(projectId)}.`;
    return this.run(async () => {
      const result: WorkspaceDraftList = { drafts: [], issues: [] };
      for (const name of await this.files.entries()) {
        if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
        try {
          const record = await this.files.read(name);
          if (
            !record ||
            name !== this.name(record.project.id, record.sessionId)
          )
            throw new Error('恢复草稿文件与项目身份不匹配，原文件已保留');
          if (!record.saved) result.drafts.push(record);
        } catch (reason) {
          result.issues.push({ file: name, message: errorMessage(reason) });
        }
      }
      result.drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return result;
    });
  }

  get(projectId: string, input: unknown): Promise<WorkspaceDraftRecord> {
    const key = draftKey(input);
    return this.run(async () => {
      const record = await this.files.read(this.name(projectId, key.sessionId));
      if (!record || record.seq !== key.seq || record.project.id !== projectId)
        throw new Error('恢复草稿已变化，请刷新后重试');
      return record;
    });
  }

  acknowledge(
    projectId: string,
    input: unknown,
    committed: GenerationWorkspace,
  ) {
    const key = draftKey(input);
    return this.run(async () => {
      const name = this.name(projectId, key.sessionId);
      const record = await this.files.read(name);
      if (!record || record.seq !== key.seq) return false;
      if (record.saved) return true;
      const state = workspaceDraftState(record, committed);
      if (
        state !== 'submitted' &&
        !(
          state === 'matching' &&
          sameWorkspace(record.workspace, record.baseline)
        )
      )
        return false;
      // IPC from a terminated renderer cannot cross a main-process restart. A
      // process-local watermark prevents late writes without accumulating files
      // for every successfully saved editing session.
      this.acknowledged.set(name, record.seq);
      await this.files.remove(name, record.seq);
      return true;
    });
  }

  recover(
    project: ProjectSummary,
    input: unknown,
    read: () => Promise<GenerationWorkspace>,
    restore: (
      baseline: GenerationWorkspace,
      workspace: GenerationWorkspace,
    ) => Promise<GenerationWorkspace>,
  ) {
    const operation = this.restore(project, input, read, restore);
    this.active.add(operation);
    void operation
      .finally(() => this.active.delete(operation))
      .catch(() => undefined);
    return operation;
  }

  private async restore(
    project: ProjectSummary,
    input: unknown,
    read: () => Promise<GenerationWorkspace>,
    restore: (
      baseline: GenerationWorkspace,
      workspace: GenerationWorkspace,
    ) => Promise<GenerationWorkspace>,
  ) {
    const record = await this.get(project.id, input);
    if (record.project.folder !== project.folder)
      throw new Error('恢复草稿项目身份不匹配');
    const current = await read();
    const state = workspaceDraftState(record, current);
    if (state === 'conflict')
      throw new Error(
        '项目镜头内容与草稿基线不同，已保留恢复副本。请导出恢复文件，未覆盖项目。',
      );
    if (state === 'matching-submission') {
      // Persist the new exact baseline before the continuation. If recovering B
      // itself commits and loses its reply, the next process can recognize B too.
      const resumed = {
        sessionId: record.sessionId,
        seq: record.seq + 1,
        baseline: current,
        workspace: { ...record.workspace, revision: current.revision },
        lastSubmitted: { ...record.workspace, revision: current.revision + 1 },
      };
      if ((await this.protect(project, resumed)) !== resumed.seq)
        throw new Error('恢复草稿已变化，请刷新后重试');
      const saved = await restore(resumed.baseline, resumed.workspace);
      await this.acknowledge(project.id, resumed, saved);
      return saved;
    }
    // restore rechecks the complete baseline inside the actual project transaction.
    const saved =
      state === 'submitted' || sameWorkspace(record.workspace, record.baseline)
        ? current
        : await restore(current, {
            ...record.workspace,
            revision: current.revision,
          });
    await this.acknowledge(project.id, input, saved);
    return saved;
  }

  export(project: ProjectSummary, input: unknown, destination: string) {
    return this.run(async () => {
      let record: WorkspaceDraftRecord;
      if (input && typeof input === 'object' && 'snapshot' in input) {
        record = draftRecord({
          ...draftInput(input.snapshot),
          format: 'infinite-afflatus-workspace-draft',
          version: 1,
          project,
          saved: false,
          updatedAt: new Date().toISOString(),
        });
      } else {
        const key = draftKey(input);
        const stored = await this.files.read(
          this.name(project.id, key.sessionId),
        );
        if (
          !stored ||
          stored.seq !== key.seq ||
          stored.project.id !== project.id ||
          stored.project.folder !== project.folder
        )
          throw new Error('恢复草稿已变化，请刷新后重试');
        record = stored;
      }
      return exportDraft(record, destination, this.files.directory);
    });
  }

  async close() {
    // Let a started recovery finish its acknowledgement before closing admission.
    await Promise.allSettled([...this.active]);
    this.closed = true;
    await this.tail;
  }
}
