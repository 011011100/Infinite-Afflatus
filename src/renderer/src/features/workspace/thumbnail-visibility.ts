/** Observe clipped thumbnail buttons without removing their layout or gesture targets. */
export class ThumbnailVisibility {
  private nearObserver: IntersectionObserver | null = null;
  private visibleObserver: IntersectionObserver | null = null;
  private listeners = new Map<
    Element,
    {
      listener: (state: { near: boolean; visible: boolean }) => void;
      near: boolean;
      visible: boolean;
    }
  >();

  observe(
    element: Element,
    listener: (state: { near: boolean; visible: boolean }) => void,
  ) {
    const deliver = (
      entries: IntersectionObserverEntry[],
      key: 'near' | 'visible',
    ) => {
      for (const entry of entries) {
        const state = this.listeners.get(entry.target);
        if (!state || state[key] === entry.isIntersecting) continue;
        state[key] = entry.isIntersecting;
        state.listener({ near: state.near, visible: state.visible });
      }
    };
    this.nearObserver ??= new IntersectionObserver(
      (entries) => deliver(entries, 'near'),
      { rootMargin: '160px', threshold: 0 },
    );
    this.visibleObserver ??= new IntersectionObserver((entries) =>
      deliver(entries, 'visible'),
    );
    this.listeners.set(element, { listener, near: false, visible: false });
    this.nearObserver.observe(element);
    this.visibleObserver.observe(element);
    return () => {
      if (this.listeners.get(element)?.listener !== listener) return;
      this.listeners.delete(element);
      this.nearObserver?.unobserve(element);
      this.visibleObserver?.unobserve(element);
    };
  }

  clear() {
    this.nearObserver?.disconnect();
    this.visibleObserver?.disconnect();
    this.nearObserver = null;
    this.visibleObserver = null;
    this.listeners.clear();
  }
}
