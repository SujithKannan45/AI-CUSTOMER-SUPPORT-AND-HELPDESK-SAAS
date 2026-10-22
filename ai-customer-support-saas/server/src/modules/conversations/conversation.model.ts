import { Schema, model, type Model } from 'mongoose';

import {
  type ConversationDocument,
  type MessageDocument,
  type MessageAttachmentRef,
} from './conversation.types.js';

/**
 * Conversation persistence — the primary Laws enforced at the collection
 * level:
 *
 * - `{ workspaceId, ticketId }` UNIQUE — a ticket has exactly ONE PRIMARY
 *   conversation. Concurrent get-or-create races lose safely against this
 *   index and re-read the winner (see conversation.repository.ts); no
 *   "second lifecycle" or thread-splitting exists in this design.
 * - `{ workspaceId, customerId, updatedAt: -1 }` — the customer's
 *   conversation list (no joins; `customerId` is the copy captured from the
 *   ticket at creation).
 * - `{ workspaceId, lastMessageAt: -1 }` — workspace inbox / recent-activity
 *   views (real-time fan-out will read this shape in Prompt 10).
 */
const conversationSchema = new Schema<ConversationDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: [true, 'Workspace reference is required'],
    },
    ticketId: {
      type: Schema.Types.ObjectId,
      ref: 'Ticket',
      required: [true, 'Ticket reference is required'],
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'Customer',
      required: [true, 'Customer reference is required'],
    },
    subject: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },
    lastMessageAt: {
      type: Date,
      default: null,
    },
    lastMessageById: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true },
);

conversationSchema.index(
  { workspaceId: 1, ticketId: 1 },
  { unique: true, name: 'uniq_conversation_per_ticket' },
);
conversationSchema.index(
  { workspaceId: 1, customerId: 1, updatedAt: -1 },
  { name: 'idx_conversations_by_customer' },
);
conversationSchema.index(
  { workspaceId: 1, lastMessageAt: -1 },
  { name: 'idx_conversations_recent' },
);

export const ConversationModel = model<ConversationDocument, Model<ConversationDocument>>(
  'Conversation',
  conversationSchema,
  'conversations',
);

// ── Message model ────────────────────────────────────────────────────────────

const attachmentRefSchema = new Schema<MessageAttachmentRef>(
  {
    fileKey: { type: String, required: true, trim: true },
    filename: { type: String, required: true, trim: true },
    sizeBytes: { type: Number, required: false },
    mimeType: { type: String, required: false, trim: true },
  },
  { _id: false },
);

/**
 * Message indexes:
 * - `{ workspaceId, conversationId, createdAt }` — the chronological thread
 *   read (pagination sorts `{ createdAt: 1, _id: 1 }` for a stable order).
 * - `{ workspaceId, ticketId, createdAt: -1 }` — "everything sent about this
 *   ticket" (ticket-scoped search/exports), cheap because `ticketId` is
 *   denormalized server-side.
 */
const messageSchema = new Schema<MessageDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: [true, 'Workspace reference is required'],
    },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: [true, 'Conversation reference is required'],
    },
    /** Denormalized from the conversation by the service — efficient scope. */
    ticketId: {
      type: Schema.Types.ObjectId,
      ref: 'Ticket',
      required: [true, 'Ticket reference is required'],
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Sender reference is required'],
    },
    senderType: {
      type: String,
      required: true,
      enum: ['AGENT', 'CUSTOMER'],
    },
    body: {
      type: String,
      required: [true, 'Message body is required'],
      trim: true,
      minlength: 1,
      maxlength: 10_000,
    },
    visibility: {
      type: String,
      required: true,
      enum: ['PUBLIC', 'INTERNAL'],
    },
    /** Prompt 12 references only; untouched until the file module lands. */
    attachments: {
      type: [attachmentRefSchema],
      default: [],
    },
  },
  { timestamps: true },
);

messageSchema.index(
  { workspaceId: 1, conversationId: 1, createdAt: 1 },
  { name: 'idx_messages_chronological' },
);
messageSchema.index(
  { workspaceId: 1, ticketId: 1, createdAt: -1 },
  { name: 'idx_messages_by_ticket' },
);

export const MessageModel = model<MessageDocument, Model<MessageDocument>>(
  'Message',
  messageSchema,
  'messages',
);


