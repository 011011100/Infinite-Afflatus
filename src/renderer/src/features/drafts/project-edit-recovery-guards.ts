import type { ProjectSnapshot } from '../../../../shared/models';
import type { ProjectEditDraftRecord } from '../../../../shared/project-edit-draft';

type Accepted = (
  record: ProjectEditDraftRecord,
  snapshot: ProjectSnapshot,
) => void;
export interface ProjectEditRecoveryAttempt {
  failed: (reason: unknown) => void;
  complete: () => void;
}
type Prepare = (
  record: ProjectEditDraftRecord,
) => ProjectEditRecoveryAttempt | undefined;

/** Coordinate explicit recovery with live editors without flushing or replacing their input. */
export class ProjectEditRecoveryGuards {
  private guards = new Map<string, Set<() => boolean>>();
  private receivers = new Map<string, Set<Accepted>>();
  private preparations = new Map<string, Set<Prepare>>();
  private recovering = new Set<string>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  notify() {
    for (const listener of this.listeners) listener();
  }
  register(
    projectId: string,
    ready: () => boolean,
    accepted?: Accepted,
    prepare?: Prepare,
  ) {
    const guards = this.guards.get(projectId) ?? new Set<() => boolean>();
    guards.add(ready);
    this.guards.set(projectId, guards);
    if (accepted) {
      const receivers = this.receivers.get(projectId) ?? new Set<Accepted>();
      receivers.add(accepted);
      this.receivers.set(projectId, receivers);
    }
    if (prepare) {
      const preparations =
        this.preparations.get(projectId) ?? new Set<Prepare>();
      preparations.add(prepare);
      this.preparations.set(projectId, preparations);
    }
    this.notify();
    return () => {
      guards.delete(ready);
      if (!guards.size) this.guards.delete(projectId);
      if (accepted) {
        const receivers = this.receivers.get(projectId);
        receivers?.delete(accepted);
        if (!receivers?.size) this.receivers.delete(projectId);
      }
      if (prepare) {
        const preparations = this.preparations.get(projectId);
        preparations?.delete(prepare);
        if (!preparations?.size) this.preparations.delete(projectId);
      }
      this.notify();
    };
  }
  isRecovering = (projectId: string) => this.recovering.has(projectId);
  prepare(record: ProjectEditDraftRecord): ProjectEditRecoveryAttempt {
    if (!this.isRecovering(record.project.id))
      throw new Error('请先锁定当前编辑，再恢复旧草稿。');
    const attempts: ProjectEditRecoveryAttempt[] = [];
    try {
      for (const prepare of this.preparations.get(record.project.id) ?? []) {
        const attempt = prepare(record);
        if (attempt) attempts.push(attempt);
      }
    } catch (error) {
      for (const attempt of attempts) attempt.complete();
      throw error;
    }
    return {
      failed: (reason) => {
        for (const attempt of attempts) attempt.failed(reason);
      },
      complete: () => {
        for (const attempt of attempts) attempt.complete();
      },
    };
  }
  accept(record: ProjectEditDraftRecord, snapshot: ProjectSnapshot) {
    if (
      record.project.id !== snapshot.project.id ||
      record.project.folder !== snapshot.project.folder ||
      !this.isRecovering(record.project.id)
    )
      throw new Error('项目恢复状态已变化，未替换当前页面。');
    for (const accepted of this.receivers.get(record.project.id) ?? [])
      accepted(record, snapshot);
  }
  canRecover(projectId: string) {
    const guards = this.guards.get(projectId);
    return (
      !this.isRecovering(projectId) &&
      !!guards?.size &&
      [...guards].every((ready) => ready())
    );
  }
  begin(projectId: string) {
    if (!this.canRecover(projectId))
      throw new Error('请先完成或处理当前编辑，再恢复其他修改。');
    this.recovering.add(projectId);
    this.notify();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.recovering.delete(projectId);
      this.notify();
    };
  }
}

export const projectEditRecoveryGuards = new ProjectEditRecoveryGuards();
