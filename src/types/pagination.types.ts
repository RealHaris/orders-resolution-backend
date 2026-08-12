/**
 * Standard paginated response type
 */
export interface PaginatedResponse<T> {
  list: T[];
  totalPages: number;
  pageNum: number;
  count: number;
}

/**
 * Standard pagination params (pageNum is 0-indexed after parse)
 */
export interface PaginationParams {
  pageNum: number;
  pageSize: number;
}
