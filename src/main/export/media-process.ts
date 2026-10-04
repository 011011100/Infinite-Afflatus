import { spawn } from 'node:child_process';

/** Bounded diagnostics and process lifetime; never invokes a command shell. */
export function mediaProcess(
  executable: string,
  args: string[],
  signal: AbortSignal,
  progress?: (seconds: number) => void,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let diagnostic = '';
    let buffered = '';
    let failure: Error | undefined;
    let forced: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill('SIGTERM');
      clearTimeout(forced);
      forced = setTimeout(() => child.kill('SIGKILL'), 2000);
      forced.unref();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(
      () => {
        failure = new Error('媒体处理超时，请尝试较短的组合');
        abort();
      },
      6 * 60 * 60 * 1000,
    );
    timeout.unref();
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output = (output + chunk).slice(-128_000);
      if (!progress) return;
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = (lines.pop() ?? '').slice(-4096);
      for (const line of lines) {
        if (!line.startsWith('out_time_us=')) continue;
        const seconds = Number(line.slice('out_time_us='.length)) / 1_000_000;
        if (Number.isFinite(seconds) && seconds >= 0) progress(seconds);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(-3000);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      failure =
        error.code === 'ENOENT'
          ? new Error('未找到 FFmpeg 或 FFprobe，请在设置中查看媒体工具说明')
          : error;
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(forced);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error(`媒体处理失败 (${code}): ${diagnostic}`));
      else resolve(output);
    });
  });
}
