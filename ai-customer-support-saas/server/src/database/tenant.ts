import { Types, type Document } from 'mongoose';

import { AppError } from '../core/errors/app-error.js';

/**
 * Tenant-isolation utilities.
 *
 * Tenancy model (shared pool): one database, every tenant-owned collection
 * carries a required `workspaceId` and indexes that lead with it. There is no
 * global query interceptor (intentional — they are opaque and fragile);
 * instead, isolation is enforced by:
 *
 *   1. Schema design  — `workspaceId` is required on every tenant-owned model.
 *   2. Repository convention — every query builds its filter through
 *      `tenantFilter()` and is defended by `assertTenantScope()`.
 *   3. Index design   — compound indexes lead with `workspaceId`, so an
 *      unscoped scan is both wrong and slow.
 *
 * Future modules MUST go through these helpers rather than hand-rolling
 * `{ workspaceId }` literals, which is how cross-tenant leaks happen.
 */

/**
 * Base shape every tenant-owned document must satisfy. Models extend this so
 * TypeScript itself rejects a tenant-owned collection that forgot
 * `workspaceId`.
 */
export interface TenantScopedDocument extends Document<Types.ObjectId> {
  workspaceId: Types.ObjectId;
}

/** Anything a caller may hand to the helpers as a workspace reference. */
export type TenantScopeValue = Types.ObjectId | string;

/**
 * Builds the mandatory workspace filter. Always converts to ObjectId so the
 * query hits the index regardless of whether callers carry strings or ids.
 *
 * Repositories spread this into every tenant-owned query:
 *
 *   CustomerModel.findOne({ ...tenantFilter(workspaceId), email })
 */
export function tenantFilter(workspaceId: TenantScopeValue): { workspaceId: Types.ObjectId } {
  return { workspaceId: new Types.ObjectId(workspaceId) };
}

/**
 * Programming guard used inside repositories: verifies a filter actually
 * carries a workspace scope before it is sent to MongoDB.
 *
 * Throws a non-operational `AppError` — a repository that reaches MongoDB
 * without a tenant scope is a bug, not a user-facing condition, and must
 * surface as an opaque 500 (never silently return another tenant's rows).
 */
export function assertTenantScope(filter: Record<string, unknown>, context = 'query'): void {
  const workspaceId = filter['workspaceId'];
  if (workspaceId === undefined || workspaceId === null || workspaceId === '') {
    throw new AppError(`Missing workspaceId tenant scope in ${context}`, {
      statusCode: 500,
      code: 'TENANT_SCOPE_VIOLATION',
      isOperational: false,
    });
  }
}
