import {
  type CanvasCard,
  type CanvasPatch,
  sameCard,
} from '../../../../../shared/canvas/model';
import { isTrimPatch } from '../../../../../shared/canvas/operations';
import type { DesktopBridge } from '../../../../../shared/desktop';
import type { Asset, ProjectSnapshot } from '../../../../../shared/models';
import {
  type ProjectEditDraftRecord,
  projectEditDraftState,
  type TrimEditDraftInput,
} from '../../../../../shared/project-edit-draft';
import { canResumeSubmittedTrim } from '../canvas-recovery';

type Desktop = Pick<
  DesktopBridge,
  'protectProjectEditDraft' | 'acknowledgeProjectEditDraft'
>;
export type CanvasAction = 'edit' | 'undo' | 'redo';

export interface TrimRecoveryPort {
  stage(baseline: CanvasCard, target: CanvasCard): void;
  subscribeResolved(listener: (patch: CanvasPatch) => void): () => void;
}

/** One record per card in this editing session; gestures never reset a debounce timer. */
class TrimDraftSession implements TrimRecoveryPort {
  private value: TrimEditDraftInput | null = null;
  private sequence = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private error: string | null = null;
  private resolved = new Set<(patch: CanvasPatch) => void>();
  readonly sessionId = crypto.randomUUID();

  constructor(
    private projectId: string,
    private assets: Asset[],
    private desktop: Desktop,
    private changed: () => void,
  ) {}

  snapshot() {
    return this.value ? structuredClone(this.value) : null;
  }
  getError() {
    return this.error;
  }
  dirty() {
    return !!this.value && !sameCard(this.value.baseline, this.value.target);
  }
  subscribeResolved = (listener: (patch: CanvasPatch) => void) => {
    this.resolved.add(listener);
    return () => {
      this.resolved.delete(listener);
    };
  };
  notifyResolved(patch: CanvasPatch) {
    for (const listener of this.resolved) listener(patch);
  }

  private put(
    baseline: CanvasCard,
    target: CanvasCard,
    lastSubmitted?: CanvasCard,
  ) {
    const value: TrimEditDraftInput = {
      kind: 'trim',
      sessionId: this.sessionId,
      seq: ++this.sequence,
      baseline: structuredClone(baseline),
      target: structuredClone(target),
      assets: structuredClone(this.assets),
      ...(lastSubmitted
        ? { lastSubmitted: structuredClone(lastSubmitted) }
        : {}),
    };
    this.value = value;
    const work = this.tail
      .catch(() => undefined)
      .then(async () => {
        const sequence = await this.desktop.protectProjectEditDraft(
          this.projectId,
          value,
        );
        if (sequence !== value.seq) throw new Error('裁剪恢复副本顺序已变化');
        this.error = null;
        this.changed();
      })
      .catch((reason) => {
        this.error =
          '裁剪恢复副本未更新，尚未写入新的裁剪。请重试保存；未保存的范围仍保留。';
        this.changed();
        throw reason;
      });
    this.tail = work;
    void work.catch(() => undefined);
    this.changed();
    return { value, work };
  }

  stage(baseline: CanvasCard, target: CanvasCard) {
    // A newer gesture changes the target, never the receipt of the write in flight.
    const submitted =
      this.value && sameCard(this.value.baseline, baseline)
        ? this.value.lastSubmitted
        : undefined;
    this.put(baseline, target, submitted);
  }

  async prepare(before: CanvasCard, after: CanvasCard) {
    const target =
      this.dirty() && this.value && sameCard(this.value.baseline, before)
        ? this.value.target
        : after;
    const prepared = this.put(before, target, after);
    await prepared.work;
    return prepared.value;
  }

  async committed(after: CanvasCard) {
    const target = this.value?.target ?? after;
    const settled = this.put(after, target);
    try {
      await settled.work;
      if (!sameCard(after, target)) return;
      // Serialize acknowledgement with protects too; sequence CAS rejects late cleanup.
      const work = this.tail
        .catch(() => undefined)
        .then(() =>
          this.desktop.acknowledgeProjectEditDraft(
            this.projectId,
            settled.value,
          ),
        );
      this.tail = work;
      const removed = await work;
      if (!removed && this.value?.seq === settled.value.seq)
        throw new Error('裁剪恢复副本尚未确认');
      if (removed && this.value?.seq === settled.value.seq) {
        this.value = null;
        this.error = null;
        this.changed();
      }
    } catch {
      this.error =
        '裁剪已保存，但恢复副本尚未确认。副本仍保留，重启后会重新检查。';
      this.changed();
    }
  }
  async retryProtection() {
    const value = this.value;
    if (!value) return true;
    if (sameCard(value.baseline, value.target)) {
      await this.committed(value.target);
      return !this.error;
    }
    try {
      await this.put(value.baseline, value.target, value.lastSubmitted).work;
      return true;
    } catch {
      return false;
    }
  }
}

export interface TrimSubmission {
  readonly source: 'edit';
  readonly baseline: ProjectSnapshot;
  readonly patch: CanvasPatch;
  readonly action: CanvasAction;
  readonly record: TrimEditDraftInput;
  readonly session: TrimDraftSession;
}

interface ExplicitTrimSubmission {
  readonly source: 'recovery';
  readonly baseline: ProjectSnapshot;
  readonly patch: CanvasPatch;
  readonly action: 'edit';
  readonly record: TrimEditDraftInput;
}
export type PendingTrimSubmission = TrimSubmission | ExplicitTrimSubmission;

