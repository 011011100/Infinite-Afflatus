import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type {
  MediaToolResult,
  MediaToolsReport,
} from '../../../../shared/media-tools';

const statusLabels: Record<MediaToolResult['status'], string> = {
  available: '可运行',
  missing: '未找到',
  'permission-denied': '无执行权限',
  timeout: '检测超时',
  invalid: '无法识别',
  failed: '启动失败',
};
const sourceLabels: Record<MediaToolResult['source'], string> = {
  environment: '指定的组件',
  path: '系统搜索路径',
  'standard-location': 'macOS 常见安装位置',
};

export function MediaToolsSettings() {
  const [report, setReport] = useState<MediaToolsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await window.desktop.checkMediaTools());
    } catch {
      setError('暂时无法完成组件检查，请稍后重试。');
    } finally {
      setBusy(false);
    }
  };
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
        <Button variant="outline" disabled={busy} onClick={() => void check()}>
          {busy ? '正在检查…' : report ? '重新检查' : '检查组件'}
        </Button>
        <p
          className="text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {busy
            ? '正在读取本机组件版本，最多约 5 秒。'
            : report
              ? `上次检查：${new Date(report.checkedAt).toLocaleString()}`
              : '点击后检查本机组件，不读取项目素材。'}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="divide-y rounded-lg border" aria-busy={busy}>
        {(['ffmpeg', 'ffprobe'] as const).map((name) => {
          const tool = report?.tools.find((item) => item.name === name);
          return (
            <div key={name} className="space-y-2 p-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">
                  {name === 'ffmpeg' ? 'FFmpeg' : 'FFprobe'}
                </span>
                <span
                  className={
                    tool && tool.status !== 'available'
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                  }
                >
                  {tool ? statusLabels[tool.status] : '未检查'}
                </span>
              </div>
              {tool?.version && (
                <p className="break-all text-xs">版本 {tool.version}</p>
              )}
              {tool && (
                <p className="break-all text-xs text-muted-foreground">
                  {sourceLabels[tool.source]}：
                  <span className="select-text">{tool.command}</span>
                </p>
              )}
              {tool?.detail && (
                <p className="text-xs leading-relaxed text-destructive">
                  {tool.detail}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {unavailable && (
        <p className="rounded-lg bg-warning p-3 text-sm leading-relaxed text-warning-foreground">
          请安装适用于本机的 FFmpeg 工具，包含 ffmpeg 和
          ffprobe，并确认有执行权限。安装或修改配置后重启应用，再点击检查；已有项目与原片可以继续使用。
        </p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        本应用尚未内置这些组件。此处只确认组件能够启动并读取版本，不代表已验证
        libx264、AAC 编码器或所有视频格式的兼容性。
      </p>
      <details className="rounded-lg border p-3 text-xs leading-relaxed">
        <summary className="cursor-pointer font-medium">高级配置与排查</summary>
        <div className="mt-3 space-y-2 text-muted-foreground">
          <p>
            环境变量 FFMPEG_PATH、FFPROBE_PATH
            可分别指定可执行文件的完整路径，路径不带引号或命令参数。明确指定的路径优先；路径错误时不会自动改用其他组件。
          </p>
          <p>
            未指定时使用应用启动时的系统 PATH。macOS 还会检查 /opt/homebrew/bin
            与 /usr/local/bin 下真实存在且可执行的工具。从 Finder
            启动时，应用可能无法读取终端的 PATH 配置。
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
