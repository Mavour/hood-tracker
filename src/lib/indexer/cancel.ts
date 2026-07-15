/**
 * Generation-based cancel for in-process index jobs.
 * Bumping the generation makes the old async indexAddress exit ASAP.
 */

type GlobalCancel = typeof globalThis & {
  __hoodIndexGen?: Map<string, number>;
};

function map(): Map<string, number> {
  const g = globalThis as GlobalCancel;
  if (!g.__hoodIndexGen) g.__hoodIndexGen = new Map();
  return g.__hoodIndexGen;
}

/** Call when starting a new index for address — invalidates any older run. */
export function bumpIndexGeneration(address: string): number {
  const key = address.toLowerCase();
  const m = map();
  const next = (m.get(key) ?? 0) + 1;
  m.set(key, next);
  return next;
}

export function currentIndexGeneration(address: string): number {
  return map().get(address.toLowerCase()) ?? 0;
}

export function isIndexCancelled(address: string, gen: number): boolean {
  return currentIndexGeneration(address) !== gen;
}
