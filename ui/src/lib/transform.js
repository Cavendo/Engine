/**
 * Convert a camelCase string to snake_case
 */
function camelToSnake(str) {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

/**
 * Convert object keys from camelCase to snake_case recursively.
 * Used to reverse the toCamelCase transformation applied by API responses
 * before sending data back to the server.
 */
export function toSnakeCase(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(item => toSnakeCase(item));
  if (typeof obj === 'object' && obj.constructor === Object) {
    const result = {};
    for (const key of Object.keys(obj)) {
      result[camelToSnake(key)] = toSnakeCase(obj[key]);
    }
    return result;
  }
  return obj;
}
