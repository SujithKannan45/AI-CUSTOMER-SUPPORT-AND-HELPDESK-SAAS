import { type Types, type FilterQuery } from 'mongoose';

import { UserModel } from './user.model.js';
import type { UserDocument } from './user.types.js';

/**
 * Read-only user directory for OTHER modules that legitimately need an
 * identity (the notification email dispatcher needs a recipient address).
 *
 * Why this exists: users are GLOBAL identities (not tenant-scoped), so a
 * tenant-filtered repository cannot answer "who is this staff member?".
 * Keeping the query here — rather than in the notification module — preserves
 * one-model-one-module ownership: nothing outside `modules/users` touches the
 * `users` collection directly.
 *
 * Returned fields are deliberately minimal (id, name, email, status): password
 * hashes and token versions are `select: false` in the schema AND are never
 * requested here.
 */

export interface UserContact {
  readonly userId: Types.ObjectId;
  /** Display name for email salutations. */
  readonly name: string;
  /** Normalized address (schema lowercases/trims). */
  readonly email: string;
}

function toContact(document: UserDocument): UserContact {
  return { userId: document._id, name: document.name, email: document.email };
}

/** ONE active user's contact details; suspended/invited identities are excluded. */
export async function findActiveUserContact(userId: Types.ObjectId): Promise<UserContact | null> {
  const filter: FilterQuery<UserDocument> = { _id: userId, status: 'active' };
  const document = await UserModel.findOne(filter).select('name email status');
  return document === null ? null : toContact(document);
}

/** Bulk variant — one query for a whole recipient fan-out. */
export async function findActiveUserContacts(
  userIds: readonly Types.ObjectId[],
): Promise<UserContact[]> {
  if (userIds.length === 0) return [];
  const filter: FilterQuery<UserDocument> = { _id: { $in: [...userIds] }, status: 'active' };
  const documents = await UserModel.find(filter).select('name email status');
  return documents.map(toContact);
}
