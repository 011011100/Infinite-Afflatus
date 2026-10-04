import { ReactFlow, useReactFlow, useStoreApi } from '@xyflow/react';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/styles.css';

// Record native observers without changing delivery timing or callback behavior.
const NativeObserver = window.ResizeObserver;
let containerDelivery = false;
let unmountAfterDelivery = false;
let dimensionWrites = 0;
const monitoredStores = new WeakSet<object>();
let writesDuringDelivery = 0;
let writesAtDisposal: number | null = null;
let scheduledResizeFrames = 0;
let cancelledResizeFrames = 0;
const pendingResizeFrames = new Set<number>();
const nativeRequestFrame = window.requestAnimationFrame.bind(window);
const nativeCancelFrame = window.cancelAnimationFrame.bind(window);
window.requestAnimationFrame = (callback) => {
  const fromResize = containerDelivery;
  const id = nativeRequestFrame((time) => {
    pendingResizeFrames.delete(id);
    callback(time);
  });
  if (fromResize) {
    scheduledResizeFrames++;
    pendingResizeFrames.add(id);
  }
  return id;
};
window.cancelAnimationFrame = (id) => {
  if (pendingResizeFrames.delete(id)) cancelledResizeFrames++;
  nativeCancelFrame(id);
};
const observers: { targets: Set<Element>; detachedDeliveries: number }[] = [];
window.ResizeObserver = class extends NativeObserver {
  private observed: (typeof observers)[number];
  constructor(callback: ResizeObserverCallback) {
    const observed = { targets: new Set<Element>(), detachedDeliveries: 0 };
    super((entries, instance) => {
      observed.detachedDeliveries += entries.filter(
        (entry) => !entry.target.isConnected,
      ).length;
      const isContainer = entries.some((entry) =>
        entry.target.classList.contains('react-flow__renderer'),
      );
      containerDelivery = isContainer;
      try {
        callback(entries, instance);
      } finally {
        containerDelivery = false;
      }
      // Exercise a real teardown while the container measurement frame is pending.
      if (isContainer && unmountAfterDelivery) {
        unmountAfterDelivery = false;
        flushSync(() => controls.show(false));
        writesAtDisposal = dimensionWrites;
      }
    });
    this.observed = observed;
    observers.push(observed);
  }
  override observe(target: Element, options?: ResizeObserverOptions) {
    this.observed.targets.add(target);
    super.observe(target, options);
  }
  override unobserve(target: Element) {
    this.observed.targets.delete(target);
    super.unobserve(target);
  }
  override disconnect() {
    this.observed.targets.clear();
    super.disconnect();
  }
};
const controls = {
  show: (_value: boolean) => {},
  resize: (_width: number, _height: number) => {},
  resizeBurst: (_first: number, _last: number) => {},
  unmountOnResize: () => {
    unmountAfterDelivery = true;
  },
  reset: async () => {},
  zoom: async () => {},
  dimensions: () => ({ width: 0, height: 0 }),
  viewport: () => ({ x: 0, y: 0, zoom: 0 }),
  selectionActive: () => false,
  stats: () => ({
    dimensionWrites,
    writesDuringDelivery,
    writesAtDisposal,
    scheduledResizeFrames,
    cancelledResizeFrames,
    pendingResizeFrames: pendingResizeFrames.size,
    active: observers.filter((observer) => observer.targets.size).length,
    detachedDeliveries: observers.reduce(
      (sum, observer) => sum + observer.detachedDeliveries,
      0,
    ),
    detachedTargets: observers.reduce(
      (sum, observer) =>
        sum +
        [...observer.targets].filter((target) => !target.isConnected).length,
      0,
    ),
  }),
};
Object.assign(window, { xyflowControls: controls });
function Probe() {
  const store = useStoreApi();
  const flow = useReactFlow();
  useEffect(() => {
    // Keep the test subscription through disposal to catch writes to an old store.
    // StrictMode replay must not add a second subscription for the same instance.
    if (!monitoredStores.has(store)) {
      monitoredStores.add(store);
      store.subscribe((next, previous) => {
        if (next.width === previous.width && next.height === previous.height)
          return;
        dimensionWrites++;
        if (containerDelivery) writesDuringDelivery++;
      });
    }
    controls.dimensions = () => ({
      width: store.getState().width,
      height: store.getState().height,
    });
    controls.viewport = flow.getViewport;
    controls.selectionActive = () => store.getState().userSelectionActive;
    controls.reset = async () => {
      await flow.setViewport({ x: 0, y: 0, zoom: 1 });
    };
    controls.zoom = async () => {
      await flow.zoomTo(2);
    };
  }, [flow, store]);
  return null;
}
const nodes = [
  {
    id: 'one',
    position: { x: 40, y: 40 },
    data: { label: '素材' },
    style: { width: 100, height: 80 },
  },
];
const edges: [] = [];
function Fixture() {
  const host = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(true);
  const [size, setSize] = useState({ width: 800, height: 500 });
  useEffect(() => {
    controls.show = setShow;
    controls.resize = (width, height) => setSize({ width, height });
    controls.resizeBurst = (first, last) => {
      if (!host.current) throw new Error('Missing canvas host');
      host.current.style.width = `${first}px`;
      host.current.style.width = `${last}px`;
    };
  }, []);
  return (
    <div ref={host} style={size}>
      {show && (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          selectionOnDrag
          panOnDrag={false}
          minZoom={0.1}
          maxZoom={4}
        >
          <Probe />
        </ReactFlow>
      )}
    </div>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
