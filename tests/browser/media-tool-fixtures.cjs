// Native version-only executables for configuration tests, never media encoders.
const { execFileSync } = require('node:child_process');
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');

function createVersionTools(base) {
  const directory = join(base, '测试组件 有空格');
  mkdirSync(directory);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const ffmpeg = join(directory, `ffmpeg${suffix}`);
  const ffprobe = join(directory, `ffprobe${suffix}`);
  if (process.platform === 'win32') {
    const windows = process.env.SystemRoot;
    if (!windows)
      throw new Error(
        'SystemRoot is required for the native Windows fixture compiler',
      );
    const compiler = ['Framework64', 'Framework']
      .map((framework) =>
        join(windows, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'),
      )
      .find(existsSync);
    if (!compiler)
      throw new Error(
        'The native .NET Framework compiler is required; do not skip Windows configuration coverage',
      );
    const source = join(directory, 'VersionOnly.cs');
    writeFileSync(
      source,
      `using System;
using System.Diagnostics;
using System.IO;
class VersionOnly {
  static int Main(string[] args) {
    if (args.Length != 1 || args[0] != "-version") return 64;
    string name = Path.GetFileNameWithoutExtension(Process.GetCurrentProcess().MainModule.FileName);
    Console.WriteLine(name + " version fixture-1.0");
    return 0;
  }
}
`,
    );
    execFileSync(
      compiler,
      ['/nologo', '/target:exe', `/out:${ffmpeg}`, source],
      {
        shell: false,
        windowsHide: true,
        timeout: 30_000,
        stdio: 'pipe',
      },
    );
    copyFileSync(ffmpeg, ffprobe);
  } else {
    for (const [name, file] of [
      ['ffmpeg', ffmpeg],
      ['ffprobe', ffprobe],
    ])
      writeFileSync(
        file,
        `#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = '-version' ] || exit 64\nprintf '%s\\n' '${name} version fixture-1.0'\n`,
        { mode: 0o700, flag: 'wx' },
      );
  }
  for (const [name, file] of [
    ['ffmpeg', ffmpeg],
    ['ffprobe', ffprobe],
  ]) {
    const banner = execFileSync(file, ['-version'], {
      shell: false,
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8',
    }).trim();
    if (banner !== `${name} version fixture-1.0`)
      throw new Error(`Wrong fixture banner: ${banner}`);
  }
  return { ffmpeg, ffprobe };
}

module.exports = { createVersionTools };
