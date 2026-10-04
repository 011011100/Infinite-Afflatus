import { ReactFlow, useReactFlow, useStore, useStoreApi } from '@xyflow/react';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/styles.css';

// Record native observers without changing delivery timing or callback behavior.
const NativeObserver = window.ResizeObserver;
let containerDelivery = false;
let nodeDelivery = false;
let unmountAfterDelivery = false;
let unmountAfterNodeDelivery = false;
let replaceAfterNodeDelivery = false;
let dimensionWrites = 0;
const monitoredStores = new WeakSet<object>();
let writesDuringDelivery = 0;
let nodeWritesDuringDelivery = 0;
let nodeDimensionWrites = 0;
let nodeWritesAtDisposal: number | null = null;
let replacedNode: Element | null = null;
let nodeMeasurements: number[] = [];
let writesAtDisposal: number | null = null;
let scheduledResizeFrames = 0;
let cancelledResizeFrames = 0;
const pendingResizeFrames = new Set<number>();
const nativeRequestFrame = window.requestAnimationFrame.bind(window);
const nativeCancelFrame = window.cancelAnimationFrame.bind(window);
window.requestAnimationFrame = (callback) => {
  const fromResize = containerDelivery || nodeDelivery;
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
      const isNode = entries.some((entry) =>
        entry.target.classList.contains('react-flow__node'),
      );
      containerDelivery = isContainer;
      nodeDelivery = isNode;
      // Register disposal before the dependency's measurement frame. This keeps
      // the measurement pending until teardown, without the fixture itself
      // changing layout or observing a replacement during native delivery.
      if (isNode && unmountAfterNodeDelivery) {
        unmountAfterNodeDelivery = false;
        nativeRequestFrame(() => {
          flushSync(() => controls.show(false));
          nodeWritesAtDisposal = nodeDimensionWrites;
        });
      }
      if (isNode && replaceAfterNodeDelivery) {
        replaceAfterNodeDelivery = false;
        replacedNode =
          entries.find((entry) => entry.target.matches('[data-id="one"]'))
            ?.target ?? null;
        nativeRequestFrame(() => {
          flushSync(() => controls.hideNode(true));
          flushSync(() => controls.hideNode(false));
        });
      }
      try {
        callback(entries, instance);
      } finally {
        containerDelivery = false;
        nodeDelivery = false;
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
  reportNodeMeasurements: (_value: boolean) => {},
  resizeNode: (_width: number) => {},
  hideNode: (_value: boolean) => {},
  replaceOnNodeResize: () => {
    nodeMeasurements = [];
    replaceAfterNodeDelivery = true;
  },
  unmountOnResize: () => {
    unmountAfterDelivery = true;
  },
  unmountOnNodeResize: () => {
    unmountAfterNodeDelivery = true;
  },
  reset: async () => {},
  zoom: async () => {},
  dimensions: () => ({ width: 0, height: 0 }),
  nodeWidth: () => 0,
  viewport: () => ({ x: 0, y: 0, zoom: 0 }),
  selectionActive: () => false,
  stats: () => ({
    dimensionWrites,
    writesDuringDelivery,
    nodeWritesDuringDelivery,
    nodeDimensionWrites,
    nodeWritesAtDisposal,
    nodeMeasurements,
    replacementIsNew:
      !!replacedNode &&
      !replacedNode.isConnected &&
      document.querySelector('[data-id="one"]') !== replacedNode,
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
function Probe({ report }: { report: boolean }) {
  const store = useStoreApi();
  const flow = useReactFlow();
  const measuredWidth = useStore(
    (state) => state.nodeLookup.get('one')?.measured.width ?? 0,
  );
  useEffect(() => {
    // Keep the test subscription through disposal to catch writes to an old store.
    // StrictMode replay must not add a second subscription for the same instance.
    if (!monitoredStores.has(store)) {
      monitoredStores.add(store);
      let lastMeasured = store.getState().nodeLookup.get('one')?.measured.width;
      store.subscribe((next, previous) => {
        const measured = next.nodeLookup.get('one')?.measured.width;
        if (measured !== lastMeasured) {
          lastMeasured = measured;
          nodeDimensionWrites++;
          if (measured !== undefined) nodeMeasurements.push(measured);
          if (nodeDelivery) nodeWritesDuringDelivery++;
        }
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
    controls.nodeWidth = () =>
      store.getState().nodeLookup.get('one')?.measured.width ?? 0;
    controls.viewport = flow.getViewport;
    controls.selectionActive = () => store.getState().userSelectionActive;
    controls.reset = async () => {
      await flow.setViewport({ x: 0, y: 0, zoom: 1 });
    };
    controls.zoom = async () => {
      await flow.zoomTo(2);
    };
  }, [flow, store]);
  const header = document.getElementById('measurement-header');
  // A real measured-node store consumer changes an already observed ancestor pane.
  // Publishing inside native node delivery deterministically produces the browser's
  // undelivered-notifications warning, even with the container observer deferred.
  return report && measuredWidth > 100 && header
    ? createPortal(
        <div style={{ height: 28 }}>素材测量完成：{measuredWidth}</div>,
        header,
      )
    : null;
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
  const [report, setReport] = useState(false);
  const [hideNode, setHideNode] = useState(false);
  useEffect(() => {
    controls.show = setShow;
    controls.resize = (width, height) => setSize({ width, height });
    controls.reportNodeMeasurements = setReport;
    controls.hideNode = setHideNode;
    controls.resizeNode = (width) => {
      const node = document.querySelector<HTMLElement>('[data-id="one"]');
      if (!node) throw new Error('Missing node');
      node.style.width = `${width}px`;
    };
    controls.resizeBurst = (first, last) => {
      if (!host.current) throw new Error('Missing canvas host');
      host.current.style.width = `${first}px`;
      host.current.style.width = `${last}px`;
    };
  }, []);
  return (
    <div
      ref={host}
      style={{ ...size, display: 'flex', flexDirection: 'column' }}
    >
      <div id="measurement-header" style={{ flexShrink: 0 }} />
      {show && (
        <ReactFlow
          nodes={hideNode ? [] : nodes}
          edges={edges}
          selectionOnDrag
          panOnDrag={false}
          minZoom={0.1}
          maxZoom={4}
          style={{ flex: 1, minHeight: 0 }}
        >
          <Probe report={report} />
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