/** Shared by the gesture queue and every trim write, including undo and redo. */
export class TrimDraftController {
  private sessions = new Map<string, TrimDraftSession>();
  private uncertain: PendingTrimSubmission | null = null;
  private failedMessage: string | null = null;
  private gestures = new Set<string>();
  private listeners = new Set<() => void>();
  private state = { error: null as string | null, hasPendingEdits: false };
  constructor(
    private projectId: string,
    private desktop: Desktop,
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private changed = () => {
    this.state = {
      error:
        [...this.sessions.values()]
          .map((session) => session.getError())
          .find(Boolean) ?? this.failedMessage,
      hasPendingEdits: this.hasPendingEdits(),
    };
    for (const listener of this.listeners) listener();
  };
  hasPendingEdits = () =>
    !!this.uncertain ||
    !!this.gestures.size ||
    [...this.sessions.values()].some((session) => session.dirty());
  hasUnconfirmedSubmission = () => !!this.uncertain;
  canRetryProtection = () => this.uncertain?.source !== 'recovery';
  setGesturing(cardId: string, active: boolean) {
    if (active) this.gestures.add(cardId);
    else this.gestures.delete(cardId);
    this.changed();
  }
  snapshots() {
    const snapshots = [...this.sessions.values()].flatMap((session) => {
      const value = session.snapshot();
      return value ? [value] : [];
    });
    if (this.uncertain?.source === 'recovery')
      snapshots.push(structuredClone(this.uncertain.record));
    return snapshots;
  }
  async retryProtection(): Promise<boolean> {
    // This record may already have been acknowledged by native recovery. Never
    // recreate its old stream; strict project rereading resolves the receipt.
    if (this.uncertain?.source === 'recovery') return false;
    const results = await Promise.all(
      [...this.sessions.values()].map((session) => session.retryProtection()),
    );
    return results.every(Boolean);
  }
  forCard(card: CanvasCard, assets: Asset[]): TrimRecoveryPort {
    return this.session(card, assets);
  }
  private session(card: CanvasCard, assets: Asset[]) {
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const sources = card.assetIds.map((id) => {
      const asset = byId.get(id);
      if (!asset) throw new Error('裁剪素材记录不完整');
      return structuredClone(asset);
    });
    const key = JSON.stringify([card.id, sources]);
    let session = this.sessions.get(key);
    if (!session) {
      session = new TrimDraftSession(
        this.projectId,
        sources,
        this.desktop,
        this.changed,
      );
      this.sessions.set(key, session);
    }
    return session;
  }
  async prepare(
    baseline: ProjectSnapshot,
    patch: CanvasPatch,
    action: CanvasAction,
  ): Promise<TrimSubmission> {
    const before = patch.before[0];
    const after = patch.after[0];
    if (!before || !after) throw new Error('裁剪操作无效');
    const session = this.session(before, baseline.assets);
    const record = await session.prepare(before, after);
    return {
      source: 'edit',
      baseline: structuredClone(baseline),
      patch: structuredClone(patch),
      action,
      record,
      session,
    };
  }
  prepareRecovery(
    baseline: ProjectSnapshot,
    record: ProjectEditDraftRecord & { kind: 'trim' },
  ): ExplicitTrimSubmission {
    const before = baseline.canvas.cards.find(
      (card) => card.id === record.baseline.id,
    );
    const patch = { before: before ? [before] : [], after: [record.target] };
    if (
      baseline.project.id !== this.projectId ||
      record.project.id !== this.projectId ||
      baseline.project.folder !== record.project.folder ||
      projectEditDraftState(record, baseline) === 'conflict' ||
      !isTrimPatch(patch)
    )
      throw new Error('旧裁剪与当前已确认版本不同，恢复副本已保留');
    return {
      source: 'recovery',
      baseline: structuredClone(baseline),
      patch: structuredClone(patch),
      action: 'edit',
      record: structuredClone(record),
    };
  }
  failedRecovery(ticket: ExplicitTrimSubmission) {
    this.uncertain = ticket;
    this.failedMessage =
      '旧裁剪恢复的保存回执未确认。请重试读取项目以核对实际保存结果，或导出当前裁剪恢复文件。';
    this.changed();
  }
  async committed(ticket: TrimSubmission) {
    if (this.uncertain === ticket) this.uncertain = null;
    this.failedMessage = null;
    await ticket.session.committed(ticket.patch.after[0] as CanvasCard);
    this.changed();
  }
  failed(ticket: TrimSubmission) {
    this.uncertain = ticket;
    this.failedMessage =
      ticket.action === 'edit'
        ? '裁剪尚未确认保存，恢复副本已保留。请重试保存，或导出当前裁剪恢复文件。'
        : `裁剪${ticket.action === 'undo' ? '撤销' : '重做'}尚未确认保存，恢复副本已保留。重新读取原项目后可再次执行该操作，或导出恢复文件。`;
    this.changed();
  }
  recoveryCandidate(remote: ProjectSnapshot, references: Asset[] = []) {
    const ticket = this.uncertain;
    return ticket &&
      canResumeSubmittedTrim(ticket.baseline, remote, ticket.patch, references)
      ? ticket
      : null;
  }
  /** Only call after the session has published the snapshot accepted by every recovery guard. */
  adoptRecovered(ticket: PendingTrimSubmission) {
    if (this.uncertain !== ticket) return false;
    this.uncertain = null;
    if (ticket.source === 'edit') {
      ticket.session.notifyResolved(ticket.patch);
      void this.committed(ticket);
    } else this.failedMessage = null;
    this.changed();
    return true;
  }
  /** A verified unchanged disk baseline permits retrying the original queue. */
  acceptUnchanged(remote: ProjectSnapshot) {
    if (
      this.uncertain &&
      JSON.stringify(remote.canvas) ===
        JSON.stringify(this.uncertain.baseline.canvas)
    ) {
      if (this.uncertain.source === 'recovery') this.failedMessage = null;
      this.uncertain = null;
      this.changed();
    }
  }
}
