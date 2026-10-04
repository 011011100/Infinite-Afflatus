/** A suggested cross-platform filename; the native dialog still chooses its location. */
export function outputName(name: string): string {
  const cleaned = Array.from(name, (character) =>
    character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character)
      ? '_'
      : character,
  )
    .join('')
    .replace(/[. ]+$/, '');
  return !cleaned ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)
    ? `项目-${cleaned || '未命名'}`
    : cleaned;
}
