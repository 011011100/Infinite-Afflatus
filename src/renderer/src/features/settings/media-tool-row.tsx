import { Button } from '@/components/ui/button';
import type {
  MediaToolLocation,
  MediaToolName,
  MediaToolResult,
} from '../../../../shared/media-tools';

const statusLabels: Record<MediaToolResult['status'], string> = {
  available: '可运行',
  missing: '未找到',
  'permission-denied': '无执行权限',
  timeout: '检测超时',
  invalid: '无法识别',
  failed: '启动失败',
};
const sourceLabels: Record<MediaToolLocation['source'], string> = {
  environment: '由环境变量指定',
  saved: '已保存的路径',
  path: '系统搜索路径',
  'standard-location': 'macOS 常见安装位置',
};

export function MediaToolRow({
  name,
  location,
  result,
  saved,
  disabled,
  choose,
  reset,
}: {
  name: MediaToolName;
  location: MediaToolLocation | undefined;
  result: MediaToolResult | undefined;
  saved: boolean;
  disabled: boolean;
  choose: () => void;
  reset: () => void;
}) {
  const label = name === 'ffmpeg' ? 'FFmpeg' : 'FFprobe';
  const managed = location?.source === 'environment';
  return (
    <section className="space-y-2 p-3" aria-label={label}>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span
          className={
            result && result.status !== 'available'
              ? 'text-destructive'
              : 'text-muted-foreground'
          }
        >
          {result ? statusLabels[result.status] : '未检查'}
        </span>
      </div>
      {result?.version && (
        <p className="break-all text-xs">版本 {result.version}</p>
      )}
      {location && (
        <p className="break-all text-xs text-muted-foreground">
          {sourceLabels[location.source]}：
          <span className="select-text">{location.command}</span>
        </p>
      )}
      {result?.detail && (
        <p className="text-xs leading-relaxed text-destructive">
          {result.detail}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || managed}
          aria-label={`选择 ${label} 程序`}
          onClick={choose}
        >
          选择文件
        </Button>
        {saved && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || managed}
            aria-label={`恢复 ${label} 自动查找`}
            onClick={reset}
          >
            恢复自动查找
          </Button>
        )}
      </div>
      {managed && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          此组件由环境变量管理；请修改启动配置并重启应用，此处不能覆盖。
        </p>
      )}
    </section>
  );
}
