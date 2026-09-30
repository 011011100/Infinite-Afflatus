import { Sparkles, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import {
  GENERATION_RATIOS,
  type GenerationParameters,
} from '../../../../shared/generation/draft';

export function GenerationSettings({
  value,
  onChange,
}: {
  value: GenerationParameters;
  onChange: (value: GenerationParameters) => void;
}) {
  return (
    <aside
      className="generation-settings flex min-h-0 flex-col overflow-y-auto rounded-2xl border bg-card p-5 shadow-sm"
      aria-label="生成设置"
    >
      <h2 className="mb-6 text-sm font-medium">生成设置</h2>
      <div className="space-y-6">
        <div className="space-y-2">
          <label
            htmlFor="generation-model"
            className="text-xs text-muted-foreground"
          >
            视频模型
          </label>
          <Select
            id="generation-model"
            value={value.model}
            onChange={(event) => {
              const model = event.target.value as GenerationParameters['model'];
              onChange({
                ...value,
                model,
                resolution:
                  model === 'seedance-2.0-fast' && value.resolution === '1080p'
                    ? '720p'
                    : value.resolution,
              });
            }}
          >
            <option value="seedance-2.0">Seedance 2.0</option>
            <option value="seedance-2.0-fast">Seedance 2.0 Fast</option>
          </Select>
          <p className="text-[11px] text-muted-foreground">全能参考</p>
        </div>
        <div className="space-y-2">
          <label
            htmlFor="generation-ratio"
            className="text-xs text-muted-foreground"
          >
            画面比例
          </label>
          <Select
            id="generation-ratio"
            value={value.ratio}
            onChange={(event) =>
              onChange({
                ...value,
                ratio: event.target.value as GenerationParameters['ratio'],
              })
            }
          >
            {GENERATION_RATIOS.map((ratio) => (
              <option key={ratio} value={ratio}>
                {ratio === 'adaptive' ? '自动适配' : ratio}
              </option>
            ))}
          </Select>
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-xs text-muted-foreground">分辨率</legend>
          <div className="flex gap-1 rounded-lg bg-secondary p-1">
            {(['480p', '720p', '1080p'] as const).map((resolution) => (
              <Button
                key={resolution}
                size="sm"
                className={`flex-1 px-1 text-xs ${value.resolution === resolution ? 'bg-background text-primary shadow-sm hover:bg-background' : ''}`}
                variant="ghost"
                aria-pressed={value.resolution === resolution}
                disabled={
                  resolution === '1080p' && value.model === 'seedance-2.0-fast'
                }
                title={
                  resolution === '1080p' && value.model === 'seedance-2.0-fast'
                    ? 'Fast 不支持 1080p'
                    : undefined
                }
                onClick={() => onChange({ ...value, resolution })}
              >
                {resolution}
              </Button>
            ))}
          </div>
        </fieldset>
        <div className="space-y-2">
          <label
            htmlFor="generation-duration"
            className="text-xs text-muted-foreground"
          >
            视频时长
          </label>
          <Select
            id="generation-duration"
            value={value.duration}
            onChange={(event) =>
              onChange({ ...value, duration: Number(event.target.value) })
            }
          >
            <option value={-1}>智能选择</option>
            {Array.from({ length: 12 }, (_, i) => i + 4).map((seconds) => (
              <option value={seconds} key={seconds}>
                {seconds} 秒
              </option>
            ))}
          </Select>
        </div>
        <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
          <span className="flex items-center gap-2">
            <Volume2 className="size-4 text-muted-foreground" />
            生成声音
          </span>
          <input
            type="checkbox"
            className="size-4 cursor-pointer accent-primary"
            checked={value.generateAudio}
            onChange={(event) =>
              onChange({ ...value, generateAudio: event.target.checked })
            }
          />
        </label>
      </div>
      <div className="mt-auto pt-10">
        <Button disabled className="h-10 w-full">
          <Sparkles />
          生成视频
        </Button>
        <p className="mt-3 text-center text-xs text-muted-foreground">
          尚未接入生成服务
        </p>
      </div>
    </aside>
  );
}
