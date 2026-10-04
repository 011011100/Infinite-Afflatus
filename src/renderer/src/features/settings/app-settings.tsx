import { useRef, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useContentMotion } from '@/components/ui/use-surface-motion';
import type { LibraryState } from '../../../../shared/models';
import { InteractionSettings } from './interaction-settings';
import { StorageSettings } from './storage-settings';

export function AppSettings({
  library,
  onClose,
  run,
  error,
  beforeMigration,
  initialPage = 'interactions',
}: {
  library: LibraryState;
  onClose: () => void;
  run: (operation: () => Promise<unknown>) => Promise<void>;
  error: string | null;
  beforeMigration?: (() => Promise<boolean>) | undefined;
  initialPage?: 'interactions' | 'storage';
}) {
  const [page, setPage] = useState<'interactions' | 'storage'>(initialPage);
  const content = useRef<HTMLDivElement>(null);
  useContentMotion(content, page);
  return (
    <Modal title="设置" onClose={onClose} error={error}>
      <nav className="mb-6 flex gap-2 border-b pb-4" aria-label="设置分类">
        <SegmentedControl
          className="w-72"
          label="设置分类"
          value={page}
          options={[
            { value: 'interactions', label: '交互与快捷键' },
            { value: 'storage', label: '保存与存储' },
          ]}
          onChange={setPage}
        />
      </nav>
      <div ref={content}>
        <div hidden={page !== 'interactions'}>
          <InteractionSettings settings={library.interactions} run={run} />
        </div>
        <div hidden={page !== 'storage'}>
          <StorageSettings
            library={library}
            run={run}
            beforeMigration={beforeMigration}
          />
        </div>
      </div>
    </Modal>
  );
}
