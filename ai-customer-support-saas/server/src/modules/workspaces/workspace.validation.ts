import { z } from 'zod';

import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH } from './slug.js';

/**
 * Workspace request validation (Zod, applied declaratively at the routes).
 *
 * Rules mirrored from the Workspace model so HTTP-layer failures are 422s
 * while anything that slips past gets caught at the schema boundary.
 *
 * Mass-assignment protection: `createSchema` and `updateSchema` define the
 * ONLY accepted keys. Anything else (ownerId, status, role, membership
 * records, unknown settings) is stripped before a service ever sees the
 * payload — and `updateSchema` accepts no field that could change ownership,
 * membership or lifecycle.
 */
export const WORKSPACE_NAME_MAX = 100;
export const WORKSPACE_NAME_MIN = 3;

/** Zod mirror of the shared slug validation, with a helpful message. */
const slugSchema = z
  .string()
  .trim()
  .min(SLUG_MIN_LENGTH, `Slug must be at least ${SLUG_MIN_LENGTH} characters`)
  .max(SLUG_MAX_LENGTH, `Slug must be at most ${SLUG_MAX_LENGTH} characters`)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Slug may contain lowercase letters, digits and single hyphens only',
  );

const workspaceSettingsSchema = z
  .object({
    timezone: z.string().trim().min(1).max(64).default('UTC'),
    locale: z.string().trim().min(2).max(10).default('en'),
  })
  .strict();

export const createWorkspaceSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(WORKSPACE_NAME_MIN, `Workspace name must be at least ${WORKSPACE_NAME_MIN} characters`)
      .max(WORKSPACE_NAME_MAX),
    /** Optional — when absent, a slug is derived deterministically from the name. */
    slug: slugSchema.optional(),
    settings: workspaceSettingsSchema.optional(),
  })
  .strict();

export interface CreateWorkspaceInput {
  name: string;
  slug?: string;
  settings?: { timezone: string; locale: string };
}

export const updateWorkspaceSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(WORKSPACE_NAME_MIN, `Workspace name must be at least ${WORKSPACE_NAME_MIN} characters`)
      .max(WORKSPACE_NAME_MAX)
      .optional(),
    settings: workspaceSettingsSchema.partial().optional(),
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.settings !== undefined,
    { message: 'Provide at least one editable field (name or settings)' },
  );

export interface UpdateWorkspaceInput {
  name?: string;
  settings?: { timezone?: string; locale?: string };
}

/**
 * ObjectId-shaped path parameter. `validate(schema, 'params')` parses the
 * WHOLE `req.params` object against this schema (shape-level contract), so it
 * is an object schema keyed by the route's param name — defensively `.strict()`
 * so extra params never slip through unvalidated. The validated value is
 * re-exposed via `req.validated.params`; `req.params` is untouched (Express 5
 * live-getter constraint, see validate.middleware.ts). Well-formed-but-unknown
 * ids 404 via the workspace middleware; malformed ids are rejected here with
 * 422 (validation convention).
 */
export const workspaceIdParamSchema = z
  .object({
    workspaceId: z
      .string()
      .trim()
      .regex(/^[a-f\d]{24}$/i, 'Workspace id must be a 24-character hex string'),
  })
  .strict();

export const listWorkspacesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export interface ListWorkspacesQuery {
  page: number;
  limit: number;
}
