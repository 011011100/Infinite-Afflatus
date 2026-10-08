/** Recognize only the formats we can inspect from immutable bytes. No extension trust. */
export function imageInfo(bytes: Buffer): {
  mime: string;
  extension: string;
  width: number;
  height: number;
} {
  if (
    bytes.length >= 33 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  )
    return {
      mime: 'image/png',
      extension: 'png',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (
        marker === 0x01 ||
        (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)
      )
        continue;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if (
        marker !== undefined &&
        [0xc0, 0xc1, 0xc2].includes(marker) &&
        size >= 8
      )
        return {
          mime: 'image/jpeg',
          extension: 'jpg',
          width: bytes.readUInt16BE(offset + 5),
          height: bytes.readUInt16BE(offset + 3),
        };
      offset += size;
    }
  }
  if (
    bytes.length >= 30 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const type = bytes.toString('ascii', 12, 16);
    if (type === 'VP8X')
      return {
        mime: 'image/webp',
        extension: 'webp',
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    if (
      type === 'VP8 ' &&
      bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    )
      return {
        mime: 'image/webp',
        extension: 'webp',
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    if (type === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return {
        mime: 'image/webp',
        extension: 'webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
  }
  throw new Error('图片格式或尺寸无法验证，请使用标准 PNG、JPEG 或 WebP 图片');
}

export function wavDuration(bytes: Buffer): number {
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new Error(
      '目前音频参考仅支持可验证的 PCM WAV；MP3、M4A、OGG 请先转为 WAV',
    );
  let rate = 0;
  let size = 0;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const kind = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + length > bytes.length) throw new Error('WAV 音频不完整');
    if (kind === 'fmt ') {
      if (length < 16 || ![1, 3].includes(bytes.readUInt16LE(offset + 8)))
        throw new Error('音频参考仅支持 PCM WAV');
      const channels = bytes.readUInt16LE(offset + 10);
      const samples = bytes.readUInt32LE(offset + 12);
      rate = bytes.readUInt32LE(offset + 16);
      const align = bytes.readUInt16LE(offset + 20);
      const bits = bytes.readUInt16LE(offset + 22);
      if (
        !channels ||
        !samples ||
        !rate ||
        align !== (channels * bits) / 8 ||
        rate !== samples * align
      )
        throw new Error('WAV 音频参数无效');
    }
    if (kind === 'data') size += length;
    offset += 8 + length + (length % 2);
  }
  if (!rate || !size) throw new Error('WAV 音频为空或参数无效');
  return size / rate;
}
