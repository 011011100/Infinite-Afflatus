import { Image, Type } from 'lucide-react';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import {
  IMAGE_RATIOS,
  type ImageGenerationParameters,
} from '../../../../shared/generation/image-generation';
import { GenerationSettingsPanel } from './generation-settings-panel';

export function ImageGenerationSettings({
  value,
  references,
  onChange,
}: {
  value: ImageGenerationParameters;
  references: number;
  onChange: (value: ImageGenerationParameters) => void;
}) {
  return (
    <GenerationSettingsPanel label="图片生成设置" action="生成图片">
      <div className="flex items-center gap-2 rounded-lg bg-primary/5 px-3 py-2.5 text-sm text-primary">
        {references ? (
          <Image className="size-4" />
        ) : (
          <Type className="size-4" />
        )}
        <span>{references ? '图生图' : '文生图'}</span>
        {references > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">
            {references} 张参考图
          </span>
        )}
      </div>
      <div className="space-y-2">
        <label
          htmlFor="image-generation-model"
          className="text-xs text-muted-foreground"
        >
          图片模型
        </label>
        <Select
          id="image-generation-model"
          value={value.model}
          onChange={(event) => {
            const model = event.target
              .value as ImageGenerationParameters['model'];
            onChange({
              ...value,
              model,
              resolution:
                model === 'seedream-4.5' && value.resolution === '3K'
                  ? '2K'
                  : value.resolution,
            });
          }}
        >
          <option value="seedream-5.0-lite">Seedream 5.0 Lite</option>
          <option value="seedream-4.5">Seedream 4.5</option>
        </Select>
      </div>
      <div className="space-y-2">
        <label
          htmlFor="image-generation-ratio"
          className="text-xs text-muted-foreground"
        >
          画面比例
        </label>
        <Select
          id="image-generation-ratio"
          value={value.ratio}
          onChange={(event) =>
            onChange({
              ...value,
              ratio: event.target.value as ImageGenerationParameters['ratio'],
            })
          }
        >
          {IMAGE_RATIOS.map((ratio) => (
            <option key={ratio} value={ratio}>
              {ratio === 'adaptive' ? '自动适配' : ratio}
            </option>
          ))}
        </Select>
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-xs text-muted-foreground">分辨率</legend>
        <SegmentedControl
          label="图片分辨率"
          value={value.resolution}
          options={(['2K', '3K', '4K'] as const).map((resolution) => ({
            value: resolution,
            label: resolution,
            disabled: resolution === '3K' && value.model === 'seedream-4.5',
            title:
              resolution === '3K' && value.model === 'seedream-4.5'
                ? 'Seedream 4.5 不支持 3K'
                : undefined,
          }))}
          onChange={(resolution) => onChange({ ...value, resolution })}
        />
      </fieldset>
    </GenerationSettingsPanel>
  );
}
