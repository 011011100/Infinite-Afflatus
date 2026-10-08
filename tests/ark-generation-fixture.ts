import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ArkSecretStorage } from '../src/main/generation/ark-configuration';
import { ArkGenerationService } from '../src/main/generation/ark-generation-service';
import type { ArkTransport } from '../src/main/generation/ark-transport';
import { Library } from '../src/main/storage/library';
import { emptyGenerationDraft } from '../src/shared/generation/draft';
import { defaultImageParameters } from '../src/shared/generation/image-generation';
import { groupMaterials, newShot } from '../src/shared/generation/workspace';

/** A synthetic PNG header for parser tests; production download also checks dimensions. */
export function png(width = 512, height = 512) {
  const bytes = Buffer.alloc(64);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
export const fakeSecrets: ArkSecretStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'fixture-keyring',
  encryptString: (value) =>
    Buffer.from(`encrypted:${value.split('').reverse().join('')}`),
  decryptString: (value) =>
    value.toString().slice('encrypted:'.length).split('').reverse().join(''),
};
export const resultUrl =
  'https://ark-content-generation-cn-beijing.tos-cn-beijing.volces.com/fixture.mp4';
export function mockTransport(
  overrides: Partial<ArkTransport> = {},
): ArkTransport {
  return {
    createImage: async () => ({ url: resultUrl }),
    createVideo: async () => ({ id: 'cgt-fixture-task' }),
    getVideo: async () => ({ status: 'succeeded', url: resultUrl }),
    download: async (_url, kind) => ({
      stream: Readable.from(
        kind === 'image' ? png() : Buffer.from('0000ftypfixture'),
      ),
      extension: kind === 'image' ? 'png' : 'mp4',
    }),
    ...overrides,
  };
}
export async function arkFixture(
  kind: 'image' | 'video' = 'image',
  transport = mockTransport(),
) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'afflatus-ark-')));
  const data = join(base, 'app');
  const root = join(base, 'projects');
  const library = await Library.open(data, root);
  // The composition root opens its own dormant service. Use a separate journal
  // for this test service so mocks cannot reach its production transport.
  const cloudData = join(base, 'cloud');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(cloudData);
  const makeService = () =>
    new ArkGenerationService({
      userData: cloudData,
      projects: library.projects,
      store: library.store,
      gate: library.gate,
      staging: library.staging,
      saves: library.saves,
      references: library.referenceReads,
      readWorkspace: (id) => library.generation.readWorkspace(id),
      notify: () => {},
      secrets: fakeSecrets,
      transport,
      pollIntervalMs: -1,
    });
  let service = makeService();
  service.configure({
    apiKey: 'fixture-never-a-real-key',
    models: [
      {
        alias: 'seedream-5.0-lite',
        capability: 'seedream-5.0-lite',
        modelId: 'doubao-seedream-5-0-260128',
      },
      {
        alias: 'seedance-2.0',
        capability: 'seedance-2.0',
        modelId: 'doubao-seedance-2-0-260128',
      },
    ],
  });
  const { project } = await library.projects.create('云端生成测试');
  let shot = newShot('shot-fixture', '镜头', { x: 100, y: 100 });
  shot.nodes.push({
    id: 'prompt-fixture',
    type: 'text',
    text: '测试提示词',
    position: { x: 10, y: 10 },
  });
  shot = groupMaterials(shot, ['prompt-fixture'], 'group-fixture');
  const group = shot.groups[0];
  if (!group) throw new Error('Missing fixture group');
  shot.groups[0] =
    kind === 'image'
      ? {
          ...group,
          kind: 'image',
          parameters: defaultImageParameters(),
        }
      : {
          ...group,
          kind: 'video',
          parameters: emptyGenerationDraft().parameters,
        };
  await library.generation.saveWorkspace(project.id, {
    version: 1,
    revision: 0,
    shots: [shot],
  });
  return {
    base,
    cloudData,
    library,
    project,
    target: {
      projectId: project.id,
      shotId: shot.id,
      groupId: 'group-fixture',
    },
    get service() {
      return service;
    },
    async restart() {
      await service.close();
      service = makeService();
      await service.recover();
    },
    async settle() {
      await service.idle();
      await library.saves.idle();
      return service.list(project.id);
    },
    async dispose() {
      await service.close();
      await library.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}
