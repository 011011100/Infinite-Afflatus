// Observes real browser resources; native media/canvas calls still run unchanged.
// WeakRef prevents the measurement itself from keeping released resources alive.
export function installMediaResourceObserver() {
  const videos = [];
  const canvases = [];
  const seen = new WeakMap();
  const painted = new WeakSet();
  const events = [];
  const marks = [];
  let serial = 0;
  let activePeak = 0;
  let managedActivePeak = 0;
  let editorActivePeak = 0;
  let pixelPeak = 0;
  let firstPaint = null;
  let started = performance.now();
  const now = () => Math.round((performance.now() - started) * 100) / 100;
  const emit = (type, record, extra = {}) => {
    if (events.length < 100000)
      events.push({
        at: now(),
        wallTime: Date.now(),
        type,
        id: record.id,
        role: record.role,
        ...extra,
      });
  };
  const sampleSources = () => {
    let activeSources = 0;
    let activeManagedSources = 0;
    let activeEditorSources = 0;
    for (const record of videos) {
      const video = record.ref.deref();
      if (video?.getAttribute('src')) {
        activeSources++;
        if (record.role === 'editor-media') activeEditorSources++;
        else activeManagedSources++;
      }
    }
    activePeak = Math.max(activePeak, activeSources);
    managedActivePeak = Math.max(managedActivePeak, activeManagedSources);
    editorActivePeak = Math.max(editorActivePeak, activeEditorSources);
    return {
      activeSources,
      activePeak,
      activeManagedSources,
      activeEditorSources,
      managedActivePeak,
      editorActivePeak,
    };
  };
  const samplePixels = () => {
    let canvasPixels = 0;
    let connectedCanvasPixels = 0;
    let initializedCanvasPixels = 0;
    let liveCanvases = 0;
    for (const record of canvases) {
      const canvas = record.ref.deref();
      if (!canvas) continue;
      liveCanvases++;
      canvasPixels += canvas.width * canvas.height;
      if (record.hasContext)
        initializedCanvasPixels += canvas.width * canvas.height;
      if (canvas.isConnected)
        connectedCanvasPixels += canvas.width * canvas.height;
    }
    pixelPeak = Math.max(pixelPeak, canvasPixels);
    return {
      liveCanvases,
      canvasPixels,
      connectedCanvasPixels,
      initializedCanvasPixels,
      pixelPeak,
    };
  };
  // React can reset hundreds of canvases in one commit. Coalesce the pixel
  // inventory to avoid adding quadratic measurement work to regrouping.
  let pixelScheduled = false;
  const schedulePixels = () => {
    if (pixelScheduled) return;
    pixelScheduled = true;
    queueMicrotask(() => {
      pixelScheduled = false;
      samplePixels();
    });
  };
  const sample = () => {
    return {
      at: now(),
      ...sampleSources(),
      ...samplePixels(),
      videosCreated: videos.length,
      canvasesCreated: canvases.length,
      firstPaint,
    };
  };
  const track = (element) => {
    let record = seen.get(element);
    if (record) return record;
    record = { id: ++serial, ref: new WeakRef(element) };
    seen.set(element, record);
    if (element instanceof HTMLVideoElement) {
      videos.push(record);
      emit('video-created', record);
      for (const name of [
        'loadstart',
        'loadedmetadata',
        'loadeddata',
        'seeked',
        'error',
        'emptied',
      ])
        element.addEventListener(name, () => {
          emit(name, record, {
            source: element.currentSrc || element.getAttribute('src'),
            readyState: element.readyState,
            width: element.videoWidth,
            height: element.videoHeight,
            duration: Number.isFinite(element.duration)
              ? element.duration
              : null,
            decodedFrames: element.webkitDecodedFrameCount ?? null,
            error: element.error?.code ?? null,
          });
          sampleSources();
        });
    } else if (element instanceof HTMLCanvasElement) {
      canvases.push(record);
    }
    return record;
  };
  const create = Document.prototype.createElement;
  Document.prototype.createElement = function (...args) {
    const result = Reflect.apply(create, this, args);
    if (
      result instanceof HTMLVideoElement ||
      result instanceof HTMLCanvasElement
    )
      track(result);
    return result;
  };
  const source = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    'src',
  );
  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    ...source,
    set(value) {
      source.set.call(this, value);
      if (this instanceof HTMLVideoElement) {
        const record = track(this);
        record.role = document.querySelector('[aria-label="组合播放时间"]')
          ? 'editor-media'
          : 'thumbnail-or-metadata';
        emit('src', record, { source: value, preload: this.preload });
        sampleSources();
      }
    },
  });
  const load = HTMLMediaElement.prototype.load;
  HTMLMediaElement.prototype.load = function (...args) {
    if (this instanceof HTMLVideoElement) {
      emit('load', track(this), { source: this.getAttribute('src') });
      sampleSources();
    }
    return Reflect.apply(load, this, args);
  };
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const result = Reflect.apply(getContext, this, args);
    if (result) track(this).hasContext = true;
    return result;
  };
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    const result = Reflect.apply(draw, this, args);
    track(this.canvas);
    if (args[0] instanceof HTMLVideoElement) {
      const video = args[0];
      emit('draw-video', track(video), {
        source: video.currentSrc || video.getAttribute('src'),
        preload: video.preload,
        width: this.canvas.width,
        height: this.canvas.height,
        sourceWidth: video.videoWidth,
        sourceHeight: video.videoHeight,
      });
    }
    painted.add(this.canvas);
    if (this.canvas.isConnected && firstPaint === null) firstPaint = now();
    schedulePixels();
    return result;
  };
  for (const name of ['width', 'height']) {
    const property = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      name,
    );
    Object.defineProperty(HTMLCanvasElement.prototype, name, {
      ...property,
      set(value) {
        property.set.call(this, value);
        painted.delete(this);
        track(this);
        schedulePixels();
      },
    });
  }
  window.__mediaResources = {
    begin() {
      started = performance.now();
      firstPaint = null;
    },
    sample,
    checkpoint: () => ({
      eventIndex: events.length,
      at: now(),
      wallTime: Date.now(),
    }),
    since: (index) => events.slice(index),
    visible() {
      return [...document.querySelectorAll('[data-video-thumbnail]')]
        .filter((element) => {
          let rect = element.getBoundingClientRect();
          let left = Math.max(0, rect.left);
          let right = Math.min(innerWidth, rect.right);
          let top = Math.max(0, rect.top);
          let bottom = Math.min(innerHeight, rect.bottom);
          for (
            let node = element.parentElement;
            node;
            node = node.parentElement
          ) {
            const style = getComputedStyle(node);
            if (
              /(hidden|auto|scroll)/.test(style.overflowX + style.overflowY)
            ) {
              rect = node.getBoundingClientRect();
              left = Math.max(left, rect.left);
              right = Math.min(right, rect.right);
              top = Math.max(top, rect.top);
              bottom = Math.min(bottom, rect.bottom);
            }
          }
          return right - left > 2 && bottom - top > 2;
        })
        .map((element) => ({
          assetId: element.dataset.assetId,
          painted:
            !!element.querySelector('canvas') &&
            element.querySelector('canvas').width > 0 &&
            element.querySelector('canvas').height > 0 &&
            painted.has(element.querySelector('canvas')),
        }));
    },
    displayCanvases() {
      return [...document.querySelectorAll('[data-video-thumbnail]')].map(
        (element) => {
          const canvas = element.querySelector('canvas');
          return {
            assetId: element.dataset.assetId,
            width: canvas?.width ?? 0,
            height: canvas?.height ?? 0,
          };
        },
      );
    },
    decoded(assetId) {
      return events.filter(
        (event) =>
          event.type === 'loadeddata' && event.source?.includes(`/${assetId}`),
      ).length;
    },
    mark(name) {
      const result = { name, ...sample(), visible: this.visible() };
      marks.push(result);
      return result;
    },
    result: () => ({ marks, events, ...sample() }),
  };
}
