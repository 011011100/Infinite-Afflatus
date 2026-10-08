import { Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/** Shared settings surface and honest submission state for local generation drafts. */
export function GenerationSettingsPanel({
  label = '生成设置',
  action,
  children,
  actions,
  disabled = false,
}: {
  label?: string;
  action: string;
  children: ReactNode;
  actions?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <aside
      className="generation-settings flex min-h-0 flex-col overflow-y-auto rounded-2xl border bg-card p-5 shadow-sm"
      aria-label={label}
    >
      <h2 className="mb-6 text-sm font-medium">生成设置</h2>
      <fieldset disabled={disabled} className="space-y-6">
        {children}
      </fieldset>
      <div className="mt-auto pt-10">
        {actions ?? (
          <>
            <Button disabled className="h-10 w-full">
              <Sparkles />
              {action}
            </Button>
            <p className="mt-3 text-center text-xs text-muted-foreground">
              请在生成组中确认提交
            </p>
          </>
        )}
      </div>
    </aside>
  );
}
