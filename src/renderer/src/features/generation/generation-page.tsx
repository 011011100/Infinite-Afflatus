import { ArrowLeft, Check, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  MAX_PROMPT_LENGTH,
  MAX_REFERENCES,
} from '../../../../shared/generation/draft';
import type { ProjectSnapshot, SaveJob } from '../../../../shared/models';
import { GenerationSettings } from './generation-parameters';
import { ReferenceShelf } from './reference-shelf';
import { message, useGenerationDraft } from './use-generation-draft';
import './generation.css';

export function GenerationPage({
  snapshot,
  jobs,
  blocked,
  onClose,
}: {
  snapshot: ProjectSnapshot;
  jobs: SaveJob[];
  blocked: boolean;
  onClose: () => void;
}) {
  const page = useRef<HTMLElement>(null);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const [importing, setImporting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const editor = useGenerationDraft(snapshot.project.id, blocked);
  const { draft } = editor;
  useEffect(() => {
    const root = document.getElementById('root');
    const focused = document.activeElement;
    if (root) root.inert = true;
    page.current?.focus();
    return () => {
      if (root) root.inert = false;
      if (focused instanceof HTMLElement && focused.isConnected)
        focused.focus();
    };
  }, []);

  const close = async () => {
    if (importing || closing) return;
    setClosing(true);
    if (await editor.flush()) onClose();
    else setClosing(false);
  };
  const importReferences = async () => {
    setImporting(true);
    try {
      const imported = await window.desktop.importReferences(
        snapshot.project.id,
      );
      editor.change((current) => {
        const ids = [
          ...new Set([...current.referenceIds, ...imported.assetIds]),
        ];
        if (ids.length > MAX_REFERENCES)
          imported.errors.push(
            `草稿最多放 ${MAX_REFERENCES} 个素材，其余素材已保留在项目中`,
          );
        return { ...current, referenceIds: ids.slice(0, MAX_REFERENCES) };
      });
      setOperationError(
        imported.errors.length ? imported.errors.join('\n') : null,
      );
    } catch (reason) {
      setOperationError(message(reason));
    } finally {
      setImporting(false);
    }
  };
  const insertText = (text: string) => {
    if (!draft) return;
    const input = prompt.current;
    const start = input?.selectionStart ?? draft.prompt.length;
    const end = input?.selectionEnd ?? start;
    const next = `${draft.prompt.slice(0, start)}${text}${draft.prompt.slice(end)}`;
    if (next.length > MAX_PROMPT_LENGTH) {
      setOperationError(
        `正文最多 ${MAX_PROMPT_LENGTH} 个字符，请选择部分文本后粘贴`,
      );
      return;
    }
    editor.change((current) => ({ ...current, prompt: next }));
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  return createPortal(
    <section
      ref={page}
      tabIndex={-1}
      aria-label="视频生成工作台"
      className="generation-page fixed inset-0 z-50 flex min-h-0 flex-col bg-canvas outline-none"
    >
      <header className="flex h-14 shrink-0 items-center gap-4 border-b bg-background px-6">
        <Button
          variant="ghost"
          onClick={() => {
            void close();
          }}
          disabled={importing || closing || (blocked && editor.dirty)}
        >
          <ArrowLeft />
          返回画布
        </Button>
        <span className="h-4 border-l" />
        <span className="max-w-64 truncate text-sm font-medium">
          {snapshot.project.name}
        </span>
        <span className="text-xs text-muted-foreground">生成视频</span>
        <span
          className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"
          role="status"
        >
          {editor.saving ? (
            <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
          ) : !editor.dirty && draft ? (
            <Check className="size-3" />
          ) : null}
          {blocked
            ? '迁移中，草稿待保存'
            : editor.error || operationError
              ? '请查看提示'
              : editor.saving
                ? '保存中…'
                : editor.dirty
                  ? '待保存'
                  : draft
                    ? '草稿已保存'
                    : '读取草稿…'}
        </span>
      </header>
      {(editor.error || operationError) && (
        <div
          role="alert"
          className="flex items-center gap-3 bg-warning px-6 py-2 text-xs text-warning-foreground"
        >
          <p className="flex-1 whitespace-pre-wrap">
            {editor.error || operationError}
          </p>
          {editor.dirty && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                void editor.flush();
              }}
            >
              重试保存
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              editor.setError(null);
              setOperationError(null);
            }}
          >
            关闭提示
          </Button>
        </div>
      )}
      {draft ? (
        <div className="generation-layout grid min-h-0 flex-1 gap-6 p-6">
          <ReferenceShelf
            projectId={snapshot.project.id}
            assets={snapshot.assets}
            jobs={jobs}
            ids={draft.referenceIds}
            importing={importing}
            onImport={() => {
              void importReferences();
            }}
            onChange={(referenceIds) =>
              editor.change((current) => ({ ...current, referenceIds }))
            }
            onInsert={insertText}
          />
          <main className="flex min-h-0 min-w-0 flex-col rounded-2xl border bg-card shadow-sm">
            <div className="flex items-center justify-between px-7 pb-3 pt-6">
              <label
                htmlFor="generation-prompt"
                className="text-sm font-medium"
              >
                画面描述
              </label>
              <span className="text-[11px] text-muted-foreground">提示词</span>
            </div>
            <Textarea
              ref={prompt}
              id="generation-prompt"
              value={draft.prompt}
              maxLength={MAX_PROMPT_LENGTH}
              placeholder={
                '描述你想生成的画面…\n\n主体、动作、场景，以及镜头如何移动。'
              }
              onChange={(event) =>
                editor.change((current) => ({
                  ...current,
                  prompt: event.target.value,
                }))
              }
              className="min-h-0 flex-1 rounded-none border-0 bg-transparent px-7 py-4 text-[15px] leading-8 focus:ring-0"
            />
            <div className="flex items-center justify-end px-7 py-5 text-[11px] tabular-nums text-muted-foreground/70">
              {draft.prompt.length.toLocaleString()} /{' '}
              {MAX_PROMPT_LENGTH.toLocaleString()}
            </div>
          </main>
          <GenerationSettings
            value={draft.parameters}
            onChange={(parameters) =>
              editor.change((current) => ({ ...current, parameters }))
            }
          />
        </div>
      ) : (
        <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
          {editor.error ? '草稿读取失败，请返回后重试' : '正在读取草稿…'}
        </div>
      )}
    </section>,
    document.body,
  );
}
