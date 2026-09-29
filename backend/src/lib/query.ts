import {
  buildFilterQuery,
  createQueryExtractor,
  type FilteringQuery,
  type PrismaWhereCondition,
  type QueryParams,
  type QuerySpecification,
} from '@nodewave/prisma-ezfilter';
import { AppError } from './errors.ts';

/**
 * The standard list-endpoint contract, implemented on top of
 * `@nodewave/prisma-ezfilter` (NodeWave's own package).
 *
 * Every collection endpoint in this API accepts the same query string:
 *
 *   ?filters={"status":["TODO","BLOCKED"],"priority":"HIGH"}
 *   &searchFilters={"title":"login","description":"oauth"}
 *   &rangedFilters=[{"key":"dueDate","start":"2026-01-01","end":"2026-03-01"}]
 *   &orderKey=createdAt&orderRule=desc
 *   &page=1&rows=20
 *
 * The three filter groups are JSON-encoded strings rather than repeated query
 * keys so that a filter value may itself be an object or an array, and so that
 * `orderKey` can address a nested relation path without colliding with a
 * field name.
 *
 * Two properties are layered on top of the library, both of which the library
 * cannot know about:
 *
 *  1. **Mandatory scoping.** `runQuery` takes a `scope` predicate which is
 *     ANDed with whatever the client asked for. This is where multi-tenant
 *     isolation and project membership are enforced for reads — a client cannot
 *     widen their own visibility by crafting a filter.
 *  2. **Allow-listed fields.** `QuerySpecification.allowedFields` /
 *     `forbiddenFields` are derived from the endpoint's own spec, never from
 *     client input, so `?filters={"clientOrgId":"..."}` is rejected rather
 *     than silently ignored.
 */

export interface ListMeta {
  page: number;
  rows: number;
  total: number;
  totalPage: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface ListResult<T> {
  data: T[];
  meta: ListMeta;
}

export interface RunQueryOptions<T, TDelegate> {
  /** Raw query params, typically `c.req.query()`. */
  params: QueryParams;
  /** A Prisma model delegate, e.g. `prisma.task`. */
  delegate: TDelegate;
  /** Field/relation allow-lists for this endpoint. */
  spec: QuerySpecification;
  /**
   * Non-negotiable visibility predicate, ANDed after the client's filters.
   * For a CLIENT_GUEST this carries the organisation boundary; for an
   * INTERNAL_TEAM member it carries the project-membership boundary.
   */
  scope: PrismaWhereCondition;
  /** Extra relations to `include` (already validated by the caller). */
  include?: Record<string, unknown>;
  /** Static ordering applied before the client's `orderKey`. */
  stableOrderBy?: Record<string, 'asc' | 'desc'>;
  transform?: (rows: unknown[]) => Promise<T[]> | T[];
}

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

/** Specs never take field allow-lists from the client. */
function normaliseSpec(spec: QuerySpecification): QuerySpecification {
  return {
    maxPageSize: MAX_PAGE_SIZE,
    defaultPageSize: DEFAULT_PAGE_SIZE,
    defaultSearchMode: 'insensitive',
    ...spec,
  };
}

function parseJsonParam(raw: string | string[] | undefined, name: string): unknown {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new AppError('VALIDATION_ERROR', `Query parameter '${name}' must be valid JSON`, { param: name });
  }
}

function toNumber(raw: string | string[] | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Normalise raw query params into ezfilter's `FilteringQuery` shape. */
export function parseListQuery(params: QueryParams): FilteringQuery {
  const extractor = createQueryExtractor(params);
  const parsed: FilteringQuery = extractor.getQueryParams() as unknown as FilteringQuery;

  const filters = parseJsonParam(params.filters, 'filters');
  const searchFilters = parseJsonParam(params.searchFilters, 'searchFilters');
  const rangedFilters = parseJsonParam(params.rangedFilters, 'rangedFilters');

  const asRecord = (v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const asRanged = (v: unknown) => (Array.isArray(v) ? (v as FilteringQuery['rangedFilters']) : []);

  return {
    ...parsed,
    ...(asRecord(filters) ? { filters: asRecord(filters) } : {}),
    ...(asRecord(searchFilters) ? { searchFilters: asRecord(searchFilters) } : {}),
    rangedFilters: asRanged(rangedFilters),
    ...(params.orderKey !== undefined
      ? { orderKey: Array.isArray(params.orderKey) ? params.orderKey[0] : params.orderKey }
      : {}),
    ...(params.orderRule !== undefined
      ? { orderRule: (Array.isArray(params.orderRule) ? params.orderRule[0] : params.orderRule) as 'asc' | 'desc' }
      : {}),
    page: toNumber(params.page) ?? 1,
    rows: toNumber(params.rows) ?? DEFAULT_PAGE_SIZE,
  };
}

export async function runQuery<
  T,
  TDelegate extends { findMany: (a: any) => Promise<any>; count: (a: any) => Promise<number> },
>(options: RunQueryOptions<T, TDelegate>): Promise<ListResult<T>> {
  const spec = normaliseSpec(options.spec);
  const query = parseListQuery(options.params);

  // `buildFilterQuery` validates the client's filters against `spec` (an
  // allow-list the server controls) and returns a Prisma-shaped where/orderBy.
  const built = buildFilterQuery(query, spec);

  const page = Math.max(1, Math.floor(query.page ?? 1));
  const rows = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.rows ?? DEFAULT_PAGE_SIZE)));

  /**
   * The client's filters are intersected with the server's scope. The scope is
   * ANDed unconditionally, so a client can never widen their own visibility by
   * crafting a filter — and the soft-delete guard is already applied by the
   * Prisma extension, so it does not belong here.
   */
  const where: PrismaWhereCondition = { AND: [built.where ?? {}, options.scope] };

  const orderBy: Record<string, 'asc' | 'desc'>[] = [];
  if (options.stableOrderBy) orderBy.push(options.stableOrderBy);
  if (built.orderBy) {
    const ob = Array.isArray(built.orderBy) ? built.orderBy[0] : built.orderBy;
    if (ob) orderBy.push(ob as Record<string, 'asc' | 'desc'>);
  }
  // Deterministic tiebreaker so page 2 never repeats or skips rows that share
  // the same sort key (a real bug when ordering by a non-unique column).
  orderBy.push({ id: 'asc' });

  const findArgs = {
    where,
    take: rows,
    skip: (page - 1) * rows,
    orderBy,
    ...(options.include ? { include: options.include } : {}),
  };

  const [rawRows, total] = await Promise.all([options.delegate.findMany(findArgs), options.delegate.count({ where })]);

  const data = options.transform ? await options.transform(rawRows) : (rawRows as T[]);

  return {
    data,
    meta: {
      page,
      rows,
      total,
      totalPage: Math.max(1, Math.ceil(total / rows)),
      hasNextPage: page * rows < total,
      hasPrevPage: page > 1,
    },
  };
}

/** A `QuerySpecification` for a task listing. Field names are Prisma paths. */
export const taskListSpec: QuerySpecification = {
  allowedFields: [
    'id',
    'title',
    'status',
    'priority',
    'department',
    'assigneeId',
    'isClientVisible',
    'createdAt',
    'updatedAt',
    'dueDate',
    'estimateHours',
    'orderIndex',
    'projectId',
  ],
  allowedRelations: ['project', 'assignee', 'blockedBy', 'prerequisites'],
  forbiddenFields: ['clientOrgId'],
  requiredFields: [],
};
