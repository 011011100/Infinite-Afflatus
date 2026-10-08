import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MediaToolName,
  MediaToolSettingsChange,
  MediaToolSettingsState,
  MediaToolsReport,
} from '../../../../shared/media-tools';
import { message } from '../generation/errors';

type Operation = 'loading' | 'checking' | 'choosing' | 'resetting';

/** A version result describes one exact command and source, never its successor. */
function matchingReport(
  settings: MediaToolSettingsState,
  previous: MediaToolsReport | null,
  incoming?: MediaToolsReport,
): MediaToolsReport | null {
  if (!settings.paths || settings.error) return null;
  const tools = (['ffmpeg', 'ffprobe'] as const).flatMap((name) => {
    const location = settings.locations[name];
    const matches = (report: MediaToolsReport | undefined | null) =>
      report?.tools.find(
        (tool) =>
          tool.name === location.name &&
          tool.source === location.source &&
          tool.command === location.command &&
          tool.unavailableReason === location.unavailableReason,
      );
    const result = matches(incoming) ?? matches(previous);
    return result ? [result] : [];
  });
  if (!tools.length) return null;
  return {
    checkedAt: incoming?.checkedAt ?? previous?.checkedAt ?? '',
    tools,
  };
}

export function useMediaToolSettings() {
  const [settings, setSettings] = useState<MediaToolSettingsState | null>(null);
  const [report, setReport] = useState<MediaToolsReport | null>(null);
  const [busy, setBusy] = useState<Operation | null>('loading');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const current = useRef<MediaToolSettingsState | null>(null);
  const pending = useRef(false);
  const epoch = useRef(0);

  const perform = useCallback(
    async (operation: Operation, action: () => Promise<() => void>) => {
      if (pending.current) return;
      pending.current = true;
      const request = ++epoch.current;
      setBusy(operation);
      try {
        const apply = await action();
        if (request !== epoch.current) return;
        apply();
      } catch (reason) {
        if (request === epoch.current) {
          setError(message(reason));
          setNotice(null);
        }
      } finally {
        if (request === epoch.current) {
          pending.current = false;
          setBusy(null);
        }
      }
    },
    [],
  );
  const accept = useCallback(
    (next: MediaToolSettingsState, report?: MediaToolsReport) => {
      current.current = next;
      setSettings(next);
      setReport((previous) => matchingReport(next, previous, report));
      setError(null);
    },
    [],
  );
  const load = useCallback(
    () =>
      perform('loading', async () => {
        const next = await window.desktop.getMediaToolSettings();
        return () => accept(next);
      }),
    [perform, accept],
  );

  useEffect(() => {
    // StrictMode's first mount is disposed before doing even read-only IPC.
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      epoch.current++;
      pending.current = false;
    };
  }, [load]);

  const check = () => {
    if (!current.current?.paths || current.current.error) return;
    return perform('checking', async () => {
      const captured = current.current;
      const result = await window.desktop.checkMediaTools();
      // Bundled bytes can change outside this panel. Refresh paths only when a
      // check observes a different bundle state, without another version run.
      const changedBundle = result.tools.some((tool) => {
        const previous = captured?.locations[tool.name];
        return (
          tool.source === 'bundled' &&
          previous?.source === 'bundled' &&
          (tool.command !== previous.command ||
            tool.unavailableReason !== previous.unavailableReason)
        );
      });
      const refreshed = changedBundle
        ? await window.desktop.getMediaToolSettings()
        : null;
      return () => {
        if (refreshed) {
          accept(refreshed, result);
          setNotice(null);
          return;
        }
        const latest = current.current;
        if (!latest) return;
        setReport((previous) => matchingReport(latest, previous, result));
        setError(null);
        setNotice(null);
      };
    });
  };
  const change = (
    operation: 'choosing' | 'resetting',
    action: () => Promise<MediaToolSettingsChange | null>,
  ) =>
    perform(operation, async () => {
      const result = await action();
      return () => {
        if (!result) return; // Native selection cancellation changes nothing.
        accept(result.settings, result.report);
        setNotice(
          operation === 'choosing'
            ? '已保存，对新任务生效。'
            : '已恢复自动查找，对新任务生效。',
        );
      };
    });
  const choose = (name: MediaToolName) => {
    const settings = current.current;
    if (
      !settings?.paths ||
      settings.error ||
      settings.locations[name].source === 'environment'
    )
      return;
    return change('choosing', () => window.desktop.chooseMediaTool(name));
  };
  const reset = (name: MediaToolName | 'all') => {
    const settings = current.current;
    if (!settings) return;
    if (
      name !== 'all' &&
      (!settings.paths ||
        settings.error ||
        !settings.paths[name] ||
        settings.locations[name].source === 'environment')
    )
      return;
    return change('resetting', () => window.desktop.resetMediaTool(name));
  };
  return { settings, report, busy, error, notice, load, check, choose, reset };
}
