import { pauseLocalPackageRequests } from './local-package-requests';

/** Freeze admission now; drain both pre-IPC requests and the native write gate. */
export function pausePackageOperations() {
  const local = pauseLocalPackageRequests();
  let token: string | null = null;
  let released = false;
  let releasePromise: Promise<void> | null = null;
  const release = (): Promise<void> => {
    released = true;
    local.release();
    if (token) {
      const current = token;
      token = null;
      releasePromise = window.desktop.resumePackageOperations(current);
    }
    return releasePromise ?? Promise.resolve();
  };
  const native = window.desktop
    .preparePackageOperationsForLeave()
    .then(async (value) => {
      token = value;
      // A native close may time out while its pause acknowledgement is in flight.
      // The late acknowledgement can release only this attempt's own lease.
      if (released) await release();
    });
  const ready = Promise.allSettled([native, local.stopped]).then((results) => {
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  });
  return { ready, release };
}
