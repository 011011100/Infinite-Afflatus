import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import type { LibraryState } from '../../../../shared/models';
import { InteractionSettings } from './interaction-settings';
import { StorageSettings } from './storage-settings';

export function AppSettings({
  library,
  onClose,
  run,
  error,
}: {
  library: LibraryState;
  onClose: () => void;
  run: (operation: () => Promise<unknown>) => Promise<void>;
  error: string | null;
}) {
  const [page, setPage] = useState<'interactions' | 'storage'>('interactions');
  return (
    <Modal title="设置" onClose={onClose} error={error}>
      <nav className="mb-6 flex gap-2 border-b pb-4" aria-label="设置分类">
        <Button
          variant={page === 'interactions' ? 'secondary' : 'ghost'}
          aria-pressed={page === 'interactions'}
          onClick={() => setPage('interactions')}
        >
          交互与快捷键
        </Button>
        <Button
          variant={page === 'storage' ? 'secondary' : 'ghost'}
          aria-pressed={page === 'storage'}
          onClick={() => setPage('storage')}
        >
          保存与存储
        </Button>
      </nav>
      <div hidden={page !== 'interactions'}>
        <InteractionSettings settings={library.interactions} run={run} />
      </div>
      <div hidden={page !== 'storage'}>
        <StorageSettings library={library} run={run} />
      </div>
    </Modal>
  );
}
