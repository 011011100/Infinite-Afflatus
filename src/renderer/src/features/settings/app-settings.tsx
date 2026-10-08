import { useRef, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useContentMotion } from '@/components/ui/use-surface-motion';
import type { LibraryState } from '../../../../shared/models';
import { ArkSettings } from './ark-settings';
import { InteractionSettings } from './interaction-settings';
import { MediaToolsSettings } from './media-tools-settings';
import { StorageSettings } from './storage-settings';

export function AppSettings({
  library,
  onClose,
  run,
  error,
  beforeMigration,
  initialPage = 'interactions',
  currentProjectId = null,
}: {
  library: LibraryState;
  onClose: () => void;
  run: (operation: () => Promise<unknown>) => Promise<void>;
  error: string | null;
  beforeMigration?: (() => Promise<boolean>) | undefined;
  initialPage?: 'interactions' | 'storage' | 'ark';
  currentProjectId?: string | null;
}) {
  const [page, setPage] = useState<
    'interactions' | 'storage' | 'media' | 'ark'
  >(initialPage);
  const content = useRef<HTMLDivElement>(null);
  useContentMotion(content, page);
  return (
    <Modal title="设置" onClose={onClose} error={error}>
      <nav className="mb-6 flex gap-2 border-b pb-4" aria-label="设置分类">
        <SegmentedControl
          className="w-full"
          label="设置分类"
          value={page}
          options={[
            { value: 'interactions', label: '交互与快捷键' },
            { value: 'storage', label: '保存与存储' },
            { value: 'media', label: '视频处理' },
            { value: 'ark', label: '云端生成' },
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
            active={page === 'storage'}
            library={library}
            run={run}
            beforeMigration={beforeMigration}
            currentProjectId={currentProjectId}
          />
        </div>
        <div hidden={page !== 'ark'}>
          <ArkSettings active={page === 'ark'} />
        </div>
        <div hidden={page !== 'media'}>
          <MediaToolsSettings />
        </div>
      </div>
    </Modal>
  );
}
