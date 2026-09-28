import { spawn } from 'node:child_process';

const tools = [
  { name: 'ffmpeg', executable: process.env.FFMPEG_PATH || 'ffmpeg' },
  { name: 'ffprobe', executable: process.env.FFPROBE_PATH || 'ffprobe' },
];

// Paths are executable names, never shell fragments. Checking tools does not process media.
for (const tool of tools) {
  const ok = await new Promise((resolve) => {
    const child = spawn(tool.executable, ['-version'], {
      shell: false,
      windowsHide: true,
      timeout: 10_000,
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    child.once('error', (error) => {
      console.error(`${tool.name}: ${error.message}`);
      resolve(false);
    });
    child.once('close', (code) => {
      if (code === 0) {
        console.info(output.split('\n')[0]);
      } else {
        console.error(`${tool.name}: unavailable (exit ${code})`);
      }
      resolve(code === 0);
    });
  });
  if (!ok) process.exitCode = 1;
}
