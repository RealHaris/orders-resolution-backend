import type {
  PaginatedResponse,
  PaginationParams,
} from "@/types/pagination.types";

/**
 * Parse pagination parameters from request query.
 * pageNum in the query is 1-indexed; returned pageNum is 0-indexed.
 */
export const parsePaginationParams = (query: {
  pageNum?: string;
  pageSize?: string;
}): PaginationParams => {
  let pageNum = parseInt(query.pageNum, 10);
  if (pageNum) pageNum = pageNum - 1;
  else pageNum = 0;

  if (Number.isNaN(pageNum)) pageNum = 0;

  const pageSize = parseInt(query.pageSize ?? "20", 10);

  return { pageNum, pageSize };
};

/**
 * Calculate total pages from count and page size.
 */
export const calculateTotalPages = (
  count: number,
  pageSize: number
): number => {
  return Math.ceil(count / pageSize);
};

/**
 * Format paginated response (pageNum converted back to 1-indexed).
 */
export const formatPaginatedResponse = <T>(
  list: T[],
  count: number,
  pageNum: number,
  pageSize: number
): PaginatedResponse<T> => {
  return {
    list,
    totalPages: calculateTotalPages(count, pageSize),
    pageNum: pageNum + 1,
    count,
  };
};
