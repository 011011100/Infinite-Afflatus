import { MediaToolDiagnostics } from '../src/main/media/media-tool-diagnostics.ts';

const report = await new MediaToolDiagnostics().check();
for (const tool of report.tools) {
  if (tool.status === 'available')
    console.info(
      `${tool.name} ${tool.version} · ${tool.source} · ${tool.command}`,
    );
  else {
    console.error(`${tool.name}: ${tool.detail} (${tool.command})`);
    process.exitCode = 1;
  }
}
console.info('版本检查不代表已验证编码器或所有视频格式的兼容性。');
