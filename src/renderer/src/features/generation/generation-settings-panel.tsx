import { Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/** Shared settings surface and honest submission state for local generation drafts. */
export function GenerationSettingsPanel({
  label = '生成设置',
  action,
  children,
}: {
  label?: string;
  action: string;
  children: ReactNode;
}) {
  return (
    <aside
      className="generation-settings flex min-h-0 flex-col overflow-y-auto rounded-2xl border bg-card p-5 shadow-sm"
      aria-label={label}
    >
      <h2 className="mb-6 text-sm font-medium">生成设置</h2>
      <div className="space-y-6">{children}</div>
      <div className="mt-auto pt-10">
        <Button disabled className="h-10 w-full">
          <Sparkles />
          {action}
        </Button>
        <p className="mt-3 text-center text-xs text-muted-foreground">
          尚未接入生成服务
        </p>
      </div>
    </aside>
  );
}
