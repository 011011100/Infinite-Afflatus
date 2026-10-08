import type { ShotListOperation } from '../generation/shot-list-operations';
import type { CanvasPatch } from './model';

export type MainCanvasOperation =
  | { kind: 'video'; patch: CanvasPatch }
  | { kind: 'shot'; operation: ShotListOperation };
export type MainCanvasHistoryDirection = 'edit' | 'undo' | 'redo';
export interface MainCanvasHistorySnapshot {
  /** Operations to execute now, rather than the original forward edits. */
  readonly undo: MainCanvasOperation | null;
  readonly redo: MainCanvasOperation | null;
  readonly busy: boolean;
}
export interface MainCanvasHistoryTicket {
  /** Supply the inverse of what actually saved, including freshly captured shot content. */
  commit(inverse: MainCanvasOperation): boolean;
  /** Failed saves leave both history branches unchanged. */
  abort(): boolean;
}

type Entry = {
  operation: MainCanvasOperation;
  bytes: number;
  sequence: number;
};
type Attempt = {
  operation: MainCanvasOperation;
  direction: MainCanvasHistoryDirection;
  entry: Entry | null;
};

function sameStructure(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameStructure(value, right[index]))
    );
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameStructure(a[key], b[key]))
  );
}

function freeze(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
function snapshotOperation(
  operation: MainCanvasOperation,
): MainCanvasOperation {
  const copy = structuredClone(operation);
  freeze(copy);
  return copy;
}

/** One project-session timeline; persistence and per-shot content undo stay with their owners. */
export class MainCanvasHistory {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private active: Attempt | null = null;
  private sequence = 0;
  private listeners = new Set<() => void>();
  private snapshot: MainCanvasHistorySnapshot = Object.freeze({
    undo: null,
    redo: null,
    busy: false,
  });

  constructor(
    private readonly maxSteps = 50,
    // Bounds estimated UTF-16 operation payloads, not total process memory.
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {
    if (
      !Number.isSafeInteger(maxSteps) ||
      maxSteps < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0
    )
      throw new Error('主画布撤销容量无效');
  }

  getSnapshot = (): MainCanvasHistorySnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  begin(
    operation: MainCanvasOperation,
    direction: MainCanvasHistoryDirection = 'edit',
  ): MainCanvasHistoryTicket | null {
    if (this.active) return null;
    const entry =
      direction === 'undo'
        ? this.past.at(-1)
        : direction === 'redo'
          ? this.future.at(-1)
          : undefined;
    if (direction !== 'edit' && !sameStructure(entry?.operation, operation))
      return null;
    const attempt: Attempt = {
      operation: snapshotOperation(operation),
      direction,
      entry: entry ?? null,
    };
    this.active = attempt;
    this.publish();
    return {
      commit: (inverse) => this.commit(attempt, inverse),
      abort: () => {
        if (this.active !== attempt) return false;
        this.active = null;
        this.publish();
        return true;
      },
    };
  }

  /** Explicit workspace recovery discards shot structure history, retaining video order. */
  discardKind(kind: MainCanvasOperation['kind']): void {
    this.past = this.past.filter((entry) => entry.operation.kind !== kind);
    this.future = this.future.filter((entry) => entry.operation.kind !== kind);
    if (this.active?.operation.kind === kind) this.active = null;
    this.publish();
  }

  private commit(attempt: Attempt, inverse: MainCanvasOperation): boolean {
    if (this.active !== attempt) return false;
    if (inverse.kind !== attempt.operation.kind)
      throw new Error('主画布撤销操作类型不一致');
    const from = attempt.direction === 'undo' ? this.past : this.future;
    if (attempt.direction !== 'edit' && from.at(-1) !== attempt.entry)
      return false;
    const operation = snapshotOperation(inverse);
    const next: Entry = {
      operation,
      bytes: JSON.stringify(operation).length * 2,
      sequence: this.sequence++,
    };
    if (attempt.direction === 'edit') {
      this.past.push(next);
      this.future = [];
    } else {
      from.pop();
      (attempt.direction === 'undo' ? this.future : this.past).push(next);
    }
    this.active = null;
    this.trim();
    this.publish();
    return true;
  }

  private trim(): void {
    const stacks = [this.past, this.future];
    for (const stack of stacks)
      if (stack.length > this.maxSteps)
        stack.splice(0, stack.length - this.maxSteps);
    let bytes = stacks.reduce(
      (total, stack) =>
        total + stack.reduce((size, entry) => size + entry.bytes, 0),
      0,
    );
    while (bytes > this.maxBytes) {
      const oldest = stacks
        .filter((stack) => stack.length)
        .sort((a, b) => (a[0]?.sequence ?? 0) - (b[0]?.sequence ?? 0))[0];
      const removed = oldest?.shift();
      if (!removed) break;
      bytes -= removed.bytes;
    }
  }

  private publish(): void {
    const undo = this.past.at(-1)?.operation ?? null;
    const redo = this.future.at(-1)?.operation ?? null;
    const busy = this.active !== null;
    if (
      undo === this.snapshot.undo &&
      redo === this.snapshot.redo &&
      busy === this.snapshot.busy
    )
      return;
    this.snapshot = Object.freeze({ undo, redo, busy });
    for (const listener of this.listeners) listener();
  }
}
