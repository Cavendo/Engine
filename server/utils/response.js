/**
 * Standardized API response helpers
 */

import { toCamelCase } from './transform.js';

/**
 * Success response
 * Automatically transforms snake_case keys to camelCase
 * @param {object} res - Express response object
 * @param {any} data - Response data
 * @param {number} status - HTTP status code (default 200)
 */
export function success(res, data, status = 200) {
  res.status(status).json({
    success: true,
    data: toCamelCase(data)
  });
}

/**
 * Created response (201)
 * @param {object} res - Express response object
 * @param {any} data - Response data
 */
export function created(res, data) {
  success(res, data, 201);
}

/**
 * Error response
 * @param {object} res - Express response object
 * @param {string} message - Error message
 * @param {number} status - HTTP status code (default 400)
 * @param {string} code - Error code for programmatic handling
 */
export function error(res, message, status = 400, code = 'BAD_REQUEST') {
  res.status(status).json({
    success: false,
    error: {
      code,
      message
    }
  });
}

/**
 * Not found response (404)
 * @param {object} res - Express response object
 * @param {string} resource - Resource name
 */
export function notFound(res, resource = 'Resource') {
  error(res, `${resource} not found`, 404, 'NOT_FOUND');
}

/**
 * Unauthorized response (401)
 * @param {object} res - Express response object
 * @param {string} message - Error message
 */
export function unauthorized(res, message = 'Authentication required') {
  error(res, message, 401, 'UNAUTHORIZED');
}

/**
 * Forbidden response (403)
 * @param {object} res - Express response object
 * @param {string} message - Error message
 */
export function forbidden(res, message = 'Access denied') {
  error(res, message, 403, 'FORBIDDEN');
}

/**
 * Validation error response (422)
 * @param {object} res - Express response object
 * @param {string} message - Error message
 * @param {object} errors - Field-specific errors
 */
export function validationError(res, message, errors = {}) {
  res.status(422).json({
    success: false,
    error: {
      code: 'VALIDATION_ERROR',
      message,
      errors
    }
  });
}

/**
 * Bad request response (400)
 * @param {object} res - Express response object
 * @param {string} message - Error message
 */
export function badRequest(res, message = 'Bad request') {
  error(res, message, 400, 'BAD_REQUEST');
}

/**
 * Conflict response (409)
 * @param {object} res - Express response object
 * @param {string} message - Error message
 */
export function conflict(res, message = 'Resource conflict') {
  error(res, message, 409, 'CONFLICT');
}

/**
 * Internal server error (500)
 * @param {object} res - Express response object
 * @param {string} message - Error message
 */
export function serverError(res, message = 'Internal server error') {
  error(res, message, 500, 'INTERNAL_ERROR');
}
