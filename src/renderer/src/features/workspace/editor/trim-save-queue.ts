import {
  type CanvasCard,
  type CanvasPatch,
  sameCard,
} from '../../../../../shared/canvas/model';
import type { ClipTrim } from '../../../../../shared/canvas/trim';

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
  private listeners = new Set<() => void>();
  private state: TrimSaveState;

  constructor(
    card: CanvasCard,
    private write: (patch: CanvasPatch) => Promise<boolean>,
  ) {
    this.confirmed = card;
    this.state = { card, pending: false, error: null, reset: 0 };
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
    this.edits.push({ assetId, range: { ...range } });
    this.emit({
      card: this.apply(this.state.card, { assetId, range }),
      pending: true,
      error: null,
    });
    if (!running) void this.drain();
  }

  private apply(card: CanvasCard, edit: Edit): CanvasCard {
    return { ...card, trims: { ...card.trims, [edit.assetId]: edit.range } };
  }

  private async drain(): Promise<void> {
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
        this.edits = [];
        this.emit({
          card: this.confirmed,
          pending: false,
          error: '裁剪未保存，已恢复已保存的范围。请重试。',
          reset: this.state.reset + 1,
        });
        return;
      }
      this.confirmed = after;
      this.edits.shift();
    }
    // Keep the latest optimistic range until the corresponding project snapshot arrives.
    this.emit({ pending: false });
  }

  private emit(next: Partial<TrimSaveState>): void {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => {
      listener();
    });
  }
}
