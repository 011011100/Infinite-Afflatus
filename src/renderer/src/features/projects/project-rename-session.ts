import type { DesktopBridge } from '../../../../shared/desktop';
import type {
  ProjectSnapshot,
  ProjectSummary,
} from '../../../../shared/models';
import type {
  NameEditDraftInput,
  ProjectEditDraftKey,
  ProjectEditDraftRecord,
} from '../../../../shared/project-edit-draft';
import { projectErrorMessage } from './library-session';

type Desktop = Pick<
  DesktopBridge,
  | 'protectProjectEditDraft'
  | 'recoverProjectEditDraft'
  | 'acknowledgeProjectEditDraft'
  | 'discardProjectEditDraft'
  | 'exportProjectEditDraft'
  | 'listProjectEditDrafts'
  | 'openProject'
>;
type NameRecord = ProjectEditDraftRecord & { kind: 'name' };
type Operation = 'saving' | 'discarding' | 'exporting' | null;

/** One name-editing session owns its exact stream, including cancellation. */
export class ProjectRenameSession {
  readonly sessionId: string;
  private latest: NameEditDraftInput | null;
  private protectedSeq: number;
  private receipt: string | undefined;
  private protecting: Promise<boolean> | null = null;
  private operation: Promise<boolean> | null = null;
  private finished = false;
  private saved: ProjectSnapshot | null = null;
  private listeners = new Set<() => void>();
  private waiters = new Set<{
    seq: number;
    resolve: (saved: boolean) => void;
  }>();
  private state: {
    baseline: string;
    target: string;
    key: ProjectEditDraftKey;
    restored: boolean;
    protecting: boolean;
    busy: Operation;
    error: string | null;
    protectionError: string | null;
    notice: string | null;
  };

