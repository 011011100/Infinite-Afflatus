import { Button } from '@/components/ui/button';
import type { RescueImportPreview } from '../../../../shared/rescue-import';
import { useDraftImport } from './draft-import-state';

function Scope({ preview }: { preview: RescueImportPreview }) {
  if (preview.kind === 'workspace')
    return (
      <p>
        整个镜头工作区 · {preview.shotCount} 个镜头 · {preview.referenceCount}{' '}
        个素材引用。恢复作用于完整工作区，不是只添加到当前镜头。
      </p>
    );
  if (preview.kind === 'name')
    return (
      <div className="space-y-1 break-words">
        <p>原名称：{preview.nameBaseline}</p>
        <p className="whitespace-pre-wrap">
          名称输入：
          {preview.nameTarget?.trim() ? preview.nameTarget : '（空名称输入）'}
        </p>
        <p>恢复只填回改名弹窗，点击保存后才修改项目名称。</p>
      </div>
    );
  return (
    <p>
      一张视频卡片的裁剪 · {preview.referenceCount}{' '}
      个素材。恢复前会再次核对完整卡片与素材，源视频保持不变。
    </p>
  );
}

export function DraftImportPanel({
  active = true,
  disabled = false,
  currentProjectId = null,
}: {
  active?: boolean;
  disabled?: boolean;
  currentProjectId?: string | null;
}) {
  const state = useDraftImport(active, disabled);
  const { preview, completed, busy } = state;
  return (
    <section
      aria-label="导入恢复文件"
      aria-busy={!!busy}
      className="mt-6 space-y-3 border-t pt-5"
    >
      <h3 className="text-sm font-medium">恢复文件</h3>
      <p className="text-xs leading-5 text-muted-foreground">
        选择此前导出的镜头、名称或裁剪恢复文件，检查后添加独立恢复副本。确认导入后，再选择恢复内容。
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        需要对应的原项目及其素材。恢复文件不含原媒体；完整项目备份请使用
        .afflatus 项目包。
      </p>
      <Button
        variant="outline"
        disabled={!active || disabled || !!busy}
        onClick={() => void state.choose()}
      >
        {busy === 'checking' ? '正在检查恢复文件…' : '导入恢复文件'}
      </Button>
      {state.error && (
        <p
          role="alert"
          className="break-words text-xs leading-5 text-destructive"
        >
          {state.error}
        </p>
      )}
      {preview && (
        <section
          aria-label="恢复文件预览"
          className="space-y-3 rounded-lg border bg-canvas p-4 text-xs leading-5"
        >
          <p className="break-all font-medium">{preview.sourceName}</p>
          <p>
            {preview.sourceBytes.toLocaleString('zh-CN')} 字节 · 草稿保存时间：
            {new Date(preview.updatedAt).toLocaleString('zh-CN')}
          </p>
          <p className="break-words">原项目：{preview.project.name}</p>
          <Scope preview={preview} />
          {preview.state === 'conflict' ? (
            <p className="text-warning-foreground">
              当前项目内容与草稿对应版本不同。可以导入保留副本，暂不能恢复；不会覆盖当前内容。
            </p>
          ) : preview.state === 'submitted' ? (
            <p>此内容已在项目中。导入后可在恢复提示中核对并确认已保存。</p>
          ) : (
            <p>已找到对应项目。导入后仍需明确恢复，届时会再次核对当前内容。</p>
          )}
          <details className="break-all text-muted-foreground">
            <summary className="cursor-pointer">项目标识</summary>
            <p>{preview.project.id}</p>
            <p>项目文件夹：{preview.project.folder}</p>
            {preview.cardId && <p>视频卡片标识：{preview.cardId}</p>}
          </details>
          {!state.valid && busy !== 'importing' && (
            <p role="status">此预览已失效，请重新选择文件检查。</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!active || disabled || !!busy || !state.valid}
              onClick={() => void state.confirm()}
            >
              {busy === 'importing' ? '正在导入恢复副本…' : '导入为恢复副本'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!!busy}
              onClick={() => void state.dismiss()}
            >
              取消预览
            </Button>
          </div>
        </section>
      )}
      {completed && (
        <p role="status" className="break-words text-xs leading-5">
          {completed.result.duplicate
            ? '此恢复副本已存在，未重复导入。'
            : '恢复副本已导入，原项目未改动。'}{' '}
          {completed.result.projectId === currentProjectId
            ? '关闭设置后，可在当前项目的恢复提示中处理。'
            : `稍后打开「${completed.preview.project.name}」查看恢复提示。`}
        </p>
      )}
    </section>
  );
}
