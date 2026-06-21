/**
 * IPC input validation helpers.
 * Used at the IPC boundary to sanitize parameters from the renderer process.
 */

export class ValidationError extends Error {
  code = 'INVALID_INPUT' as const;
}

export function requireString(val: unknown, name: string, maxLen = 10000): string {
  if (typeof val !== 'string' || val.length === 0)
    throw new ValidationError(`${name} must be a non-empty string`);
  if (val.length > maxLen)
    throw new ValidationError(`${name} exceeds max length ${maxLen}`);
  return val;
}

export function requireId(val: unknown, name = 'id'): number {
  const n = Number(val);
  if (!Number.isInteger(n) || n <= 0)
    throw new ValidationError(`${name} must be a positive integer`);
  return n;
}

export function optionalId(val: unknown, name = 'id'): number | undefined {
  if (val === undefined || val === null) return undefined;
  return requireId(val, name);
}

export function requireEnum<T extends string>(val: unknown, allowed: T[], name: string): T {
  if (!allowed.includes(val as T))
    throw new ValidationError(`${name} must be one of: ${allowed.join(', ')}`);
  return val as T;
}

export function optionalString(val: unknown, name: string, maxLen = 10000): string | undefined {
  if (val === undefined || val === null) return undefined;
  return requireString(val, name, maxLen);
}

export function requireDate(val: unknown, name: string): string {
  const s = requireString(val, name, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
    throw new ValidationError(`${name} must be YYYY-MM-DD format`);
  return s;
}

export function sanitizePath(val: unknown, name: string): string {
  const s = requireString(val, name, 1000);
  if (s.includes('..'))
    throw new ValidationError(`${name} must not contain '..'`);
  return s;
}

export function requireUrl(val: unknown, name: string): string {
  const s = requireString(val, name, 2000);
  if (!s.startsWith('http://') && !s.startsWith('https://'))
    throw new ValidationError(`${name} must start with http:// or https://`);
  return s;
}

export function requirePort(val: unknown, name = 'port'): number {
  const n = Number(val);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new ValidationError(`${name} must be an integer between 1 and 65535`);
  return n;
}