  constructor(
    readonly project: Pick<ProjectSummary, 'id' | 'folder' | 'name'>,
    private desktop: Desktop,
    record?: NameRecord,
    sessionId: string = crypto.randomUUID(),
  ) {
    if (
      record &&
      (record.project.id !== project.id ||
        record.project.folder !== project.folder)
    )
      throw new Error('名称恢复副本不属于当前项目。');
    if (
      record &&
      project.name !== record.baseline &&
      project.name !== record.lastSubmitted &&
      project.name !== record.target.trim()
    )
      throw new Error('项目名称与草稿对应的原名称不同，恢复副本已保留。');
    this.sessionId = record?.sessionId ?? sessionId;
    this.latest = record
      ? {
          kind: 'name',
          sessionId: record.sessionId,
          seq: record.seq,
          baseline: record.baseline,
          target: record.target,
          ...(record.lastSubmitted === undefined
            ? {}
            : { lastSubmitted: record.lastSubmitted }),
        }
      : null;
    this.protectedSeq = record?.seq ?? 0;
    this.receipt = record?.lastSubmitted;
    this.state = {
      baseline: record?.baseline ?? project.name,
      target: record?.target ?? project.name,
      key: { sessionId: this.sessionId, seq: record?.seq ?? 0 },
      restored: !!record,
      protecting: false,
      busy: null,
      error: null,
      protectionError: null,
      notice: null,
    };
    if (
      record &&
      (project.name === record.lastSubmitted ||
        project.name === record.target.trim()) &&
      (record.baseline !== project.name || record.lastSubmitted !== undefined)
    ) {
      // A committed before B survived. Keep the sequence watermark while making
      // the acknowledged name the exact baseline for any subsequent crash.
      this.state.baseline = project.name;
      this.receipt = undefined;
      this.stage();
    }
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(next: Partial<typeof this.state>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  pending = () => this.operation;
  isFinished = () => this.finished;
  hasSaved = () => this.saved !== null;
  canSave(currentName: string) {
    return (
      this.receipt !== undefined ||
      currentName === this.state.baseline ||
      currentName === this.state.target.trim()
    );
  }
  input = (): NameEditDraftInput => ({
    kind: 'name',
    sessionId: this.sessionId,
    seq: Math.max(1, this.state.key.seq),
    baseline: this.state.baseline,
    target: this.state.target,
    ...(this.receipt === undefined ? {} : { lastSubmitted: this.receipt }),
  });
  setTarget(target: string) {
    if (this.state.busy || this.finished || target === this.state.target)
      return;
    if (target.length > 100) return;
    this.emit({ target, error: null, notice: null });
    this.stage();
  }
  private stage() {
    const input = this.input();
    if (
      !this.latest ||
      this.latest.target !== input.target ||
      this.latest.baseline !== input.baseline ||
      this.latest.lastSubmitted !== input.lastSubmitted
    ) {
      this.latest = { ...input, seq: this.state.key.seq + 1 };
      this.emit({ key: { sessionId: this.sessionId, seq: this.latest.seq } });
    }
    void this.flushProtection();
  }
  private settle(success: boolean) {
    for (const waiter of this.waiters) {
      if (!success || waiter.seq <= this.protectedSeq) {
        this.waiters.delete(waiter);
        waiter.resolve(success);
      }
    }
  }
  flushProtection = (): Promise<boolean> => {
    if (!this.latest || this.latest.seq === this.protectedSeq)
      return Promise.resolve(true);
    const seq = this.latest.seq;
    const waiting = new Promise<boolean>((resolve) =>
      this.waiters.add({ seq, resolve }),
    );
    if (!this.protecting) {
      this.emit({ protecting: true });
      this.protecting = this.protect().finally(() => {
        this.protecting = null;
        this.emit({ protecting: false });
        if (
          !this.state.protectionError &&
          this.latest &&
          this.latest.seq > this.protectedSeq
        )
          void this.flushProtection();
      });
    }
    return waiting;
  };
  private async protect() {
    try {
      while (this.latest && this.latest.seq > this.protectedSeq) {
        const input = this.latest;
        const seq = await this.desktop.protectProjectEditDraft(
          this.project.id,
          input,
        );
        if (seq !== input.seq)
          throw new Error('名称恢复副本已变化，请保留当前输入并重新检查。');
        this.protectedSeq = input.seq;
        this.emit({ protectionError: null });
        this.settle(true);
      }
      return true;
    } catch (error) {
      this.emit({
        protectionError: `名称恢复副本未更新，意外退出可能丢失输入。${projectErrorMessage(error)}`,
      });
      this.settle(false);
      return false;
    }
  }
  private perform(
    busy: Exclude<Operation, null>,
    action: () => Promise<boolean>,
  ) {
    if (this.operation) return Promise.resolve(false);
    this.emit({ busy, error: null, notice: null });
    this.operation = Promise.resolve()
      .then(action)
      .catch((error) => {
        this.emit({ error: projectErrorMessage(error) });
        return false;
      })
      .finally(() => {
        this.operation = null;
        this.emit({ busy: null });
      });
    return this.operation;
  }
  save(
    onSaved: (snapshot: ProjectSnapshot) => Promise<void>,
  ): Promise<boolean> {
    return this.perform('saving', async () => {
      if (!this.saved) {
        const name = this.state.target.trim();
        if (
          !name ||
          Array.from(this.state.target).some(
            (character) => character.charCodeAt(0) < 32,
          )
        )
          throw new Error('项目名称需要 1–100 个字符，且不能包含控制字符。');
        if (this.receipt !== undefined) {
          // Resolve the one previous unknown commit before submitting another.
          // Continuous input can retain A, but B must never overwrite that
          // evidence until a real read confirms A, the baseline, or B itself.
          const actual = await this.desktop.openProject(this.project.id);
          if (
            actual.project.id !== this.project.id ||
            actual.project.folder !== this.project.folder
          )
            throw new Error('读取的项目身份已变化，名称输入与恢复副本已保留。');
          if (
            ![this.state.baseline, this.receipt, name].includes(
              actual.project.name,
            )
          )
            throw new Error(
              '项目名称与此前提交不同，名称输入与恢复副本已保留。',
            );
          this.receipt = undefined;
          this.emit({ baseline: actual.project.name });
        }
        this.stage();
        if (!(await this.flushProtection())) return false;
        // Its new baseline/target must be durable before this next attempt.
        this.receipt = name;
        this.saved = await this.desktop.recoverProjectEditDraft(
          this.project.id,
          this.state.key,
        );
        this.finished = true; // Native recovery acknowledges/removes the exact key.
      }
      await onSaved(this.saved);
      return true;
    });
  }
  cancel(): Promise<boolean> {
    if (this.finished) return Promise.resolve(true);
    return this.perform('discarding', async () => {
      // Inputs are frozen synchronously by perform before waiting for the queue.
      await this.protecting;
      if (this.latest) {
        // A write can publish before its durability receipt fails. Read the
        // settled stream instead of requiring another write on a full disk.
        const list = await this.desktop.listProjectEditDrafts(this.project.id);
        const record = list.drafts.find(
          (item) => item.sessionId === this.sessionId,
        );
        if (record) {
          if (
            record.kind !== 'name' ||
            record.seq > this.state.key.seq ||
            record.project.folder !== this.project.folder ||
            !(await this.desktop.discardProjectEditDraft(this.project.id, {
              sessionId: this.sessionId,
              seq: record.seq,
            }))
          )
            throw new Error(
              '名称恢复副本已变化，未取消修改。请重试或导出恢复文件。',
            );
        } else if (
          list.issues.some(
            (issue) =>
              issue.file === `${this.project.id}.${this.sessionId}.json`,
          )
        ) {
          throw new Error(
            '恢复副本暂时无法完整读取，未确认名称草稿已清理。请重试或导出恢复文件。',
          );
        }
      }
      this.finished = true;
      return true;
    });
  }
  leave(currentName: string): Promise<boolean> {
    if (this.operation)
      return this.operation.then(() => this.leave(currentName));
    if (this.finished) return Promise.resolve(true);
    if (this.state.target.trim() !== currentName)
      return this.flushProtection().then(() => false);
    return this.perform('discarding', async () => {
      await this.protecting;
      if (this.latest) {
        if (!(await this.flushProtection())) return false;
        if (
          !(await this.desktop.acknowledgeProjectEditDraft(
            this.project.id,
            this.state.key,
          ))
        )
          throw new Error(
            '名称尚未确认保存，恢复副本已保留。请先保存或取消名称修改。',
          );
        this.latest = null;
      }
      // Another editor may still veto leaving. Keep this dialog usable, and
      // preserve its sequence watermark if the user continues editing.
      return true;
    });
  }
  exportDraft(): Promise<boolean> {
    return this.perform('exporting', async () => {
      const path = await this.desktop.exportProjectEditDraft(this.project.id, {
        snapshot: this.input(),
      });
      if (path) this.emit({ notice: `只读名称恢复文件已保存：${path}` });
      return true;
    });
  }
}
