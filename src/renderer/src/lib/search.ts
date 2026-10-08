const normalize = (value: string) =>
  value.normalize('NFKC').toLocaleLowerCase();

export function searchWords(query: string): string[] {
  return normalize(query).trim().split(/\s+/).filter(Boolean);
}

/** Every word must match; separate words may occur in different visible fields. */
export function matchesSearch(
  values: readonly string[],
  words: readonly string[],
): boolean {
  const fields = values.map(normalize);
  return words.every((word) => fields.some((field) => field.includes(word)));
}
