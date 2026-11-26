import type { AuthSessionPayload, PublicUser } from '@/features/auth/types';
import { useSessionStore } from '@/features/auth/auth.store';
import type { DashboardAnalytics, TicketStatusCounts } from '@/features/analytics/types';
import type {
  CustomerDto,
  CustomerListPayload,
} from '@/features/customers/types';
import type { TicketDto, TicketListPayload } from '@/features/tickets/types';
import type { WorkspaceListItem, WorkspaceRole } from '@/features/workspace/types';
import { useWorkspaceStore } from '@/features/workspace/workspace.store';
import { clearAccessToken } from '@/services/auth-token.store';

export const TEST_USER: PublicUser = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  status: 'active',
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

export function makeWorkspace(id: string, name: string, role: WorkspaceRole = 'owner'): WorkspaceListItem {
  return {
    workspace: {
      id,
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      ownerId: 'user-1',
      status: 'active',
      settings: { timezone: 'UTC', locale: 'en' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    membership: {
      id: `member-${id}`,
      workspaceId: id,
      userId: 'user-1',
      role,
      status: 'active',
      joinedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

export function makeSessionPayload(): AuthSessionPayload {
  return {
    user: TEST_USER,
    tokens: { accessToken: 'memory-only-token', expiresIn: 900, refreshInCookie: true },
  };
}

const ZERO_STATUS_COUNTS: TicketStatusCounts = {
  OPEN: 0,
  IN_PROGRESS: 0,
  WAITING_FOR_CUSTOMER: 0,
  RESOLVED: 0,
  CLOSED: 0,
};

export interface DashboardFixtureOptions {
  ticketTotal?: number;
  statusCounts?: Partial<TicketStatusCounts>;
  createdInPeriod?: number;
  resolvedInPeriod?: number;
  averageResolutionMs?: number | null;
  medianResolutionMs?: number | null;
  customerTotal?: number;
  newCustomers?: number;
  createdTrend?: readonly number[];
  resolvedTrend?: readonly number[];
  empty?: boolean;
}

/**
 * Deterministic analytics payload for component/state tests. Every value is
 * explicitly test data — nothing here is shipped in the application.
 */
export function makeDashboardAnalytics(options: DashboardFixtureOptions = {}): DashboardAnalytics {
  const statusCounts: TicketStatusCounts = options.empty
    ? { ...ZERO_STATUS_COUNTS }
    : {
        OPEN: 8,
        IN_PROGRESS: 4,
        WAITING_FOR_CUSTOMER: 2,
        RESOLVED: 5,
        CLOSED: 1,
        ...options.statusCounts,
      };

  const total = options.ticketTotal ?? Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
  const createdTrend = options.empty ? [] : (options.createdTrend ?? [2, 3, 1]);
  const resolvedTrend = options.empty ? [] : (options.resolvedTrend ?? [1, 1, 1]);
  const averageResolutionMs = options.empty ? null : (options.averageResolutionMs ?? 5_400_000);
  const medianResolutionMs = options.empty ? null : (options.medianResolutionMs ?? 4_800_000);

  const buckets = createdTrend.map((_, index) =>
    new Date(Date.UTC(2026, 8, 1 + index)).toISOString(),
  );
  const period = {
    range: '30d' as const,
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-10-01T00:00:00.000Z',
    bucket: 'day' as const,
    timezone: 'UTC' as const,
  };

  const createdInPeriod = options.empty ? 0 : (options.createdInPeriod ?? createdTrend.reduce((sum, count) => sum + count, 0));
  const resolvedInPeriod = options.empty ? 0 : (options.resolvedInPeriod ?? resolvedTrend.reduce((sum, count) => sum + count, 0));
  const customerTotal = options.empty ? 0 : (options.customerTotal ?? 12);
  const newCustomers = options.empty ? 0 : (options.newCustomers ?? 2);

  const resolution = {
    count: options.empty ? 0 : resolvedInPeriod,
    averageMs: averageResolutionMs,
    medianMs: medianResolutionMs,
    minMs: options.empty ? null : 1_200_000,
    maxMs: options.empty ? null : 12_000_000,
  };

  const backlogOpen = statusCounts.OPEN;
  const backlogInProgress = statusCounts.IN_PROGRESS;
  const backlogWaiting = statusCounts.WAITING_FOR_CUSTOMER;

  return {
    overview: {
      period,
      tickets: {
        total,
        open: statusCounts.OPEN,
        inProgress: statusCounts.IN_PROGRESS,
        waitingForCustomer: statusCounts.WAITING_FOR_CUSTOMER,
        resolved: statusCounts.RESOLVED,
        closed: statusCounts.CLOSED,
        byStatus: statusCounts,
        byPriority: { LOW: 2, MEDIUM: 6, HIGH: 8, URGENT: 4 },
        createdInPeriod,
        resolvedInPeriod,
        assignment: { assigned: 10, unassigned: 10 },
        topAssignees: [],
      },
      customers: {
        total: customerTotal,
        newInPeriod: newCustomers,
        byStatus: { active: customerTotal, blocked: 0 },
      },
      conversations: {
        total: options.empty ? 0 : 10,
        open: options.empty ? 0 : 6,
        closed: options.empty ? 0 : 4,
        createdInPeriod: options.empty ? 0 : 3,
      },
      escalations: {
        total: options.empty ? 0 : 2,
        active: 0,
        createdInPeriod: 0,
        byStatus: { PENDING: 0, ASSIGNED: 0, ACCEPTED: 0, RESOLVED: 2, CANCELLED: 0 },
      },
      knowledgeBase: { total: 0, published: 0, draft: 0, archived: 0 },
      ai: {
        requests: 0,
        answered: 0,
        abstained: 0,
        failed: 0,
        citationBackedAnswers: 0,
        aiEscalations: 0,
        humanHandoffs: 0,
      },
    },
    tickets: {
      period,
      tickets: { total, createdInPeriod, resolvedInPeriod },
      byStatus: statusCounts,
      byPriority: { LOW: 2, MEDIUM: 6, HIGH: 8, URGENT: 4 },
      assignment: { assigned: 10, unassigned: 10 },
      topAssignees: [],
      created: createdTrend.map((count, index) => ({ bucket: buckets[index] ?? period.from, count })),
      resolved: resolvedTrend.map((count, index) => ({ bucket: buckets[index] ?? period.from, count })),
      resolutionTime: resolution,
    },
    performance: {
      period,
      backlog: {
        open: backlogOpen,
        inProgress: backlogInProgress,
        waitingForCustomer: backlogWaiting,
        totalBacklog: backlogOpen + backlogInProgress + backlogWaiting,
        unassigned: options.empty ? 0 : 3,
        byPriority: { LOW: 2, MEDIUM: 6, HIGH: 8, URGENT: 4 },
      },
      resolutionTime: resolution,
      firstStaffReply: {
        conversations: options.empty ? 0 : 7,
        averageMs: options.empty ? null : 2_400_000,
      },
      customerFirstResponse: {
        available: false,
        reason: 'No customer-sender messages exist in this deployment.',
      },
      escalationFrequency: { escalationsCreated: 0, ticketsCreated: createdInPeriod, perTicket: 0 },
      conversationVolume: {
        conversationsCreated: options.empty ? 0 : 3,
        messages: { total: 0, public: 0, internal: 0 },
      },
    },
  };
}

/** Deterministic, well-formed ids for customer/ticket fixtures. */
export const TEST_CUSTOMER_ID = '507f1f77bcf86cd799439011';
export const TEST_TICKET_ID = '507f1f77bcf86cd799439021';
export const TEST_SECOND_CUSTOMER_ID = '507f1f77bcf86cd799439013';
export const TEST_SECOND_TICKET_ID = '507f1f77bcf86cd799439022';

export function makeCustomer(overrides: Partial<CustomerDto> = {}): CustomerDto {
  return {
    id: TEST_CUSTOMER_ID,
    workspaceId: '507f1f77bcf86cd799439012',
    name: 'Jordan Lee',
    email: 'jordan@example.com',
    phone: '+1 555 010 0100',
    avatarUrl: null,
    status: 'active',
    tags: ['vip'],
    metadata: { crmId: 'crm-1' },
    lastInteractionAt: '2026-09-10T08:00:00.000Z',
    archivedAt: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-10T08:00:00.000Z',
    ...overrides,
  };
}

export function makeCustomerList(
  items: readonly CustomerDto[] = [makeCustomer()],
  overrides: Partial<Omit<CustomerListPayload, 'items'>> = {},
): CustomerListPayload {
  const limit = overrides.limit ?? 20;
  return {
    items,
    page: overrides.page ?? 1,
    limit,
    total: overrides.total ?? items.length,
    hasMore: overrides.hasMore ?? false,
  };
}

export function makeTicket(overrides: Partial<TicketDto> = {}): TicketDto {
  return {
    id: TEST_TICKET_ID,
    workspaceId: '507f1f77bcf86cd799439012',
    number: 'TKT-000001',
    customerId: TEST_CUSTOMER_ID,
    subject: 'Invoice shows the wrong total',
    description: 'The September invoice is 20 EUR too high.',
    status: 'OPEN',
    priority: 'HIGH',
    agentId: null,
    createdById: '507f1f77bcf86cd799439031',
    tags: ['billing'],
    category: 'billing',
    resolutionNote: null,
    dueAt: null,
    resolvedAt: null,
    closedAt: null,
    archivedAt: null,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-06T11:30:00.000Z',
    ...overrides,
  };
}

export function makeTicketList(
  items: readonly TicketDto[] = [makeTicket()],
  overrides: Partial<Omit<TicketListPayload, 'items'>> = {},
): TicketListPayload {
  const limit = overrides.limit ?? 20;
  return {
    items,
    page: overrides.page ?? 1,
    limit,
    total: overrides.total ?? items.length,
    hasMore: overrides.hasMore ?? false,
  };
}

/** Returns every store the auth/workspace tests share to a clean slate. */
export function resetAuthStores(): void {
  useSessionStore.setState({ status: 'idle', user: null, error: null });
  useWorkspaceStore.setState({ status: 'idle', items: [], activeWorkspaceId: null, error: null });
  clearAccessToken();
  window.localStorage.clear();
}
