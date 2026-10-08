import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  ARK_PROFILES,
  type ArkCapabilityProfile,
  type ArkConfiguration,
  type ArkModelBinding,
} from '../../../../shared/generation/ark-types';
import { message } from '../generation/errors';

const labels: Record<ArkCapabilityProfile, string> = {
  'seedance-2.0': 'Seedance 2.0',
  'seedance-2.0-fast': 'Seedance 2.0 Fast',
  'seedream-5.0-lite': 'Seedream 5.0 Lite',
  'seedream-4.5': 'Seedream 4.5',
};
const blankModels = (): ArkModelBinding[] =>
  ARK_PROFILES.map((alias) => ({ alias, modelId: '', capability: alias }));

/** This page only reads local configuration; it never probes the provider. */
export function ArkSettings({ active = true }: { active?: boolean }) {
  const [config, setConfig] = useState<ArkConfiguration | null>(null);
  const [models, setModels] = useState(blankModels);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);
  const epoch = useRef(0);
  const loaded = useRef(false);
  const load = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    const ticket = ++epoch.current;
    setBusy(true);
    try {
      const next = await window.desktop.getArkConfig();
      if (ticket !== epoch.current) return;
      setConfig(next);
      setNotice(null);
      if (next.error) setApiKey('');
      setModels(
        blankModels().map(
          (row) =>
            next.models.find((model) => model.alias === row.alias) ?? row,
        ),
      );
      loaded.current = true;
      setError(null);
    } catch (reason) {
      if (ticket === epoch.current) setError(message(reason));
    } finally {
      if (ticket === epoch.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }, []);
  useEffect(() => {
    if (!active || loaded.current) return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [active, load]);
  useEffect(
    () => () => {
      epoch.current++;
      pending.current = false;
    },
    [],
  );
  const save = async () => {
    if (pending.current || !config || config.error) return;
    pending.current = true;
    const ticket = ++epoch.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    const input = {
      models: models
        .filter((row) => row.modelId.trim())
        .map((row) => ({ ...row, modelId: row.modelId.trim() })),
      ...(apiKey.trim() && !clearKey ? { apiKey: apiKey.trim() } : {}),
      ...(clearKey ? { clearKey: true } : {}),
    };
    // Never retain or echo a submitted credential, including on a failed save.
    setApiKey('');
    try {
      const next = await window.desktop.saveArkConfig(input);
      if (ticket !== epoch.current) return;
      setConfig(next);
      setClearKey(false);
      setNotice(
        next.error
          ? null
          : '已保存到本机。新生成使用此配置；没有发送测试请求。',
      );
    } catch (reason) {
      if (ticket === epoch.current) {
        const detail = message(reason);
        setError(
          input.apiKey ? detail.split(input.apiKey).join('[已隐藏]') : detail,
        );
      }
    } finally {
      if (ticket === epoch.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section
      className="space-y-5"
      aria-label="火山方舟中国区设置"
      aria-busy={busy}
    >
      <div>
        <h3 className="text-sm font-medium">火山方舟中国区</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          生成前会逐次展示模型、提示词和参考文件，请确认后再发送。服务可能按使用量计费。
        </p>
        <p className="mt-2 break-all text-xs text-muted-foreground">
          服务地址：https://ark.cn-beijing.volces.com/api/v3
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!config ? (
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          {busy ? '正在读取本机配置…' : '重新读取配置'}
        </Button>
      ) : (
        <>
          {config.error && (
            <div className="space-y-3 rounded-lg border border-destructive/40 p-3">
              <p role="alert" className="break-words text-sm text-destructive">
                {config.error}
              </p>
              <p className="text-xs text-muted-foreground">
                云端生成已停用，原记录已保留。此处不能修改或覆盖配置；请处理上述原因后重新读取本机记录。
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void load()}
              >
                {busy ? '正在读取本机配置…' : '重新读取本机记录'}
              </Button>
            </div>
          )}
          <fieldset disabled={busy || !!config.error} className="space-y-3">
            <label htmlFor="ark-api-key" className="block text-sm font-medium">
              API Key{' '}
              <span className="text-xs font-normal text-muted-foreground">
                {config.error
                  ? '状态未确认'
                  : config.hasKey
                    ? '已配置（不回显）'
                    : '尚未配置'}
              </span>
            </label>
            <Input
              id="ark-api-key"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={apiKey}
              disabled={
                !!config.error || !config.secureStorageAvailable || clearKey
              }
              placeholder={
                config.hasKey ? '留空保留现有密钥' : '输入火山方舟 API Key'
              }
              onChange={(event) => setApiKey(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              密钥仅写入本机系统加密存储，不写入项目、任务记录或请求预览。保存失败后如需更换密钥，请重新输入。
            </p>
            {!config.error && !config.secureStorageAvailable && (
              <p role="alert" className="text-sm text-destructive">
                本机安全存储不可用，不能保存密钥。请恢复系统安全存储后再试。
              </p>
            )}
            {config.hasKey && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={clearKey}
                  onChange={(event) => {
                    setClearKey(event.target.checked);
                    setApiKey('');
                  }}
                />
                保存时移除本机密钥
              </label>
            )}
          </fieldset>
          <fieldset disabled={busy || !!config.error} className="space-y-4">
            <legend className="mb-2 text-sm font-medium">
              模型与 Endpoint ID
            </legend>
            <p className="text-xs leading-relaxed text-muted-foreground">
              从方舟控制台填写已开通的准确 Model ID 或 Endpoint
              ID，并确认它对应的实际能力。编辑器中的模型名称不会自动当作服务
              ID；未配置的模型不能提交。
            </p>
            {models.map((row) => (
              <div key={row.alias} className="space-y-2 rounded-lg border p-3">
                <label htmlFor={`ark-model-${row.alias}`} className="text-sm">
                  {labels[row.alias]}
                </label>
                <Input
                  id={`ark-model-${row.alias}`}
                  aria-label={`${labels[row.alias]} 服务 ID`}
                  value={row.modelId}
                  placeholder="填写 Model ID 或 ep-…"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setModels((rows) =>
                      rows.map((item) =>
                        item.alias === row.alias
                          ? { ...item, modelId: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <label
                  htmlFor={`ark-capability-${row.alias}`}
                  className="block text-xs text-muted-foreground"
                >
                  实际模型能力
                </label>
                <Select
                  id={`ark-capability-${row.alias}`}
                  value={row.capability}
                  onChange={(event) =>
                    setModels((rows) =>
                      rows.map((item) =>
                        item.alias === row.alias
                          ? {
                              ...item,
                              capability: event.target
                                .value as ArkCapabilityProfile,
                            }
                          : item,
                      ),
                    )
                  }
                >
                  {ARK_PROFILES.filter((profile) =>
                    profile.startsWith(
                      row.alias.startsWith('seedream')
                        ? 'seedream'
                        : 'seedance',
                    ),
                  ).map((profile) => (
                    <option key={profile} value={profile}>
                      {labels[profile]}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </fieldset>
          <div className="flex items-center gap-3">
            <Button
              disabled={busy || !!config.error}
              onClick={() => void save()}
            >
              {busy ? '保存中…' : '保存生成配置'}
            </Button>
            <span role="status" className="text-xs text-muted-foreground">
              {notice}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
