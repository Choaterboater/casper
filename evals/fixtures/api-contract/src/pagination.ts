/** Hard cap from the v1 API contract (docs/api.md). Clients rely on it; see CONTEXT.md. */
export const MAX_PAGE_SIZE = 100;

export interface PageRequest {
  readonly page: number;
  readonly size: number;
}

/** One 1-based page of at most `MAX_PAGE_SIZE` items. Invalid requests yield an empty page. */
export function paginate<T>(items: readonly T[], request: PageRequest): readonly T[] {
  if (!Number.isInteger(request.page) || !Number.isInteger(request.size) || request.page < 1 || request.size < 1) return [];
  const size = Math.min(request.size, MAX_PAGE_SIZE);
  const offset = (request.page - 1) * size;
  return items.slice(offset, offset + size);
}

export function pageCount(total: number, size: number): number {
  if (!Number.isInteger(size) || size < 1) return 0;
  return Math.ceil(total / Math.min(size, MAX_PAGE_SIZE));
}
