// Controlled subprocess for preview-cache acceptance, never a real media encoder.
// It only recognizes the public synthetic clip and copies it into an owned work file.
const assert = require('node:assert/strict');
const {
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join } = require('node:path');

async function run(tool, base, args, environment = process.env) {
  assert.ok(['ffmpeg', 'ffprobe'].includes(tool), 'Unknown fixture tool');
  assert.equal(realpathSync.native(base), base);
  assert.ok(environment.AFFLATUS_CACHE_FIXTURE_OWNER);
  assert.equal(
    readFileSync(join(base, '.fixture-owner'), 'utf8'),
    environment.AFFLATUS_CACHE_FIXTURE_OWNER,
  );
  const profile = join(base, 'profile');
  assert.equal(environment.AFFLATUS_USER_DATA, profile);
  const work = join(profile, 'preview-work');
  assert.equal(realpathSync.native(work), work);
  const ownedFile = (file) => {
    assert.equal(dirname(file), work, 'Only disposable proxy work files');
    const info = lstatSync(file);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
    assert.equal(realpathSync.native(file), file);
  };
  const { syntheticTrimVideo } = await import('./synthetic-trim-video.mjs');
  if (tool === 'ffprobe') {
    assert.deepEqual(args.slice(0, -1), [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,duration,start_time,avg_frame_rate:format=duration',
      '-of',
      'json',
    ]);
    ownedFile(args.at(-1));
    assert.deepEqual(readFileSync(args.at(-1)), syntheticTrimVideo);
    return JSON.stringify({
      streams: [
        {
          width: 96,
          height: 54,
          duration: '8',
          start_time: '0',
          avg_frame_rate: '12/1',
        },
      ],
      format: { duration: '8' },
    });
  }
  const input = args[args.indexOf('-i') + 1];
  const output = args.at(-1);
  assert.ok(args.includes('-i') && args.includes('libx264'));
  ownedFile(input);
  ownedFile(output);
  assert.notEqual(input, output);
  assert.equal(lstatSync(output).size, 0, 'Never overwrite an existing result');
  assert.deepEqual(readFileSync(input), syntheticTrimVideo);
  writeFileSync(output, syntheticTrimVideo, { flag: 'r+' });
  return '';
}

module.exports = { run };
if (require.main === module)
  run(process.argv[2], process.argv[3], process.argv.slice(4)).then(
    (output) => process.stdout.write(output),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
