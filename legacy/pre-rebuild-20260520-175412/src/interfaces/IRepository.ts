/**
 * IRepository Interface
 * Generic repository pattern for data access abstraction
 */

export interface IRepository<T> {
  /**
   * Find entity by ID
   */
  findById(id: string): Promise<T | null>;

  /**
   * Find all entities matching criteria
   */
  findAll(criteria?: Record<string, unknown>): Promise<T[]>;

  /**
   * Find one entity matching criteria
   */
  findOne(criteria: Record<string, unknown>): Promise<T | null>;

  /**
   * Create new entity
   */
  create(data: Partial<T>): Promise<T>;

  /**
   * Update existing entity
   */
  update(id: string, data: Partial<T>): Promise<T>;

  /**
   * Delete entity by ID
   */
  delete(id: string): Promise<boolean>;

  /**
   * Count entities matching criteria
   */
  count(criteria?: Record<string, unknown>): Promise<number>;

  /**
   * Check if entity exists
   */
  exists(id: string): Promise<boolean>;
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated result
 */
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * IRepositoryWithPagination Interface
 * Extended repository with pagination support
 */
export interface IRepositoryWithPagination<T> extends IRepository<T> {
  /**
   * Find entities with pagination
   */
  findWithPagination(
    criteria?: Record<string, unknown>,
    options?: PaginationOptions
  ): Promise<PaginatedResult<T>>;
}
