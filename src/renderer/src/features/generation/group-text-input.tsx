import { useEffect, useRef, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import type { MaterialNode } from '../../../../shared/generation/workspace';
import { useMediaRevision } from '../workspace/use-media-revision';
import { message } from './errors';

export function GroupTextInput({
  node,
  projectId,
  index,
  disabled,
  focus,
  onChange,
  placeholder = '描述画面、动作、镜头和对白…',
}: {
  node: MaterialNode;
  projectId: string;
  index: number;
  disabled: boolean;
  focus: boolean;
  onChange: (text: string) => void;
  placeholder?: string;
}) {
  const assetId = node.type === 'asset' ? node.assetId : null;
  const revision = useMediaRevision(projectId, assetId ?? undefined);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focus) input.current?.focus({ preventScroll: true });
  }, [focus]);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void revision;
    if (!assetId) return;
    let active = true;
    setSource(null);
    setError(null);
    void window.desktop
      .readReferenceText(projectId, assetId)
      .then((text) => {
        if (active) setSource(text);
      })
      .catch((reason) => {
        if (active) setError(message(reason));
      });
    return () => {
      active = false;
    };
  }, [projectId, assetId, revision]);
  const value =
    node.type === 'text' ? node.text : (node.textOverride ?? source);
  return (
    <>
      <Textarea
        aria-label={`文本块 ${index + 1}`}
        ref={input}
        value={value ?? ''}
        placeholder={value === null ? '读取文本…' : placeholder}
        disabled={disabled || value === null}
        maxLength={10000}
        className="group-text-input"
        onChange={(event) => onChange(event.target.value)}
      />
      {error && (
        <p role="alert" className="px-5 pb-3 text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
