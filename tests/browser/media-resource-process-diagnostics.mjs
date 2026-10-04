// Parent-process failure diagnostics: no Electron or CDP request is needed.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function command(file, args) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    let forced;
    const done = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(forced);
      resolve({ file, args, stdout, stderr, ...result });
    };
    const limit = 4 * 1024 * 1024;
    child.stdout.on('data', (data) => {
      stdout = (stdout + data).slice(0, limit);
    });
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(0, limit);
    });
    child.on('error', (error) => done({ error: String(error) }));
    child.on('close', (code, signal) => done({ code, signal }));
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      forced = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        done({ error: 'Diagnostic command exceeded its 8 second deadline' });
      }, 1000);
    }, 8000);
  });
}

export async function captureMediaProcessDiagnostics({
  child,
  nativeLog,
  directory,
  phase,
}) {
  const report = { phase, at: new Date().toISOString(), processes: [] };
  const live = () =>
    child && child.exitCode === null && child.signalCode === null;
  try {
    if (!live()) throw new Error('The fixture Electron process has exited');
    const known = new Map([[child.pid, 'Browser']]);
    const rows = (await readFile(nativeLog, 'utf8').catch(() => ''))
      .trim()
      .split('\n');
    for (const row of rows.reverse()) {
      let parsed;
      try {
        parsed = JSON.parse(row);
      } catch {
        continue; // A concurrently appended final line may be incomplete.
      }
      if (parsed.kind !== 'process-metrics') continue;
      for (const process of parsed.value)
        if (['Tab', 'GPU'].includes(process.type))
          known.set(process.pid, process.type);
      break;
    }
    const pids = [...known.keys()].filter(
      (pid) => Number.isSafeInteger(pid) && pid > 1,
    );
    if (process.platform === 'win32') {
      report.status = await command('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$owned = foreach ($id in @(${pids.join(',')})) { $entry = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -Property ProcessId,ParentProcessId -ErrorAction SilentlyContinue; if (($id -eq ${child.pid} -and $entry.ParentProcessId -eq ${process.pid}) -or ($id -ne ${child.pid} -and $entry.ParentProcessId -eq ${child.pid})) { Get-Process -Id $id -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU,Responding,WorkingSet64,StartTime } }; @($owned) | ConvertTo-Json -Depth 3`,
      ]);
    } else {
      report.status = await command('/bin/ps', [
        '-p',
        pids.join(','),
        '-o',
        'pid=,ppid=,stat=,pcpu=,rss=,comm=',
      ]);
      const observed = new Map(
        report.status.stdout
          .trim()
          .split('\n')
          .map((line) => {
            const match = line.trim().match(/^(\d+)\s+(\d+)\s/);
            return match ? [Number(match[1]), Number(match[2])] : [];
          })
          .filter((entry) => entry.length === 2),
      );
      // Only the still-live spawned child and its recorded direct children.
      // No global process search or command-line argument collection.
      for (const pid of pids) {
        if (!live()) break;
        const owned =
          pid === child.pid
            ? observed.get(pid) === process.pid
            : observed.get(pid) === child.pid;
        if (!owned) continue;
        const type = known.get(pid);
        if (process.platform === 'darwin') {
          const identity = await command('/bin/ps', [
            '-p',
            String(pid),
            '-o',
            'pid=,ppid=',
          ]);
          const parent = pid === child.pid ? process.pid : child.pid;
          const expected = `${pid} ${parent}`;
          if (
            !live() ||
            identity.stdout.trim().replace(/\s+/g, ' ') !== expected
          ) {
            report.processes.push({
              pid,
              type,
              skipped: 'PID ownership changed',
            });
            continue;
          }
          const file = join(directory, `process-${type}-${pid}.sample.txt`);
          report.processes.push({
            pid,
            type,
            result: await command('/usr/bin/sample', [
              String(pid),
              '2',
              '1',
              '-file',
              file,
            ]),
          });
        }
      }
    }
  } catch (error) {
    report.error = String(error);
  }
  await writeFile(
    join(directory, 'process-diagnostics.json'),
    JSON.stringify(report, null, 2),
  );
}
