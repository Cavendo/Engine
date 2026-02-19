/**
 * Response transformation utilities
 * Converts database snake_case column names to camelCase for JSON API responses
 */

/**
 * Convert a snake_case string to camelCase
 * @param {string} str - The snake_case string
 * @returns {string} The camelCase string
 */
export function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Convert object keys from snake_case to camelCase recursively
 * Handles nested objects and arrays
 * @param {any} obj - The object to transform
 * @returns {any} The transformed object with camelCase keys
 */
export function toCamelCase(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => toCamelCase(item));
  }

  if (typeof obj === 'object' && obj.constructor === Object) {
    const result = {};
    for (const key of Object.keys(obj)) {
      const camelKey = snakeToCamel(key);
      result[camelKey] = toCamelCase(obj[key]);
    }
    return result;
  }

  // Primitives (string, number, boolean, etc.)
  return obj;
}

/**
 * Convert a camelCase string to snake_case
 * @param {string} str - The camelCase string
 * @returns {string} The snake_case string
 */
export function camelToSnake(str) {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

/**
 * Convert object keys from camelCase to snake_case recursively
 * Useful for transforming incoming request bodies to database format
 * @param {any} obj - The object to transform
 * @returns {any} The transformed object with snake_case keys
 */
export function toSnakeCase(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => toSnakeCase(item));
  }

  if (typeof obj === 'object' && obj.constructor === Object) {
    const result = {};
    for (const key of Object.keys(obj)) {
      const snakeKey = camelToSnake(key);
      result[snakeKey] = toSnakeCase(obj[key]);
    }
    return result;
  }

  // Primitives (string, number, boolean, etc.)
  return obj;
}
