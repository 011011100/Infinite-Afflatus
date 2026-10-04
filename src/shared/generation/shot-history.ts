import type { ShotWorkspace } from './workspace-types';

export interface ShotEditOptions {
  /** Repeated edits of one text or parameter control become one short editing gesture. */
  mergeKey?: string;
  /** Setup work such as the first empty text block is not a user undo step. */
  record?: boolean;
}
export type ShotUpdate = (
  change: (shot: ShotWorkspace) => ShotWorkspace,
  options?: ShotEditOptions,
) => void;
export interface ShotHistoryActions {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  breakMerge?: () => void;
}

type ShotContent = Pick<ShotWorkspace, 'name' | 'nodes' | 'groups' | 'labels'>;
type Entry = { content: ShotContent; bytes: number; sequence: number };
type History = {
  past: Entry[];
  future: Entry[];
  merge: { key: string; at: number } | null;
};
const content = (shot: ShotWorkspace): ShotContent => ({
  name: shot.name,
  nodes: shot.nodes,
  groups: shot.groups,
  ...(shot.labels === undefined ? {} : { labels: shot.labels }),
});

/** Project-session history, partitioned by shot. Project routing and camera state are never restored. */
export class ShotHistory {
  private histories = new Map<string, History>();
  private sequence = 0;
  constructor(
    private readonly maxSteps = 50,
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly mergeWindow = 1000,
  ) {}

  state(id: string) {
    const history = this.histories.get(id);
    return {
      canUndo: !!history?.past.length,
      canRedo: !!history?.future.length,
    };
  }

  breakMerge(id: string) {
    const history = this.histories.get(id);
    if (history) history.merge = null;
  }

  record(
    before: ShotWorkspace,
    after: ShotWorkspace,
    options: ShotEditOptions = {},
    now = Date.now(),
  ) {
    if (before.id !== after.id) throw new Error('撤销记录不能跨镜头');
    const previous = content(before);
    const previousJSON = JSON.stringify(previous);
    if (previousJSON === JSON.stringify(content(after))) return;
    let history = this.histories.get(before.id);
    if (!history) {
      history = { past: [], future: [], merge: null };
      this.histories.set(before.id, history);
    }
    if (options.record === false) {
      history.merge = null;
      return;
    }
    const merge =
      options.mergeKey &&
      history.merge?.key === options.mergeKey &&
      now >= history.merge.at &&
      now - history.merge.at <= this.mergeWindow &&
      !history.future.length &&
      !!history.past.length;
    if (!merge)
      history.past.push(this.entry(previous, previousJSON.length * 2));
    history.future = [];
    history.merge = options.mergeKey
      ? { key: options.mergeKey, at: now }
      : null;
    this.trim();
  }

  undo(shot: ShotWorkspace) {
    return this.restore(shot, 'past', 'future');
  }
  redo(shot: ShotWorkspace) {
    return this.restore(shot, 'future', 'past');
  }

  private entry(
    value: ShotContent,
    bytes = JSON.stringify(value).length * 2,
  ): Entry {
    return {
      content: structuredClone(value),
      bytes,
      sequence: this.sequence++,
    };
  }

  private restore(
    shot: ShotWorkspace,
    from: 'past' | 'future',
    to: 'past' | 'future',
  ): ShotWorkspace {
    const history = this.histories.get(shot.id);
    const entry = history?.[from].pop();
    if (!history || !entry) return shot;
    history[to].push(this.entry(content(shot)));
    history.merge = null;
    this.trim();
    const restored = structuredClone(entry.content);
    const { labels: _labels, ...current } = shot;
    return { ...current, ...restored };
  }

  private trim() {
    const stacks = [...this.histories.values()].flatMap((history) => [
      history.past,
      history.future,
    ]);
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
}
