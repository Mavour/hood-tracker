/** Prefix for fetch() — next/link already respects next.config basePath. */
export function apiUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}
