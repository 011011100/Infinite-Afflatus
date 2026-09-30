import { useLayoutEffect, useState } from 'react';
import { FilmstripCache } from './filmstrip-cache';
import { FilmstripDecoder } from './filmstrip-decoder';

export function useFilmstripCache() {
  const [{ cache, decoder }] = useState(() => {
    const decoder = new FilmstripDecoder();
    const cache = new FilmstripCache((request, signal) =>
      decoder.decode(request, signal),
    );
    return { cache, decoder };
  });
  useLayoutEffect(
    () => () => {
      cache.clear();
      decoder.dispose();
    },
    [cache, decoder],
  );
  return cache;
}
