import { Image, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContextMenuItem } from '@/components/ui/context-menu';

interface GroupingActions {
  count: number;
  hasGroups: boolean;
  canGroup: boolean;
  imageError: string | null;
  groupError: string | null;
  disabled: boolean;
  group: (kind?: 'image' | 'video') => void;
}

function choices(value: GroupingActions) {
  if (value.hasGroups)
    return [
      {
        label: '合并成组',
        icon: Sparkles,
        disabled: value.disabled || !value.canGroup,
        reason: value.groupError,
        action: () => value.group(),
      },
    ];
  return [
    {
      label: '生成图片',
      icon: Image,
      disabled: value.disabled || !value.canGroup || !!value.imageError,
      reason: value.imageError,
      action: () => value.group('image'),
    },
    {
      label: '生成视频',
      icon: Sparkles,
      disabled: value.disabled || !value.canGroup,
      reason: null,
      action: () => value.group('video'),
    },
  ];
}

/** Context menu and selection toolbar invoke exactly the same grouping actions. */
export function MaterialGenerationActions({
  menu = false,
  ...value
}: GroupingActions & { menu?: boolean }) {
  const actions = choices(value);
  if (menu)
    return (
      <>
        {actions.map(({ label, icon: Icon, disabled, reason, action }) => (
          <ContextMenuItem
            key={label}
            disabled={disabled}
            title={reason ?? undefined}
            onClick={action}
          >
            <Icon />
            {label}
          </ContextMenuItem>
        ))}
      </>
    );
  return (
    <div className="rounded-xl border bg-background p-1.5 shadow-md">
      <div className="flex items-center gap-1.5">
        <span className="px-2 text-xs text-muted-foreground">
          已选 {value.count} 个素材
        </span>
        {actions.map(({ label, icon: Icon, disabled, reason, action }) => (
          <Button
            key={label}
            disabled={disabled}
            title={reason ?? undefined}
            onClick={action}
          >
            <Icon />
            {label}
          </Button>
        ))}
      </div>
      {value.groupError && (
        <p
          className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground"
          role="status"
        >
          {value.groupError}
        </p>
      )}
    </div>
  );
}
