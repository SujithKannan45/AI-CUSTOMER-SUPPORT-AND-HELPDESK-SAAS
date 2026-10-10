import { z } from 'zod';

import { EMAIL_PATTERN } from '../../database/schema-validators.js';

/**
 * Password policy — pragmatic, not extreme.
 *
 * NIST SP 800-63B guidance: length matters more than composition rules, and
 * blocking the most common offenders beats demanding `!@#$` symbols. We
 * require 8+ characters (12+ recommended, not enforced) with at least one
 * letter and one digit, and block a short list of the most common passwords.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password12',
  'password123',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty123',
  'qwertyuiop',
  'iloveyou1',
  'admin1234',
  'letmein12',
  'welcome1',
  'abc12345',
]);

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
  .regex(/[0-9]/, 'Password must contain at least one digit')
  .refine((value) => !COMMON_PASSWORDS.has(value.toLowerCase()), {
    message: 'This password is too common',
  });

export const nameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(100, 'Name must be at most 100 characters');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(EMAIL_PATTERN, 'A valid email address is required');

export const registerSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, 'Password is required').max(128),
  })
  .strict();

export const verifyEmailSchema = z
  .object({
    email: emailSchema,
    token: z.string().length(64, 'Verification token must be 64 hex characters'),
  })
  .strict();

export const forgotPasswordSchema = z
  .object({
    email: emailSchema,
  })
  .strict();

export const resendVerificationSchema = z
  .object({
    email: emailSchema,
  })
  .strict();

export const resetPasswordSchema = z
  .object({
    email: emailSchema,
    token: z.string().length(64, 'Reset token must be 64 hex characters'),
    password: passwordSchema,
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
