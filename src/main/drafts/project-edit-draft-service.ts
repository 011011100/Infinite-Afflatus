import type { ProjectSnapshot, ProjectSummary } from '../../shared/models';
import {
  type ProjectEditDraftList,
  type ProjectEditDraftRecord,
  projectEditDraftState,
} from '../../shared/project-edit-draft';
import { errorMessage } from '../storage/database';
import { DraftFiles } from './draft-files';
import { draftId, draftKey } from './draft-validation';
import { exportRecoveryRecord } from './export-draft';
import {
  projectEditInput,
  projectEditRecord,
  sameProjectEditInput,
} from './project-edit-validation';
import { addRescueRecord } from './rescue-record';

type Restore = (
  record: ProjectEditDraftRecord,
  beforeWrite: () => Promise<void>,
) => Promise<ProjectSnapshot>;

/** Independent durable editor streams. A project gate never blocks another stream's protection. */
export class ProjectEditDraftService {
  readonly files: DraftFiles<ProjectEditDraftRecord>;
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private stopped: Promise<void> | null = null;
  private locked = new Set<string>();
  private active = new Set<Promise<unknown>>();
  private acknowledged = new Map<string, number>();

  constructor(userData: string) {
    this.files = new DraftFiles(userData, {
      directory: 'project-edit-drafts',
      decode: projectEditRecord,
    });
  }

  private name(projectId: string, sessionId: string) {
    return `${draftId(projectId)}.${draftId(sessionId)}.json`;
  }

  private run<T>(operation: () => Promise<T>, internal = false): Promise<T> {
    if (this.closing && !internal)
      return Promise.reject(new Error('项目编辑恢复服务正在关闭'));
    const work = this.tail.then(operation);
    this.tail = work.catch(() => undefined);
    return work;
  }

  private requireUnlocked(name: string) {
    if (this.locked.has(name)) throw new Error('此编辑正在恢复，请完成后重试');
  }

  addRescue(input: unknown, beforeAdd: () => Promise<void>) {
    const record = projectEditRecord(input);
    return this.run(async () => {
      if (this.acknowledged.has(this.name(record.project.id, record.sessionId)))
        throw new Error('此恢复副本已确认或移除，请重新检查救援文件');
      return addRescueRecord(this.files, record, beforeAdd);
    });
  }

  protect(project: ProjectSummary, input: unknown): Promise<number> {
    const value = projectEditInput(input);
    const name = this.name(project.id, value.sessionId);
    const record = projectEditRecord({
      ...value,
      format: 'infinite-afflatus-project-edit-draft',
      version: 1,
      project,
      updatedAt: new Date().toISOString(),
    });
    return this.run(async () => {
      this.requireUnlocked(name);
      const acknowledged = this.acknowledged.get(name) ?? 0;
      if (acknowledged >= value.seq) return acknowledged;
      const previous = await this.files.read(name);
      if (
        previous &&
        (previous.project.id !== project.id ||
          previous.project.folder !== project.folder ||
          previous.sessionId !== value.sessionId ||
          previous.kind !== value.kind ||
          (previous.kind === 'trim' &&
            value.kind === 'trim' &&
            previous.baseline.id !== value.baseline.id))
      )
        throw new Error('恢复编辑流身份已变化，原草稿已保留');
      if (previous && previous.seq > value.seq) return previous.seq;
      if (previous?.seq === value.seq) {
        if (!sameProjectEditInput(previous, value))
          throw new Error('相同草稿顺序不能替换不同内容');
        return previous.seq;
      }
      await this.files.write(name, record, previous);
      return record.seq;
    });
  }

  list(projectId: string): Promise<ProjectEditDraftList> {
    const prefix = `${draftId(projectId)}.`;
    return this.run(async () => {
      const result: ProjectEditDraftList = { drafts: [], issues: [] };
      for (const name of await this.files.entries()) {
        if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
        try {
          const record = await this.files.read(name);
          if (
            !record ||
            name !== this.name(record.project.id, record.sessionId)
          )
            throw new Error('恢复草稿文件与项目身份不匹配，原文件已保留');
          result.drafts.push(record);
        } catch (reason) {
          result.issues.push({ file: name, message: errorMessage(reason) });
        }
      }
      result.drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return result;
    });
  }

  private async read(projectId: string, input: unknown) {
    const key = draftKey(input);
    const record = await this.files.read(this.name(projectId, key.sessionId));
    if (
      !record ||
      record.seq !== key.seq ||
      record.project.id !== projectId ||
      record.sessionId !== key.sessionId
    )
      throw new Error('恢复草稿已变化，请刷新后重试');
    return record;
  }

  get(projectId: string, input: unknown) {
    return this.run(() => this.read(projectId, input));
  }

