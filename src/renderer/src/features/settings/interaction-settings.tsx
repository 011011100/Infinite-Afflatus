import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { isMac } from '@/lib/platform';
import {
  defaultInteractionSettings,
  type InteractionSettings as Settings,
  validateInteractionSettings,
} from '../../../../shared/interaction/settings';
import {
  SHORTCUT_ACTIONS,
  SHORTCUT_LABELS,
} from '../../../../shared/interaction/shortcuts';
import { ShortcutInput } from './shortcut-input';

export function InteractionSettings({
  settings,
  run,
}: {
  settings: Settings;
  run: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const change = (next: Settings) => {
    setSaved(false);
    try {
      validateInteractionSettings(next);
      setDraft(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <div className="space-y-6">
      <div className="space-y-3 text-sm">
        <p>
          <span className="font-medium">双击卡片</span>
          <span className="ml-3 text-muted-foreground">
            打开全窗口播放与裁剪，组合按原顺序播放。
          </span>
        </p>
        <label className="flex cursor-pointer items-center justify-between gap-4">
          <span className="font-medium">长按卡片拆分</span>
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={draft.longPressSplit}
            disabled={saving}
            onChange={(event) =>
              change({ ...draft, longPressSplit: event.target.checked })
            }
          />
        </label>
        <p className="text-xs leading-5 text-muted-foreground">
          按住组内卡片 0.7 秒后松开拆出；移动、提前松开或按 Esc
          取消。适用于视频组合与镜头素材组；视频前后两侧各自保留连续组合。
        </p>
      </div>
      <section className="border-t pt-5" aria-labelledby="shortcuts-heading">
        <h3 id="shortcuts-heading" className="text-sm font-medium">
          画布快捷键
        </h3>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          点击右侧按键重新设置。可用字母、数字、空格、方向键，搭配
          {isMac ? ' ⌘、Shift' : ' Ctrl、Shift'}
          。输入文字或打开弹窗时不会触发画布操作。
        </p>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          素材画布默认用方向键每次移动所选素材 5 个画布单位，Shift 加方向键移动
          20
          个单位。每次按下执行一步，按住不重复；按钮、输入框和媒体控件保留原有键盘操作。
        </p>
        <div className="mt-3 divide-y">
          {SHORTCUT_ACTIONS.map((action) => (
            <div
              key={action}
              className="flex items-center justify-between gap-4 py-3"
            >
              <span className="text-sm">{SHORTCUT_LABELS[action]}</span>
              <ShortcutInput
                label={SHORTCUT_LABELS[action]}
                value={draft.shortcuts[action]}
                disabled={saving}
                onChange={(value) =>
                  change({
                    ...draft,
                    shortcuts: { ...draft.shortcuts, [action]: value },
                  })
                }
              />
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Esc 固定用于取消操作和关闭弹窗。
        </p>
      </section>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-4">
        <Button
          variant="ghost"
          disabled={saving}
          onClick={() => change(defaultInteractionSettings())}
        >
          恢复默认
        </Button>
        <div className="flex items-center gap-3">
          {saved && (
            <span role="status" className="text-xs text-muted-foreground">
              已保存
            </span>
          )}
          <Button
            disabled={saving || !!error}
            onClick={() => {
              setSaving(true);
              void run(async () => {
                await window.desktop.saveInteractions(draft);
                setSaved(true);
              }).finally(() => setSaving(false));
            }}
          >
            {saving ? '正在保存…' : '保存设置'}
          </Button>
        </div>
      </div>
    </div>
  );
}
