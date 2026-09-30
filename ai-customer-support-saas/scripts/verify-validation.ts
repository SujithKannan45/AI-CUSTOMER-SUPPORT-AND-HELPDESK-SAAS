/**
 * Request-validation verification driver.
 *
 * Boots the real Express app, mounts a probe route using the production
 * `validate()` middleware with a strict Zod schema, and asserts both paths:
 * invalid input -> 422 VALIDATION_ERROR with field details and requestId;
 * valid input -> 200 success envelope.
 *
 * Uses node:http against a loopback listener — no test framework needed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from '../server/src/app.js';
import { validate } from '../server/src/core/middlewares/validate.middleware.js';
import { z } from 'zod';

const probeSchema = z.object({
  name: z.string().min(3),
  priority: z.enum(['low', 'medium', 'high']),
});

function main(): void {
  // Registered through the app's extension point so the probe sits before
  // the not-found catch-all, inside the full production pipeline.
  const app = createApp((routeApp) => {
    routeApp.get('/health/validation-probe', validate(probeSchema, 'query'), (_req, res) => {
      res.status(200).json({ success: true, data: { received: true } });
    });
  });

  const server = app.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    void runChecks(port).then(() => server.close());
  });
}

async function request(
  port: number,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as Record<string, unknown> });
      });
    }).on('error', reject);
  });
}

async function runChecks(port: number): Promise<void> {
  const invalid = await request(port, '/health/validation-probe?name=ab&priority=urgent');
  const missing = await request(port, '/health/validation-probe');
  const valid = await request(port, '/health/validation-probe?name=ticket&priority=high');

  const invalidError = invalid.body.error as { code: string; details: Record<string, string[]> } | undefined;
  const checks = [
    { name: 'invalid input rejected', pass: invalid.status === 422 },
    {
      name: 'error contract + field details',
      pass:
        invalidError !== undefined &&
        invalidError.code === 'VALIDATION_ERROR' &&
        invalidError.details.name !== undefined &&
        typeof invalid.body.requestId === 'string',
    },
    { name: 'missing params rejected', pass: missing.status === 422 },
    { name: 'valid input passes', pass: valid.status === 200 && valid.body.success === true },
  ];

  let allPass = true;
  for (const check of checks) {
    // eslint-disable-next-line no-console
    console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}`);
    if (!check.pass) allPass = false;
  }
  process.exit(allPass ? 0 : 1);
}

main();
