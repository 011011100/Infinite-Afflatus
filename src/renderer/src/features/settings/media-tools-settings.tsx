import { Button } from '@/components/ui/button';
import { MediaToolRow } from './media-tool-row';
import { useMediaToolSettings } from './use-media-tool-settings';

const busyLabels = {
  loading: '正在读取组件设置…',
  checking: '正在读取本机组件版本，最多约 5 秒。',
  choosing: '请选择组件文件，选择后将验证并保存。',
  resetting: '正在恢复自动查找并检查组件…',
};

export function MediaToolsSettings() {
  const state = useMediaToolSettings();
  const { settings, report, busy, error, notice } = state;
  const invalid = !!settings && (!settings.paths || !!settings.error);
  const unavailable = report?.tools.some((tool) => tool.status !== 'available');
  return (
    <section className="space-y-4" aria-label="视频处理组件">
      <div>
        <h3 className="text-sm font-medium">视频导出与代理预览组件</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          FFmpeg 负责视频处理，FFprobe
          读取媒体信息。组件缺失时仍可管理项目、导入视频和播放原片，成片导出需要两个组件。
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          disabled={!!busy || invalid}
          onClick={() => void (settings ? state.check() : state.load())}
        >
          {!settings && error
            ? '重新读取设置'
            : report
              ? '重新检查'
              : '检查组件'}
        </Button>
        <p
          className="text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {busy
            ? busyLabels[busy]
            : (notice ??
              (report
                ? `上次检查：${new Date(report.checkedAt).toLocaleString()}`
                : '检查时读取本机组件版本，不读取项目素材。'))}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {invalid && (
        <div className="space-y-3 rounded-lg border border-destructive/40 p-3">
          <p role="alert" className="text-sm text-destructive">
            {settings?.error ?? '已保存的组件配置无法读取。'}{' '}
            原配置已保留，不能单独修改路径。
          </p>
          <Button
            variant="outline"
            disabled={!!busy}
            onClick={() => void state.reset('all')}
          >
            清除两项路径并恢复自动查找
          </Button>
          <p className="text-xs text-muted-foreground">
            此操作只清除应用保存的两项组件路径，环境变量仍然优先。
          </p>
        </div>
      )}
      <div className="divide-y rounded-lg border" aria-busy={!!busy}>
        {(['ffmpeg', 'ffprobe'] as const).map((name) => (
          <MediaToolRow
            key={name}
            name={name}
            location={settings?.locations[name]}
            result={report?.tools.find((tool) => tool.name === name)}
            saved={!!settings?.paths?.[name]}
            disabled={!!busy || !settings || invalid}
            choose={() => void state.choose(name)}
            reset={() => void state.reset(name)}
          />
        ))}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        保存的路径立即用于新任务；运行中的导出与代理预览继续使用原来的组件。
      </p>
      {unavailable && (
        <p className="rounded-lg bg-warning p-3 text-sm leading-relaxed text-warning-foreground">
          请安装适用于本机的 FFmpeg 工具，包含 ffmpeg 和
          ffprobe，并确认有执行权限。
          可在此选择组件文件后重新检查；已有项目与原片可以继续使用。修改环境变量后需重启应用。
        </p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        仅在安装包明确包含并通过完整性校验时使用内置组件。版本检查只确认组件能够启动并读取版本，不代表已验证
        libx264、AAC 编码器或所有视频格式的兼容性。
      </p>
      <details className="rounded-lg border p-3 text-xs leading-relaxed">
        <summary className="cursor-pointer font-medium">高级配置与排查</summary>
        <div className="mt-3 space-y-2 text-muted-foreground">
          <p>
            环境变量 FFMPEG_PATH、FFPROBE_PATH
            可分别指定可执行文件的完整路径，路径不带引号或命令参数。环境变量优先于此处保存的路径；明确指定的路径错误时不会自动改用其他组件。
          </p>
          <p>
            没有指定路径时优先使用通过校验的内置组件；安装包未附带组件时使用应用启动时的系统
            PATH。内置组件校验失败时不会自动回退。macOS 还会检查
            /opt/homebrew/bin 与 /usr/local/bin 下真实存在且可执行的工具。从
            Finder 启动时，应用可能无法读取终端的 PATH 配置。
          </p>
          <p>
            “未找到”：检查是否安装了两个工具及路径是否正确。“无执行权限／启动失败”：检查组件是否适用于当前操作系统和处理器，并查看系统的权限或安全提示。“检测超时／无法识别”：确认配置指向
            ffmpeg 或 ffprobe 本身。
          </p>
          <p>检测结果仅展示在本机，不上传诊断信息，也不会自动下载安装。</p>
        </div>
      </details>
    </section>
  );
}
