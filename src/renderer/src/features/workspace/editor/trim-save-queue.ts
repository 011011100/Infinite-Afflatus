import {
  type CanvasCard,
  type CanvasPatch,
  sameCard,
} from '../../../../../shared/canvas/model';
import type { ClipTrim } from '../../../../../shared/canvas/trim';
import type { TrimRecoveryPort } from './trim-draft-controller';

type Edit = { assetId: string; range: ClipTrim };
interface TrimSaveState {
  card: CanvasCard;
  pending: boolean;
  error: string | null;
  reset: number;
}

/** Keep gestures responsive while committing each completed trim in order. */
export class TrimSaveQueue {
  private confirmed: CanvasCard;
  private edits: Edit[] = [];
  private failedEdits: Edit[] = [];
  private running: Promise<boolean> | null = null;
  private listeners = new Set<() => void>();
  private state: TrimSaveState;
  private unsubscribe: (() => void) | undefined;

  constructor(
    card: CanvasCard,
    private write: (patch: CanvasPatch) => Promise<boolean>,
    private recovery?: TrimRecoveryPort,
  ) {
    this.confirmed = card;
    this.state = { card, pending: false, error: null, reset: 0 };
  }

  connect() {
    this.unsubscribe?.();
    this.unsubscribe = this.recovery?.subscribeResolved((patch) =>
      this.resolveSubmitted(patch),
    );
    return () => this.dispose();
  }

  dispose() {
    this.unsubscribe?.();
  }

  /** Drop only the exact failed head whose durable receipt was verified by the whole project. */
  private resolveSubmitted(patch: CanvasPatch) {
    const edit = this.failedEdits[0];
    const before = patch.before[0];
    const after = patch.after[0];
    if (
      !edit ||
      !before ||
      !after ||
      !sameCard(this.confirmed, before) ||
      !sameCard(this.apply(this.confirmed, edit), after)
    )
      return;
    this.failedEdits.shift();
    this.confirmed = after;
    this.emit({
      card: after,
      error: this.failedEdits.length ? this.state.error : null,
    });
  }

  getSnapshot = (): TrimSaveState => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** External undo/reload is authoritative only once this queue has drained. */
  accept(card: CanvasCard): void {
    if (this.state.pending || sameCard(this.state.card, card)) return;
    this.confirmed = card;
    this.emit({ card });
  }

  enqueue(assetId: string, range: ClipTrim): void {
    if (!this.state.card.assetIds.includes(assetId)) return;
    const previous = this.state.card.trims?.[assetId];
    if (previous?.start === range.start && previous.end === range.end) return;
    const running = this.state.pending;
    this.failedEdits = [];
    this.edits.push({ assetId, range: { ...range } });
    const target = this.apply(this.state.card, { assetId, range });
    this.recovery?.stage(this.confirmed, target);
    this.emit({
      card: target,
      pending: true,
      error: null,
    });
    if (!running) void this.start();
  }

  /** A retry keeps the original gestures, but uses the latest confirmed project baseline. */
  flush = (): Promise<boolean> => {
    if (this.running) return this.running;
    if (!this.failedEdits.length) return Promise.resolve(true);
    this.edits = this.failedEdits;
    this.failedEdits = [];
    this.emit({
      card: this.edits.reduce(
        (card, edit) => this.apply(card, edit),
        this.confirmed,
      ),
      pending: true,
      error: null,
    });
    return this.start();
  };

  private start(): Promise<boolean> {
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private apply(card: CanvasCard, edit: Edit): CanvasCard {
    return { ...card, trims: { ...card.trims, [edit.assetId]: edit.range } };
  }

  private async drain(): Promise<boolean> {
    while (this.edits.length) {
      const edit = this.edits[0];
      if (!edit) break;
      const after = this.apply(this.confirmed, edit);
      let saved = false;
      try {
        saved = await this.write({ before: [this.confirmed], after: [after] });
      } catch {
        /* Report failure and unlock the editor even if IPC rejects. */
      }
      if (!saved) {
        this.failedEdits = this.edits;
        this.edits = [];
        this.emit({
          card: this.confirmed,
          pending: false,
          error: '裁剪未保存，预览已恢复已保存范围。可重试保存刚才的修改。',
          reset: this.state.reset + 1,
        });
        return false;
      }
      this.confirmed = after;
      this.edits.shift();
    }
    // Keep the latest optimistic range until the corresponding project snapshot arrives.
    this.emit({ pending: false });
    return true;
  }

  private emit(next: Partial<TrimSaveState>): void {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => {
      listener();
    });
  }
}
