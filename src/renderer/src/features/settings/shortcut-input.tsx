import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { isMac } from '@/lib/platform';
import {
  formatShortcut,
  type Shortcut,
  shortcutFromKey,
} from '../../../../shared/interaction/shortcuts';

export function ShortcutInput({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: Shortcut | null;
  disabled: boolean;
  onChange: (value: Shortcut | null) => void;
}) {
  const [recording, setRecording] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <Button
        variant={recording ? 'secondary' : 'outline'}
        disabled={disabled}
        className="min-w-36 justify-center font-mono text-xs"
        aria-label={`${label}快捷键：${recording ? '按下新快捷键，Esc 取消' : formatShortcut(value, isMac)}`}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(event) => {
          if (!recording) return;
          if (event.key === 'Tab') {
            setRecording(false);
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (event.key === 'Escape') {
            setRecording(false);
            return;
          }
          const next = shortcutFromKey(event.nativeEvent, isMac);
          if (!next) return;
          onChange(next);
          setRecording(false);
        }}
      >
        {recording ? '请按快捷键…' : formatShortcut(value, isMac)}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled || !value}
        aria-label={`清除${label}快捷键`}
        onClick={() => onChange(null)}
      >
        清除
      </Button>
    </div>
  );
}
