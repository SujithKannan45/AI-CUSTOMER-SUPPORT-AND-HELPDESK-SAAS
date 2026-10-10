import { Router } from 'express';

import { sensitiveRouteLimiter } from '../../core/middlewares/index.js';
import { validate } from '../../core/middlewares/validate.middleware.js';

import {
  forgotPasswordController,
  loginController,
  logoutAllController,
  logoutController,
  meController,
  refreshController,
  registerController,
  resendVerificationController,
  resetPasswordController,
  verifyEmailController,
} from './auth.controller.js';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './auth.validation.js';
import { requireAuth } from './require-auth.middleware.js';



/**
 * Auth routes — mounted at `/api/v1/auth` (see routes/api.routes.ts).
 *
 * `sensitiveRouteLimiter` (15 min window / 20 attempts) guards every
 * credential-handling endpoint; /me and /logout-all are covered by the global
 * limiter and require authentication instead.
 */
export const authRouter = Router();

authRouter.post('/register', sensitiveRouteLimiter, validate(registerSchema), registerController);
authRouter.post('/verify-email', sensitiveRouteLimiter, validate(verifyEmailSchema), verifyEmailController);
authRouter.post('/resend-verification', sensitiveRouteLimiter, validate(resendVerificationSchema), resendVerificationController);
authRouter.post('/login', sensitiveRouteLimiter, validate(loginSchema), loginController);
authRouter.post('/refresh', sensitiveRouteLimiter, refreshController);
authRouter.post('/logout', logoutController);
authRouter.post('/logout-all', requireAuth, logoutAllController);
authRouter.get('/me', requireAuth, meController);
authRouter.post('/forgot-password', sensitiveRouteLimiter, validate(forgotPasswordSchema), forgotPasswordController);
authRouter.post('/reset-password', sensitiveRouteLimiter, validate(resetPasswordSchema), resetPasswordController);
