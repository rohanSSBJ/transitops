/** HTTP error carrying the same response shape the old NestJS filter produced. */
export class ApiError extends Error {
  constructor(statusCode, message, error) {
    super(typeof message === 'string' ? message : 'Error');
    this.statusCode = statusCode;
    this.message = message; // string | string[]
    this.error = error;
  }
}

export const badRequest = (messages) => new ApiError(400, messages, 'Bad Request');
export const unauthorized = (message = 'Unauthorized') => new ApiError(401, message, 'Unauthorized');
export const forbidden = (message) => new ApiError(403, message, 'Forbidden');
export const notFound = (message) => new ApiError(404, message, 'Not Found');
export const unprocessable = (message) => new ApiError(422, message, 'Unprocessable Entity');
export const serviceUnavailable = (message = 'Database unavailable') =>
  new ApiError(503, message, 'Service Unavailable');
export const tooManyRequests = () =>
  // NestJS ThrottlerException carried the default error label through the old filter.
  new ApiError(429, 'ThrottlerException: Too Many Requests', 'Internal Server Error');