  acknowledge(projectId: string, input: unknown, snapshot: ProjectSnapshot) {
    const key = draftKey(input);
    const name = this.name(projectId, key.sessionId);
    return this.run(async () => {
      this.requireUnlocked(name);
      return this.confirm(projectId, key, snapshot);
    });
  }

  private async confirm(
    projectId: string,
    input: unknown,
    snapshot: ProjectSnapshot,
  ) {
    const key = draftKey(input);
    const name = this.name(projectId, key.sessionId);
    const record = await this.files.read(name);
    if (!record || record.seq !== key.seq) return false;
    if (
      record.project.id !== projectId ||
      record.sessionId !== key.sessionId ||
      snapshot.project.id !== projectId ||
      record.project.folder !== snapshot.project.folder ||
      projectEditDraftState(record, snapshot) !== 'submitted'
    )
      return false;
    const removed = await this.files.remove(name, key.seq, record);
    if (removed) this.acknowledged.set(name, key.seq);
    return removed;
  }

  recover(project: ProjectSummary, input: unknown, restore: Restore) {
    const key = draftKey(input);
    const name = this.name(project.id, key.sessionId);
    if (this.closing)
      return Promise.reject(new Error('项目编辑恢复服务正在关闭'));
    if (this.locked.has(name))
      return Promise.reject(new Error('此编辑正在恢复，请完成后重试'));
    this.locked.add(name);
    const operation = this.restore(project, key, restore).finally(() => {
      this.locked.delete(name);
      this.active.delete(operation);
    });
    this.active.add(operation);
    return operation;
  }

  private async restore(
    project: ProjectSummary,
    input: unknown,
    restore: Restore,
  ) {
    const record = await this.run(() => this.read(project.id, input), true);
    if (record.project.folder !== project.folder)
      throw new Error('恢复草稿项目身份不匹配');
    const verify = () =>
      this.run(async () => {
        const current = await this.read(project.id, input);
        if (JSON.stringify(current) !== JSON.stringify(record))
          throw new Error('恢复草稿在等待保存期间变化，未提交旧内容');
      }, true);
    const snapshot = await restore(record, verify);
    if (
      snapshot.project.id !== project.id ||
      snapshot.project.folder !== record.project.folder ||
      projectEditDraftState(record, snapshot) !== 'submitted'
    )
      throw new Error('项目保存结果尚未确认目标内容，恢复副本已保留');
    try {
      await this.run(async () => {
        const current = await this.read(project.id, input);
        if (JSON.stringify(current) !== JSON.stringify(record))
          throw new Error('项目已保存，但恢复副本发生变化，原副本已保留');
        await this.confirm(project.id, input, snapshot);
      }, true);
    } catch (error) {
      // The project transaction is already confirmed. A cleanup failure must
      // not turn that acknowledgement into a failed write or freeze the editor.
      // list() reports remaining submitted records or unreadable replacements;
      // never overwrite/recreate a file merely to repair its cleanup receipt.
      console.warn('Project edit saved; recovery cleanup pending:', error);
    }
    return snapshot;
  }

  discard(projectId: string, input: unknown) {
    const key = draftKey(input);
    const name = this.name(projectId, key.sessionId);
    return this.run(async () => {
      this.requireUnlocked(name);
      const record = await this.files.read(name);
      if (
        !record ||
        record.project.id !== projectId ||
        record.sessionId !== key.sessionId ||
        record.seq !== key.seq
      )
        return false;
      const removed = await this.files.remove(name, key.seq, record);
      if (removed) this.acknowledged.set(name, key.seq);
      return removed;
    });
  }

  export(project: ProjectSummary, input: unknown, destination: string) {
    return this.run(async () => {
      const record =
        input && typeof input === 'object' && 'snapshot' in input
          ? projectEditRecord({
              ...projectEditInput(input.snapshot),
              format: 'infinite-afflatus-project-edit-draft',
              version: 1,
              project,
              updatedAt: new Date().toISOString(),
            })
          : await this.read(project.id, input);
      if (record.project.folder !== project.folder)
        throw new Error('恢复草稿项目身份不匹配');
      return exportRecoveryRecord(
        {
          format: 'infinite-afflatus-project-edit-rescue',
          version: 1,
          notice:
            '只读名称或裁剪救援文件。不包含原媒体、镜头素材工作区及撤销历史，不能作为完整项目包导入。',
          draft: record,
        },
        destination,
        this.files.directory,
        '.afflatus-edit-draft.json',
      );
    });
  }

  close(): Promise<void> {
    if (!this.stopped) {
      this.closing = true;
      this.stopped = (async () => {
        await Promise.allSettled([...this.active]);
        await this.tail;
      })();
    }
    return this.stopped;
  }
}
