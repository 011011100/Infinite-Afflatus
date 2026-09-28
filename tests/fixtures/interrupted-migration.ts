import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Library } from '../../src/main/storage/library';

const [base, phase] = process.argv.slice(2);
if (!base || !phase) throw new Error('Missing fixture arguments');
const library = await Library.open(join(base, 'app'), join(base, 'projects'));
const { project } = await library.projects.create('进程中断恢复');
const result = (key: string) =>
  library.acceptResult(
    {
      projectId: project.id,
      resultKey: key,
      name: `${key}.mp4`,
      kind: 'video',
      extension: 'mp4',
    },
    Readable.from(Buffer.from(`result ${key}`)),
  );
await result('saved');
await library.saves.idle();
await library.gate.block();
await result('pending');
library.gate.release();
library.subscribe(() => {
  if (library.state().migration?.phase === phase) process.exit(73);
});
const preview = await library.migration.prepare(join(base, 'moved'));
await library.migration.start(preview.token);
await library.migration.idle();
throw new Error('Interruption point was not reached');
