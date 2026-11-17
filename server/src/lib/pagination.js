import { validate } from './validate.js';

const PAGE_SCHEMA = {
  page: { type: 'number', integer: true, min: 1 },
  limit: { type: 'number', integer: true, min: 1, max: 100 },
  q: { type: 'string' },
  sort: { type: 'string' },
};

/** Validate list-query params: base pagination fields plus route-specific extras. */
export function parseListQuery(query, extraSchema = {}) {
  const parsed = validate(query, { ...PAGE_SCHEMA, ...extraSchema });
  return {
    page: parsed.page ?? 1,
    limit: parsed.limit ?? 20,
    q: parsed.q,
    sort: parsed.sort,
    ...Object.fromEntries(
      Object.keys(extraSchema)
        .filter((k) => parsed[k] !== undefined)
        .map((k) => [k, parsed[k]]),
    ),
  };
}

/**
 * Same semantics as the old buildOrderBy: "field:asc|desc", restricted to an
 * allowlist of API field names, mapped to SQL columns, with a fallback.
 */
export function buildOrder(sort, allowedFieldToColumn, fallbackSql) {
  if (!sort) return fallbackSql;
  const [field, dirRaw] = sort.split(':');
  const dir = dirRaw?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const column = Object.hasOwn(allowedFieldToColumn, field) ? allowedFieldToColumn[field] : undefined;
  if (!column) return fallbackSql;
  return `${column} ${dir}`;
}

export function pageMeta(total, page, limit) {
  return { total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}
