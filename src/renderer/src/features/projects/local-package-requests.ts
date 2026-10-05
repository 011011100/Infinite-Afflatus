type Request = { cancel: () => Promise<void> };
const requests = new Set<Request>();
const pauses = new Set<object>();

/** Covers the renderer's save-before-start interval, before native knows the request. */
export const packageRequestsPaused = () => pauses.size > 0;

export function registerPackageRequest(
  cancel: () => Promise<void>,
): () => void {
  const request = { cancel };
  requests.add(request);
  return () => requests.delete(request);
}

export function pauseLocalPackageRequests() {
  const token = {};
  pauses.add(token);
  // cancel() marks each request synchronously, so a pending save cannot start
  // its native operation between this call and the first leave await.
  const stopped = Promise.allSettled(
    [...requests].map((item) => item.cancel()),
  );
  return {
    stopped: stopped.then((results) => {
      const failed = results.find((item) => item.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }),
    release: () => pauses.delete(token),
  };
}
