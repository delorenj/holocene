/**
 * IService Interface
 * Base interface for all service layer components
 */

export interface IService {
  /**
   * Service name/identifier
   */
  readonly name: string;

  /**
   * Initialize the service
   */
  initialize?(): Promise<void>;

  /**
   * Cleanup resources
   */
  dispose?(): Promise<void>;
}

/**
 * Service Result wrapper for error handling
 */
export type ServiceResult<T> = {
  success: true;
  data: T;
} | {
  success: false;
  error: Error;
  code?: string;
};

/**
 * Helper to create success result
 */
export function createSuccess<T>(data: T): ServiceResult<T> {
  return { success: true, data };
}

/**
 * Helper to create error result
 */
export function createError<T>(error: Error, code?: string): ServiceResult<T> {
  return { success: false, error, code };
}
