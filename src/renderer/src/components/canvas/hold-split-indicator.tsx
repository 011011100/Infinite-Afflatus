import { Ungroup } from 'lucide-react';
import { HoldProgress } from '@/components/ui/hold-progress';
import {
  HOLD_HINT_DELAY_MS,
  LONG_PRESS_MS,
} from '../../../../shared/interaction/long-press';

export function HoldSplitIndicator({ ready }: { ready: boolean }) {
  return (
    <HoldProgress
      ready={ready}
      duration={LONG_PRESS_MS - HOLD_HINT_DELAY_MS}
      icon={<Ungroup size={20} />}
      label={ready ? '松开拆分，移动取消' : '长按以拆出卡片'}
    />
  );
}
