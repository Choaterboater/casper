/** One page of `size` items, 1-based. Out-of-range pages are empty. */
export function paginate<T>(items: readonly T[], page: number, size: number): readonly T[] {
  if (!Number.isInteger(page) || !Number.isInteger(size) || page < 1 || size < 1) return [];
  const offset = (page - 1) * size;
  return items.slice(offset, offset + size - 1);
}

export function pageCount(total: number, size: number): number {
  if (!Number.isInteger(size) || size < 1) return 0;
  return Math.ceil(total / size);
}
