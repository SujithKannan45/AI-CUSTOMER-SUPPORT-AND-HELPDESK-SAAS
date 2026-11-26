import type {
  CreateCustomerInput,
  CustomerDto,
  CustomerStatus,
  UpdateCustomerInput,
} from './types';

/**
 * Customer create/edit form model.
 *
 * The server schemas are authoritative; this module mirrors their documented
 * bounds so obvious mistakes are caught before a request and maps the values
 * onto the exact create/patch payloads. Anything the backend rejects still
 * arrives as a 422 and is mapped back onto these fields by the dialog.
 *
 * Text inputs are strings (the DOM's model); `toUpdateInput` converts them to
 * the API's nullable shape: an emptied optional field is sent as `null`, which
 * the repository treats as an explicit clear.
 */

export const CUSTOMER_NAME_MAX = 120;
export const CUSTOMER_EMAIL_MAX = 254;
export const CUSTOMER_PHONE_MAX = 20;
export const CUSTOMER_AVATAR_URL_MAX = 2048;
export const MAX_CUSTOMER_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_PATTERN = /^https?:\/\/\S+$/i;

export interface CustomerFormValues {
  name: string;
  email: string;
  phone: string;
  avatarUrl: string;
  status: CustomerStatus;
  /** Comma-separated in the input; parsed by `parseTags`. */
  tags: string;
}

export type CustomerFormErrors = Partial<Record<keyof CustomerFormValues, string>>;

export const EMPTY_CUSTOMER_FORM: CustomerFormValues = {
  name: '',
  email: '',
  phone: '',
  avatarUrl: '',
  status: 'active',
  tags: '',
};

export function customerToFormValues(customer: CustomerDto): CustomerFormValues {
  return {
    name: customer.name,
    email: customer.email ?? '',
    phone: customer.phone ?? '',
    avatarUrl: customer.avatarUrl ?? '',
    status: customer.status,
    tags: customer.tags.join(', '),
  };
}

/** Trimmed, de-duplicated, still bounded so the UI can count them. */
export function parseTags(raw: string): string[] {
  return [...new Set(raw.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
}

export function validateCustomerForm(values: CustomerFormValues): CustomerFormErrors {
  const errors: CustomerFormErrors = {};

  const name = values.name.trim();
  if (name.length === 0) errors.name = 'Customer name is required.';
  else if (name.length > CUSTOMER_NAME_MAX) {
    errors.name = `Use at most ${CUSTOMER_NAME_MAX} characters.`;
  }

  const email = values.email.trim();
  if (email.length > 0) {
    if (email.length > CUSTOMER_EMAIL_MAX) {
      errors.email = `Use at most ${CUSTOMER_EMAIL_MAX} characters.`;
    } else if (!EMAIL_PATTERN.test(email)) {
      errors.email = 'Enter a valid email address.';
    }
  }

  const phone = values.phone.trim();
  if (phone.length > CUSTOMER_PHONE_MAX) {
    errors.phone = `Use at most ${CUSTOMER_PHONE_MAX} characters.`;
  }

  const avatarUrl = values.avatarUrl.trim();
  if (avatarUrl.length > 0) {
    if (avatarUrl.length > CUSTOMER_AVATAR_URL_MAX) {
      errors.avatarUrl = `Use at most ${CUSTOMER_AVATAR_URL_MAX} characters.`;
    } else if (!URL_PATTERN.test(avatarUrl)) {
      errors.avatarUrl = 'Enter an absolute http(s) URL.';
    }
  }

  const tags = parseTags(values.tags);
  if (tags.length > MAX_CUSTOMER_TAGS) {
    errors.tags = `Use at most ${MAX_CUSTOMER_TAGS} tags.`;
  } else if (tags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
    errors.tags = `Each tag must be ${MAX_TAG_LENGTH} characters or fewer.`;
  }

  return errors;
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Normalizes an optional field for PATCH: blank means "clear" (`null`). */
function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toCreateInput(values: CustomerFormValues): CreateCustomerInput {
  const email = optionalText(values.email)?.toLowerCase();
  const phone = optionalText(values.phone);
  const avatarUrl = optionalText(values.avatarUrl);
  const tags = parseTags(values.tags);

  return {
    name: values.name.trim(),
    status: values.status,
    ...(email !== undefined ? { email } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/**
 * Sends only the fields that actually changed. Returns an empty object when
 * nothing differs, so the caller can skip a pointless PATCH.
 */
export function toUpdateInput(
  original: CustomerDto,
  values: CustomerFormValues,
): UpdateCustomerInput {
  const input: UpdateCustomerInput = {};
  const mutable = input as {
    name?: string;
    email?: string | null;
    phone?: string | null;
    avatarUrl?: string | null;
    status?: CustomerStatus;
    tags?: readonly string[];
  };

  const name = values.name.trim();
  if (name !== original.name) mutable.name = name;

  const email = nullableText(values.email)?.toLowerCase() ?? null;
  if (email !== original.email) mutable.email = email;

  const phone = nullableText(values.phone);
  if (phone !== original.phone) mutable.phone = phone;

  const avatarUrl = nullableText(values.avatarUrl);
  if (avatarUrl !== original.avatarUrl) mutable.avatarUrl = avatarUrl;

  if (values.status !== original.status) mutable.status = values.status;

  const tags = parseTags(values.tags);
  if (JSON.stringify(tags) !== JSON.stringify([...original.tags])) mutable.tags = tags;

  return input;
}

export function hasChanges(input: UpdateCustomerInput): boolean {
  return Object.keys(input).length > 0;
}
