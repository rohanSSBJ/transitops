import { badRequest } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO8601_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function check(field, value, rules, errors) {
  const label = field;
  // @IsOptional(): null/undefined skip every remaining validator.
  if (value === undefined) {
    if (rules.required) {
      errors.push(`${label} should not be empty`);
    }
    return undefined;
  }
  if (value === null) {
    // @IsOptional() ignores null; the value still passes through (e.g. PATCH contact: null).
    if (rules.required) {
      errors.push(`${label} should not be empty`);
      return undefined;
    }
    return null;
  }
  let v = value;
  if (rules.type === 'number') {
    // class-transformer implicit conversion: numeric strings become numbers.
    if (typeof v === 'string' && v.trim() !== '') v = Number(v);
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${label} must be a number conforming to the specified constraints`);
      return undefined;
    }
    if (rules.integer && !Number.isInteger(v)) {
      errors.push(`${label} must be an integer number`);
    }
  } else if (rules.type === 'string') {
    if (typeof v !== 'string') {
      errors.push(`${label} must be a string`);
      return undefined;
    }
    if (rules.minLength && v.length < rules.minLength) {
      errors.push(
        `${label} must be longer than or equal to ${rules.minLength} characters`,
      );
    }
  } else if (rules.type === 'email') {
    if (typeof v !== 'string' || !EMAIL_RE.test(v)) {
      errors.push(`${label} must be an email`);
      return undefined;
    }
    if (rules.minLength && v.length < rules.minLength) {
      errors.push(
        `${label} must be longer than or equal to ${rules.minLength} characters`,
      );
    }
  } else if (rules.type === 'uuid') {
    if (typeof v !== 'string' || !UUID_RE.test(v)) {
      errors.push(`${label} must be a UUID`);
      return undefined;
    }
  } else if (rules.type === 'enum') {
    if (typeof v !== 'string' || !rules.values.includes(v)) {
      errors.push(
        `${label} must be one of the following values: ${rules.values.join(', ')}`,
      );
      return undefined;
    }
  } else if (rules.type === 'date') {
    if (
      typeof v !== 'string' ||
      !ISO8601_RE.test(v) ||
      Number.isNaN(Date.parse(v))
    ) {
      errors.push(`${label} must be a valid ISO 8601 date string`);
      return undefined;
    }
  } else if (rules.type === 'boolean-string') {
    if (v !== 'true' && v !== 'false') {
      errors.push(`${label} must be a boolean string`);
      return undefined;
    }
  }
  if (rules.min !== undefined && typeof v === 'number' && v < rules.min) {
    errors.push(rules.minMessage || `${label} must not be less than ${rules.min}`);
  }
  if (rules.max !== undefined && typeof v === 'number' && v > rules.max) {
    errors.push(`${label} must not be greater than ${rules.max}`);
  }
  return v;
}

/**
 * Validate a payload (request body or query) against a schema.
 * Mirrors the old global ValidationPipe: whitelist + forbidNonWhitelisted +
 * implicit number conversion. Throws a 400 ApiError with a message array.
 * Returns a new object containing only the schema's fields.
 */
export function validate(payload, schema) {
  const input = payload ?? {};
  const errors = [];
  for (const key of Object.keys(input)) {
    if (!(Object.hasOwn(schema, key))) errors.push(`property ${key} should not exist`);
  }
  const out = {};
  for (const [field, rules] of Object.entries(schema)) {
    const v = check(field, input[field], rules, errors);
    if (v !== undefined) out[field] = v;
  }
  if (errors.length) throw badRequest(errors);
  return out;
}
