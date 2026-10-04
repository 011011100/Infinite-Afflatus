import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MediaToolSettings } from '../src/main/media/media-tool-settings';
import { resolveMediaToolPair } from '../src/main/media/media-tools';
import { AppStore } from '../src/main/storage/app-store';
import type {
  MediaToolLocation,
  MediaToolResult,
} from '../src/shared/media-tools';

const key = 'mediaToolSettings';
const automatic = { env: {}, platform: 'linux' as const };
const trusted = () => {};
const available = async (
  location: MediaToolLocation,
): Promise<MediaToolResult> => ({
  ...location,
  status: 'available',
  version: 'fixture-v1',
  detail: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-media-settings-')),
  );
  const database = join(base, 'app.sqlite');
  const store = new AppStore(database, base);
  const candidate = join(base, 'fixture-tool');
  await writeFile(candidate, 'fixture executable bytes', { mode: 0o700 });
  return {
    base,
    database,
    store,
    candidate,
    clean: async () => {
      store.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('missing settings stay automatic; saved paths and environment precedence produce immutable task snapshots', async () => {
  const f = await fixture();
  const service = new MediaToolSettings(f.store, {
    ...automatic,
    inspect: available,
  });
  try {
    const before = service.snapshot();
    assert.deepEqual(service.state().paths, { ffmpeg: null, ffprobe: null });
    assert.equal(f.store.hasSetting(key), false);
    assert.equal(before.ffmpeg.source, 'path');
    const change = await service.choose(
      'ffmpeg',
      async () => f.candidate,
      trusted,
    );
    assert.equal(change?.settings.locations.ffmpeg.command, f.candidate);
    assert.equal(change?.settings.locations.ffmpeg.source, 'saved');
    assert.equal(change?.report.tools.length, 1);
    assert.equal(before.ffmpeg.command, 'ffmpeg');
    assert.ok(Object.isFrozen(before) && Object.isFrozen(before.ffmpeg));
    const pair = resolveMediaToolPair(service.state().paths ?? undefined, {
      ...automatic,
      env: { FFMPEG_PATH: 'explicit-env' },
    });
    assert.equal(pair.ffmpeg.command, 'explicit-env');
    assert.equal(pair.ffmpeg.source, 'environment');
    assert.notEqual(pair, before);
    const reopened = new AppStore(f.database, 'unused');
    try {
      assert.equal(
        new MediaToolSettings(reopened, automatic).snapshot().ffmpeg.command,
        f.candidate,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await service.close();
    await f.clean();
  }
});

test('invalid/unknown/raw settings survive reads and only explicit clear-all repairs them, retaining environment overrides', async () => {
  const f = await fixture();
  const service = new MediaToolSettings(f.store, {
    ...automatic,
    env: { FFMPEG_PATH: 'env-wins' },
    inspect: available,
  });
  try {
    for (const bad of [
      null,
      { version: 2, ffmpeg: null, ffprobe: null },
      { version: 1, ffmpeg: 'relative', ffprobe: null },
      { version: 1, ffmpeg: null, ffprobe: null, unknown: true },
    ]) {
      f.store.set(key, bad);
      assert.equal(service.state().paths, null);
      assert.match(service.state().error ?? '', /损坏或版本不受支持/);
      assert.equal(service.state().locations.ffmpeg.source, 'environment');
      assert.throws(() => service.snapshot(), /损坏或版本不受支持/);
      assert.throws(() => service.check(), /损坏或版本不受支持/);
      await assert.rejects(
        service.choose('ffprobe', async () => f.candidate, trusted),
        /损坏/,
      );
      await assert.rejects(service.reset('ffprobe', trusted), /损坏/);
      assert.deepEqual(f.store.get(key), bad);
    }
    const raw = new DatabaseSync(f.database);
    raw
      .prepare('UPDATE settings SET value=? WHERE key=?')
      .run('malformed-json', key);
    assert.equal(service.state().paths, null);
    assert.equal(
      raw.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value,
      'malformed-json',
    );
    raw.close();
    const repaired = await service.reset('all', trusted);
    assert.equal(repaired.settings.error, null);
    assert.deepEqual(repaired.settings.paths, { ffmpeg: null, ffprobe: null });
    assert.equal(repaired.settings.locations.ffmpeg.command, 'env-wins');
    await assert.rejects(service.reset('all', trusted), /仅用于修复/);
  } finally {
    await service.close();
    await f.clean();
  }
});

test('environment-managed fields cannot choose or reset and never launch a picker; unrelated fields remain configurable', async () => {
  const f = await fixture();
  const service = new MediaToolSettings(f.store, {
    ...automatic,
    env: { FFMPEG_PATH: 'explicit-env' },
    inspect: available,
  });
  try {
    let picks = 0;
    await assert.rejects(
      service.choose(
        'ffmpeg',
        async () => {
          picks++;
          return f.candidate;
        },
        trusted,
      ),
      /FFMPEG_PATH/,
    );
    await assert.rejects(service.reset('ffmpeg', trusted), /FFMPEG_PATH/);
    assert.equal(picks, 0);
    await service.choose('ffprobe', async () => f.candidate, trusted);
    assert.equal(service.snapshot().ffmpeg.command, 'explicit-env');
    assert.equal(service.snapshot().ffprobe.command, f.candidate);
  } finally {
    await service.close();
    await f.clean();
  }
});

test('cancelled selection, wrong tool banner, file replacement and store write failures retain previous paths and source bytes', async () => {
  const f = await fixture();
  const previous = { version: 1, ffmpeg: f.candidate, ffprobe: null };
  f.store.set(key, previous);
  const bytes = await readFile(f.candidate);
  const services: MediaToolSettings[] = [];
  const make = (
    inspect = available,
    store: Pick<AppStore, 'get' | 'hasSetting' | 'set'> = f.store,
  ) => {
    const service = new MediaToolSettings(store, { ...automatic, inspect });
    services.push(service);
    return service;
  };
  try {
    const normal = make();
    assert.equal(
      await normal.choose('ffprobe', async () => null, trusted),
      null,
    );
    const wrong = make(async (location) => ({
      ...location,
      status: 'invalid',
      version: null,
      detail: '错误组件名称',
    }));
    await assert.rejects(
      wrong.choose('ffprobe', async () => f.candidate, trusted),
      /错误组件名称/,
    );
    await assert.rejects(
      normal.choose('ffprobe', async () => f.base, trusted),
      /普通.*可执行/,
    );
    await assert.rejects(
      normal.choose('ffprobe', async () => 'relative', trusted),
      /完整路径/,
    );
    await assert.rejects(
      normal.choose('ffprobe', async () => join(f.base, 'missing'), trusted),
      /未找到 FFprobe.*设置 → 视频处理/,
    );
    if (process.platform !== 'win32') {
      await chmod(f.candidate, 0o600);
      await assert.rejects(
        normal.choose('ffprobe', async () => f.candidate, trusted),
        /FFprobe 无法执行/,
      );
      await chmod(f.candidate, 0o700);
    }
    const failingStore = {
      get: f.store.get.bind(f.store),
      hasSetting: f.store.hasSetting.bind(f.store),
      set: () => {
        throw new Error('synthetic database write failure');
      },
    };
    await assert.rejects(
      make(available, failingStore).choose(
        'ffprobe',
        async () => f.candidate,
        trusted,
      ),
      /database write failure/,
    );
    assert.deepEqual(f.store.get(key), previous);
    assert.deepEqual(await readFile(f.candidate), bytes);
    const replacement = make(async (location) => {
      await writeFile(f.candidate, 'replaced while validation was pending');
      return available(location);
    });
    await assert.rejects(
      replacement.choose('ffprobe', async () => f.candidate, trusted),
      /检查期间发生变化/,
    );
    assert.deepEqual(f.store.get(key), previous);
  } finally {
    await Promise.all(services.map((service) => service.close()));
    await f.clean();
  }
});

test('mutations serialize; single reset clears only its path and reports unsuccessful automatic discovery', async () => {
  const f = await fixture();
  const choice = deferred<string | null>();
  const secondStarted = deferred<void>();
  let second = false;
  const service = new MediaToolSettings(f.store, {
    ...automatic,
    inspect: async (location) => {
      if (location.source === 'path')
        return {
          ...location,
          status: 'missing',
          version: null,
          detail: 'not installed',
        };
      return available(location);
    },
  });
  try {
    const first = service.choose('ffmpeg', () => choice.promise, trusted);
    const next = service.choose(
      'ffprobe',
      async () => {
        second = true;
        secondStarted.resolve();
        return f.candidate;
      },
      trusted,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(second, false);
    choice.resolve(f.candidate);
    await Promise.all([first, next, secondStarted.promise]);
    const reset = await service.reset('ffmpeg', trusted);
    assert.deepEqual(reset.settings.paths, {
      ffmpeg: null,
      ffprobe: f.candidate,
    });
    assert.equal(reset.report.tools[0]?.status, 'missing');
    assert.equal(reset.report.tools.length, 1);
  } finally {
    await service.close();
    await f.clean();
  }
});

test('window is revalidated after chooser, after version check and immediately before persistence', async () => {
  const f = await fixture();
  const choice = deferred<string | null>();
  const inspecting = deferred<void>();
  const checked = deferred<void>();
  const service = new MediaToolSettings(f.store, {
    ...automatic,
    inspect: async (location) => {
      inspecting.resolve();
      await checked.promise;
      return available(location);
    },
  });
  let current = true;
  const guard = () => {
    if (!current) throw new Error('Untrusted desktop request');
  };
  try {
    const chosen = service.choose('ffmpeg', () => choice.promise, guard);
    await new Promise((resolve) => setImmediate(resolve));
    current = false;
    choice.resolve(f.candidate);
    await assert.rejects(chosen, /Untrusted/);
    current = true;
    const pending = service.choose('ffmpeg', async () => f.candidate, guard);
    await inspecting.promise;
    current = false;
    checked.resolve();
    await assert.rejects(pending, /Untrusted/);
    let calls = 0;
    await assert.rejects(
      service.choose(
        'ffmpeg',
        async () => f.candidate,
        () => {
          calls++;
          if (calls === 4) throw new Error('last-moment window changed');
        },
      ),
      /last-moment/,
    );
    assert.equal(calls, 4);
    assert.equal(f.store.hasSetting(key), false);
  } finally {
    await service.close();
    await f.clean();
  }
});

test('close cancels a waiting picker and queued mutation; late choice cannot validate or persist', async () => {
  const f = await fixture();
  const choice = deferred<string | null>();
  const opened = deferred<void>();
  let checked = 0;
  let queuedPicker = false;
  const service = new MediaToolSettings(f.store, {
    ...automatic,
    inspect: async (location) => {
      checked++;
      return available(location);
    },
  });
  try {
    const pending = service.choose(
      'ffmpeg',
      () => {
        opened.resolve();
        return choice.promise;
      },
      trusted,
    );
    const queued = service.choose(
      'ffprobe',
      async () => {
        queuedPicker = true;
        return f.candidate;
      },
      trusted,
    );
    const rejected = Promise.all([
      assert.rejects(pending, /已关闭/),
      assert.rejects(queued, /已关闭/),
    ]);
    await opened.promise;
    await service.close();
    await rejected;
    choice.resolve(f.candidate);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queuedPicker, false);
    assert.equal(checked, 0);
    assert.equal(f.store.hasSetting(key), false);
  } finally {
    await service.close();
    await f.clean();
  }
});

test('close aborts active verification and waits for it to close before releasing the store', async () => {
  const f = await fixture();
  const started = deferred<void>();
  const stopped = deferred<void>();
  const release = deferred<void>();
  let closed = false;
  const service = new MediaToolSettings(f.store, {
    ...automatic,
    inspect: async (_location, options) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener(
          'abort',
          () => {
            stopped.resolve();
            resolve();
          },
          { once: true },
        ),
      );
      await release.promise;
      throw options?.signal?.reason;
    },
  });
  try {
    const pending = service.choose('ffmpeg', async () => f.candidate, trusted);
    const rejected = assert.rejects(pending, /已关闭/);
    await started.promise;
    const closing = service.close().then(() => {
      closed = true;
    });
    await stopped.promise;
    assert.equal(closed, false);
    release.resolve();
    await Promise.all([closing, rejected]);
    assert.equal(f.store.hasSetting(key), false);
  } finally {
    release.resolve();
    await service.close();
    await f.clean();
  }
});
