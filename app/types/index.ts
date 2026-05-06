// ─────────────────────────────────────────────
// Global shared types
// Domain-specific types live next to their feature
// ─────────────────────────────────────────────

// API response wrapper — all API routes return this shape
export interface ApiResponse<T> {
  data: T
  error?: string
}

// Pagination
export interface PaginationParams {
  page: number
  pageSize: number
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}
