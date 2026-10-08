type InertState = { original: boolean; owners: number };
const states = new WeakMap<HTMLElement, InertState>();

/** Overlapping surfaces release only their own edit lock. */
export function acquireInert(element: HTMLElement): () => void {
  let state = states.get(element);
  if (!state) {
    state = { original: element.inert, owners: 0 };
    states.set(element, state);
  }
  state.owners += 1;
  element.inert = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.owners -= 1;
    if (state.owners === 0) {
      element.inert = state.original;
      states.delete(element);
    }
  };
}
