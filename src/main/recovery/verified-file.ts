import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, open } from 'node:fs/promises';

/** Hash and copy in bounded, cancellable reads; never buffer a whole media file. */
export async function verifyFile(
  path: string,
  expectedSize: number,
  signal: AbortSignal,
  progress: (bytes: number) => void,
  output?: FileHandle,
): Promise<{ size: number; sha256: string }> {
  signal.throwIfAborted();
  const selected = await lstat(path);
  if (!selected.isFile() || selected.isSymbolicLink())
    throw new Error('请选择普通文件');
  // O_NONBLOCK avoids an external path replacement with a FIFO stalling cancellation.
  const input = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await input.stat();
    if (!before.isFile()) throw new Error('请选择普通文件');
    if (before.size !== expectedSize) throw new Error('文件大小与原素材不一致');
    const hash = createHash('sha256');
    let size = 0;
    const buffer = Buffer.allocUnsafe(256 * 1024);
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > expectedSize) throw new Error('文件大小与原素材不一致');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (output) {
        let offset = 0;
        while (offset < bytesRead) {
          signal.throwIfAborted();
          const { bytesWritten } = await output.write(chunk, offset);
          if (!bytesWritten) throw new Error('恢复文件写入中断');
          offset += bytesWritten;
        }
      }
      progress(size);
    }
    signal.throwIfAborted();
    const after = await input.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error('文件正在被其他程序修改，请稍后重试');
    if (output) await output.sync();
    return { size, sha256: hash.digest('hex') };
  } finally {
    await input.close();
  }
}
