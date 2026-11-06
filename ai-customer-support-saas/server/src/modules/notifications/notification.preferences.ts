import type {
  NotificationCategory,
  NotificationPreferenceValues,
  NotificationType,
} from './notification.types.js';

/**
 * Preference defaults and the type → category law.
 *
 * Every notification type maps to EXACTLY ONE category (the `Record` type
 * makes a new type a compile error until it is mapped), so a preference
 * toggle can never leave an event silently unmapped. Defaults are "on" for
 * every channel and category: a desk that misses an assignment costs more
 * than a slightly noisy inbox, and users opt out explicitly.
 *
 * Honest scope: there are no MANDATORY notification types today. Auth
 * security emails (verify/reset) live in the auth module and are not
 * preferences-gated; this module covers operational support events only.
 * If a future prompt adds a security notice here, it belongs in
 * `MANDATORY_NOTIFICATION_TYPES` and must bypass the category gate.
 */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferenceValues = {
  inAppEnabled: true,
  emailEnabled: true,
  ticketAssignment: true,
  ticketUpdates: true,
  publicReplies: true,
  escalations: true,
  aiHandoff: true,
};

export const NOTIFICATION_CATEGORY_BY_TYPE: Readonly<Record<NotificationType, NotificationCategory>> = {
  'ticket.created': 'ticketUpdates',
  'ticket.status_changed': 'ticketUpdates',
  'ticket.priority_changed': 'ticketUpdates',
  'ticket.assigned': 'ticketAssignment',
  'ticket.reassigned': 'ticketAssignment',
  'conversation.public_message': 'publicReplies',
  'escalation.created': 'escalations',
  'escalation.assigned': 'escalations',
  'escalation.reassigned': 'escalations',
  'escalation.accepted': 'escalations',
  'escalation.resolved': 'escalations',
  'escalation.cancelled': 'escalations',
  'ai.handoff': 'aiHandoff',
  'ai.failure': 'aiHandoff',
};

/** Notification types that ignore preferences (empty today; see module note). */
export const MANDATORY_NOTIFICATION_TYPES: readonly NotificationType[] = [];

export function categoryOf(type: NotificationType): NotificationCategory {
  return NOTIFICATION_CATEGORY_BY_TYPE[type];
}

export function isMandatoryNotificationType(type: NotificationType): boolean {
  return MANDATORY_NOTIFICATION_TYPES.includes(type);
}

/** Resolves a stored document (or its absence) into complete values. */
export function resolvePreferenceValues(
  document: Partial<NotificationPreferenceValues> | null,
): NotificationPreferenceValues {
  if (document === null) return DEFAULT_NOTIFICATION_PREFERENCES;
  return {
    inAppEnabled: document.inAppEnabled ?? DEFAULT_NOTIFICATION_PREFERENCES.inAppEnabled,
    emailEnabled: document.emailEnabled ?? DEFAULT_NOTIFICATION_PREFERENCES.emailEnabled,
    ticketAssignment:
      document.ticketAssignment ?? DEFAULT_NOTIFICATION_PREFERENCES.ticketAssignment,
    ticketUpdates: document.ticketUpdates ?? DEFAULT_NOTIFICATION_PREFERENCES.ticketUpdates,
    publicReplies: document.publicReplies ?? DEFAULT_NOTIFICATION_PREFERENCES.publicReplies,
    escalations: document.escalations ?? DEFAULT_NOTIFICATION_PREFERENCES.escalations,
    aiHandoff: document.aiHandoff ?? DEFAULT_NOTIFICATION_PREFERENCES.aiHandoff,
  };
}

/** Channel/category decision for one notification type. */
export interface NotificationChannelDecision {
  readonly inApp: boolean;
  readonly email: boolean;
}

export function decideChannels(
  type: NotificationType,
  preferences: NotificationPreferenceValues,
): NotificationChannelDecision {
  if (isMandatoryNotificationType(type)) {
    return { inApp: true, email: true };
  }
  const categoryEnabled = preferences[categoryOf(type)];
  return {
    inApp: preferences.inAppEnabled && categoryEnabled,
    email: preferences.emailEnabled && categoryEnabled,
  };
}
