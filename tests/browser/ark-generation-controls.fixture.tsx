import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArkGenerationControls } from '@/features/generation/ark/ark-generation-controls';
import { useArkAdoptionInputs } from '@/features/generation/ark/use-ark-adoption-inputs';
import { useArkGeneration } from '@/features/generation/ark/use-ark-generation';
import { capturePendingSaves } from '@/features/lifecycle/pending-saves';
import { usePendingSave } from '@/features/lifecycle/use-pending-save';
import { ArkSettings } from '@/features/settings/ark-settings';
import {
  ARK_ENDPOINT,
  type ArkConfiguration,
  type ArkConfigurationInput,
  type ArkGenerationApi,
  type ArkGenerationJob,
  type ArkGenerationPreview,
  type ArkJobPhase,
} from '../../src/shared/generation/ark-types';
import '../../src/renderer/src/styles.css';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const sample: ArkGenerationPreview = {
  projectId: 'project',
  shotId: 'shot',
  groupId: 'group',
  kind: 'video',
  token: 'preview-token',
  expiresAt: '2099-01-01T00:00:00Z',
  modelId: 'ep-explicit-confirmed',
  capability: 'seedance-2.0',
  prompt: '第一段提示词\n\n第二段提示词',
  parameters: {
    model: 'seedance-2.0',
    ratio: '16:9',
    resolution: '720p',
    duration: 5,
    generateAudio: true,
  },
  references: [
    {
      nodeId: 'image-b',
      assetId: 'b',
      name: '先发送 B.png',
      kind: 'image',
      bytes: 200,
      sha256: 'b',
      role: 'reference_image',
    },
    {
      nodeId: 'image-a',
      assetId: 'a',
      name: '后发送 A.png',
      kind: 'image',
      bytes: 100,
      sha256: 'a',
      role: 'reference_image',
    },
  ],
  transmissionNotice: '这些文本和参考图片将上传到火山方舟中国区。',
  costNotice: '服务按实际使用计费，取消本机查询不代表退款。',
  warnings: [],
};
let config: ArkConfiguration = {
  endpoint: ARK_ENDPOINT,
  hasKey: true,
  secureStorageAvailable: true,
  models: [
    {
      alias: 'seedance-2.0',
      modelId: sample.modelId,
      capability: 'seedance-2.0',
    },
  ],
};
let jobs: ArkGenerationJob[] = [];
const pending = {
  config: [] as ReturnType<typeof deferred<ArkConfiguration>>[],
  save: [] as {
    input: ArkConfigurationInput;
    result: ReturnType<typeof deferred<ArkConfiguration>>;
  }[],
  preview: [] as ReturnType<typeof deferred<ArkGenerationPreview>>[],
  submit: [] as {
    token: string;
    result: ReturnType<typeof deferred<ArkGenerationJob>>;
  }[],
  adopt: [] as { id: string; result: ReturnType<typeof deferred<void>> }[],
};
const events: string[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const makeJob = (
  phase: ArkJobPhase,
  kind: 'image' | 'video' = 'video',
): ArkGenerationJob => ({
  ...sample,
  id: 'job-one',
  kind,
  phase,
  createdAt: '2026-10-08T00:00:00Z',
  updatedAt: '2026-10-08T00:00:00Z',
  locallyStopped: false,
  error: null,
  ...(phase === 'submission_unknown' ? {} : { remoteTaskId: 'remote-task' }),
  ...(['candidate', 'adopted'].includes(phase)
    ? { candidateAssetId: 'asset' }
    : {}),
});
const action = async (name: string, id: string) => {
  events.push(`${name}:${id}`);
  const job = jobs.find((item) => item.id === id);
  if (!job) throw new Error('Missing test job');
  if (name === 'stop') job.locallyStopped = true;
  if (name === 'refresh') job.locallyStopped = false;
  if (name === 'cancel') job.phase = 'cancelled';
  emit();
  return structuredClone(job);
};
const bridge: ArkGenerationApi = {
  getArkConfig: () => {
    const request = deferred<ArkConfiguration>();
    pending.config.push(request);
    return request.promise;
  },
  saveArkConfig: (input) => {
    const result = deferred<ArkConfiguration>();
    pending.save.push({ input, result });
    return result.promise;
  },
  previewArkGeneration: () => {
    const request = deferred<ArkGenerationPreview>();
    pending.preview.push(request);
    return request.promise;
  },
  submitArkGeneration: (token) => {
    const result = deferred<ArkGenerationJob>();
    pending.submit.push({ token, result });
    return result.promise;
  },
  cancelArkPreview: async (token) => {
    events.push(`cancel-preview:${token}`);
  },
  listArkJobs: async () => {
    events.push('list');
    return structuredClone(jobs);
  },
  onArkJobsChanged: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  refreshArkJob: (id) => action('refresh', id),
  retryArkDownload: (id) => action('download', id),
  retryArkSave: (id) => action('save', id),
  stopArkPolling: (id) => action('stop', id),
  cancelArkQueued: (id) => action('cancel', id),
  adoptArkJob: async () => {
    throw new Error('UI must use project-scoped adoption callback');
  },
};
let setVisible: (visible: boolean) => void = () => {};
let setVersion: (version: string) => void = () => {};
let setAdopting: (adopting: boolean) => void = () => {};
let settingsOpens = 0;
let flushGate: ReturnType<typeof deferred<boolean>> | null = null;
const leaves: boolean[] = [];
let setInactive: (value: boolean) => void = () => {};
const controls = {
  state: () => ({
    reads: pending.config.length,
    saves: pending.save.map(({ input }) => input),
    previews: pending.preview.length,
    submits: pending.submit.map(({ token }) => token),
    adopts: pending.adopt.map(({ id }) => id),
    events,
    jobs,
    settingsOpens,
    leaves,
    listeners: listeners.size,
  }),
  corruptConfig: () => {
    config.error = '云端任务记录损坏，原记录已保留；禁止覆盖。';
    config.secureStorageAvailable = false;
  },
  repairConfig: () => {
    delete config.error;
    config.secureStorageAvailable = true;
  },
  readConfig: (index = pending.config.length - 1) =>
    pending.config[index]?.resolve(structuredClone(config)),
  saveConfig: () => {
    const save = pending.save.at(-1);
    if (!save) throw new Error('Missing save');
    config = {
      ...config,
      models: save.input.models,
      hasKey: save.input.clearKey
        ? false
        : !!save.input.apiKey || config.hasKey,
    };
    save.result.resolve(structuredClone(config));
  },
  resolvePreview: (index = pending.preview.length - 1) =>
    pending.preview[index]?.resolve({
      ...structuredClone(sample),
      token: `preview-${index}`,
    }),
  rejectPreview: (text: string) =>
    pending.preview.at(-1)?.reject(new Error(text)),
  resolveSubmit: (phase: ArkJobPhase = 'queued') => {
    const job = makeJob(phase);
    jobs = [job];
    pending.submit.at(-1)?.result.resolve(job);
    emit();
  },
  rejectSubmit: () =>
    pending.submit.at(-1)?.result.reject(new Error('网络中断，未拿到提交回执')),
  job: (phase: ArkJobPhase, kind: 'image' | 'video' = 'video') => {
    jobs = [makeJob(phase, kind)];
    emit();
  },
  resolveAdopt: () => {
    if (jobs[0]) jobs[0].phase = 'adopted';
    pending.adopt.at(-1)?.result.resolve();
    setAdopting(false);
    emit();
  },
  rejectAdopt: (committed = false) => {
    if (committed && jobs[0]) {
      jobs[0].phase = 'adopted';
      emit();
    }
    setAdopting(true);
    pending.adopt.at(-1)?.result.reject(new Error('采纳回执中断，请重试确认'));
  },
  holdFlush: () => {
    flushGate = deferred<boolean>();
  },
  releaseFlush: () => {
    const pending = flushGate;
    flushGate = null;
    pending?.resolve(true);
  },
  captureLeave: () => {
    void capturePendingSaves().then((value) => leaves.push(value));
  },
  inactive: () => setInactive(true),
  close: () => setVisible(false),
  open: () => setVisible(true),
  change: () => setVersion(crypto.randomUUID()),
};
Object.assign(window, { desktop: bridge, arkControls: controls });
function GenerationFixture() {
  const [version, versionChanged] = useState('initial');
  const [adopting, adoptionChanged] = useState(false);
  const [inactive, inactiveChanged] = useState(false);
  const page = useRef<HTMLElement>(null);
  usePendingSave(
    'Fixture local input',
    () => flushGate?.promise ?? Promise.resolve(true),
    -20,
  );
  useEffect(() => {
    setVersion = versionChanged;
    setAdopting = adoptionChanged;
    setInactive = inactiveChanged;
  }, []);
  const adoption = useArkAdoptionInputs({
    page,
    shotId: version,
    disabled: inactive || adopting,
    pendingAdoptionJobId: adopting ? 'job-one' : null,
    importing: false,
    onAdopt: async (id) => {
      const result = deferred<void>();
      pending.adopt.push({ id, result });
      await result.promise;
    },
  });
  const state = useArkGeneration({
    target: { projectId: 'project', shotId: 'shot', groupId: 'group' },
    sourceVersion: version,
    disabled: adopting || inactive,
    pendingAdoptionJobId: adopting ? 'job-one' : null,
    onAdopt: adoption.adopt,
  });
  return (
    <section ref={page}>
      <ArkGenerationControls
        state={state}
        kind="video"
        disabled={adopting || inactive}
        canAdopt
        pendingAdoptionJobId={adopting ? 'job-one' : null}
        onOpenSettings={() => {
          settingsOpens++;
        }}
      />
    </section>
  );
}
function Fixture() {
  const [visible, visibleChanged] = useState(true);
  useEffect(() => {
    setVisible = visibleChanged;
  }, []);
  return (
    <main className="mx-auto max-w-xl p-6">
      {visible ? (
        new URLSearchParams(location.search).has('settings') ? (
          <ArkSettings />
        ) : (
          <GenerationFixture />
        )
      ) : (
        <p>已关闭</p>
      )}
    </main>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
