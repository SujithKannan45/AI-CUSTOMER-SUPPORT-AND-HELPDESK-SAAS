import { Router } from 'express';

import { validate } from '../../core/middlewares/validate.middleware.js';
import { requireAuth } from '../auth/require-auth.middleware.js';
import { WORKSPACE_PERMISSIONS } from '../rbac/rbac.permissions.js';
import { requirePermission } from '../rbac/require-permission.middleware.js';
import { requireWorkspaceContext } from '../workspaces/require-workspace.middleware.js';

import {
  archiveCustomerController,
  createCustomerController,
  getCustomerController,
  getCustomerSummaryController,
  listCustomersController,
  restoreCustomerController,
  updateCustomerController,
} from './customer.controller.js';
import {
  createCustomerSchema,
  customerIdParamSchema,
  listCustomersQuerySchema,
  updateCustomerSchema,
} from './customer.validation.js';

/**
 * Customer routes — mounted at
 * `/api/v1/workspaces/:workspaceId/customers` (routes/api.routes.ts).
 *
 * The parent router's `:workspaceId` param arrives through this Router's
 * params object; both ids are validated together by `customerIdParamSchema`
 * BEFORE `requireWorkspaceContext()` consumes the workspace (which parses
 * only the workspaceId key — see require-workspace.middleware.ts).
 *
 * Gate order (same as workspaces):
 *   1. requireAuth                        → 401
 *   2. validate(schema, 'params'|'body'|'query') → 422
 *   3. requireWorkspaceContext()          → 404 (foreign/inactive concealed)
 *   4. requirePermission(...)             → 403 (registry decision + audit)
 *
 * Permission mapping (registry grants, current state):
 * - create/update/archive/restore → `customer.create` / `customer.update`
 *   (owner + admin ONLY — agents and viewers are denied by the registry;
 *   no separate permission exists for archive because archival is a
 *   mutation of the same record lifecycle).
 * - read/list/summary → `customer.view` (owner/admin/agent/viewer).
 */
export const customerRouter = Router({ mergeParams: true });

const requireWorkspace = requireWorkspaceContext();

customerRouter.post(
  '/',
  requireAuth,
  validate(createCustomerSchema),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.createCustomer),
  createCustomerController,
);

customerRouter.get(
  '/',
  requireAuth,
  validate(listCustomersQuerySchema, 'query'),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.viewCustomers),
  listCustomersController,
);

customerRouter.get(
  '/:customerId',
  requireAuth,
  validate(customerIdParamSchema, 'params'),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.viewCustomers),
  getCustomerController,
);

customerRouter.patch(
  '/:customerId',
  requireAuth,
  validate(customerIdParamSchema, 'params'),
  validate(updateCustomerSchema),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.updateCustomer),
  updateCustomerController,
);

customerRouter.patch(
  '/:customerId/archive',
  requireAuth,
  validate(customerIdParamSchema, 'params'),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.updateCustomer),
  archiveCustomerController,
);

customerRouter.patch(
  '/:customerId/restore',
  requireAuth,
  validate(customerIdParamSchema, 'params'),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.updateCustomer),
  restoreCustomerController,
);

customerRouter.get(
  '/:customerId/summary',
  requireAuth,
  validate(customerIdParamSchema, 'params'),
  requireWorkspace,
  requirePermission(WORKSPACE_PERMISSIONS.viewCustomers),
  getCustomerSummaryController,
);
