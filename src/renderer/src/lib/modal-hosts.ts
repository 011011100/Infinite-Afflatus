export type ModalHost = {
  dialog: HTMLDialogElement;
  host: HTMLElement;
};

const hosts: ModalHost[] = [];
const listeners = new Set<() => void>();

export const getModalHost = (): ModalHost | null => hosts.at(-1) ?? null;

export function subscribeModalHosts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Register immediately after showModal(): DOM order does not describe the
// browser's top-layer order when several independent dialogs are open.
export function registerModal(dialog: HTMLDialogElement) {
  const entry: ModalHost = {
    dialog,
    host:
      dialog.querySelector<HTMLElement>('[data-save-status-host]') ?? dialog,
  };
  hosts.push(entry);
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const release = () => {
    const index = hosts.indexOf(entry);
    if (index === -1) return;
    hosts.splice(index, 1);
    dialog.removeEventListener('close', onClose);
    publish();
  };
  const onClose = () => {
    // A queued close event from a StrictMode cleanup may arrive after reopening.
    if (!dialog.open) release();
  };
  dialog.addEventListener('close', onClose);
  publish();
  return release;
}
