import {
  ARK_ENDPOINT,
  ARK_PROFILES,
  type ArkConfiguration,
  type ArkConfigurationInput,
  type ArkModelBinding,
} from '../../shared/generation/ark-types';
import type { ArkJournal } from './ark-journal';

/** Inject Electron safeStorage in the application entrypoint; unit tests never need Electron. */
export interface ArkSecretStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export class ArkConfigurationStore {
  constructor(
    private readonly journal: ArkJournal,
    private readonly secrets?: ArkSecretStorage,
  ) {}
  available(): boolean {
    try {
      return (
        !!this.secrets?.isEncryptionAvailable() &&
        this.secrets.getSelectedStorageBackend?.() !== 'basic_text'
      );
    } catch {
      return false;
    }
  }
  state(): ArkConfiguration {
    const stored = this.journal.config();
    return {
      endpoint: ARK_ENDPOINT,
      hasKey: !!stored.encryptedKey,
      secureStorageAvailable: this.available(),
      models: structuredClone(stored.models),
    };
  }
  save(
    input: ArkConfigurationInput,
    assertCurrent: () => void = () => {},
  ): ArkConfiguration {
    if (
      !input ||
      !Array.isArray(input.models) ||
      input.models.length > ARK_PROFILES.length ||
      (input.clearKey !== undefined && typeof input.clearKey !== 'boolean')
    )
      throw new Error('方舟设置无效');
    const aliases = new Set<string>();
    const models: ArkModelBinding[] = input.models.map((binding) => {
      if (
        !binding ||
        !ARK_PROFILES.includes(binding.alias) ||
        binding.capability !== binding.alias ||
        typeof binding.modelId !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$/.test(binding.modelId) ||
        ARK_PROFILES.includes(binding.modelId as typeof binding.alias) ||
        aliases.has(binding.alias)
      )
        throw new Error(
          '请填写真实 Model ID 或 Endpoint ID，并确认对应能力版本；本地模型简称不能用作 API ID',
        );
      // A named model must match the declared profile. Opaque ep-* identifiers
      // require the user to select its actual capabilities explicitly.
      const known: Record<typeof binding.capability, string[]> = {
        'seedream-5.0-lite': [
          'doubao-seedream-5-0-260128',
          'doubao-seedream-5-0-lite-260128',
        ],
        'seedream-4.5': ['doubao-seedream-4-5-251128'],
        'seedance-2.0': ['doubao-seedance-2-0-260128'],
        'seedance-2.0-fast': ['doubao-seedance-2-0-fast-260128'],
      };
      if (
        !binding.modelId.startsWith('ep-') &&
        !known[binding.capability].includes(binding.modelId)
      )
        throw new Error(
          'Model ID 与已验证的能力版本不一致；请核对文档或配置明确对应此版本的 Endpoint ID',
        );
      aliases.add(binding.alias);
      return {
        alias: binding.alias,
        capability: binding.capability,
        modelId: binding.modelId,
      };
    });
    const previous = this.journal.config();
    let encryptedKey = input.clearKey ? undefined : previous.encryptedKey;
    if (input.apiKey !== undefined) {
      if (
        input.clearKey ||
        typeof input.apiKey !== 'string' ||
        !/^[\x21-\x7e]{8,4096}$/.test(input.apiKey)
      )
        throw new Error('API Key 无效');
      if (!this.available() || !this.secrets)
        throw new Error('系统安全存储不可用，未保存 API Key；不允许明文回退');
      try {
        encryptedKey = this.secrets
          .encryptString(input.apiKey)
          .toString('base64');
      } catch {
        throw new Error('无法使用系统安全存储保存 API Key');
      }
    }
    assertCurrent();
    this.journal.putConfig({
      revision: previous.revision + 1,
      models,
      ...(encryptedKey ? { encryptedKey } : {}),
    });
    return this.state();
  }
  key(): string {
    const encrypted = this.journal.config().encryptedKey;
    if (!encrypted) throw new Error('请先在设置中保存火山方舟 API Key');
    if (!this.available() || !this.secrets)
      throw new Error('系统安全存储不可用，无法读取 API Key');
    try {
      const key = this.secrets.decryptString(Buffer.from(encrypted, 'base64'));
      if (!/^[\x21-\x7e]{8,4096}$/.test(key)) throw new Error();
      return key;
    } catch {
      throw new Error('无法解密 API Key，请在原系统账户下打开或重新设置');
    }
  }
}
