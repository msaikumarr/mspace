export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, code = 'BAD_REQUEST') => new AppError(400, code, m);
export const unauthorized = (m = 'Authentication required', code = 'UNAUTHORIZED') => new AppError(401, code, m);
export const forbidden = (m = 'You do not have permission', code = 'FORBIDDEN') => new AppError(403, code, m);
export const notFound = (what = 'Resource', code?: string) =>
  new AppError(404, code || `${what.toUpperCase().replace(/\s+/g, '_')}_NOT_FOUND`, `${what} not found`);
export const conflict = (m: string, code = 'CONFLICT') => new AppError(409, code, m);
export const limitExceeded = (m: string, code = 'LIMIT_EXCEEDED') => new AppError(429, code, m);
