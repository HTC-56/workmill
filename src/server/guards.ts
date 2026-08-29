import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Engine } from '../db/engine.js';
import { isOperator, parseBearer, resolveApiToken, type TokenIdentity } from './auth.js';

/**
 * The two request guards, in one place because two route files now share them.
 *
 * They lived in `src/server/app.ts` while the ops surface was the only caller.
 * The tenant API (SPEC.md feature 6) and the operator console (feature 7) reach
 * for the same two, and a guard that exists twice is a guard that will one day
 * disagree with itself about what "unauthorized" means.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireTenant` once a bearer has resolved. */
    identity?: TokenIdentity;
  }
}

/**
 * Resolve the tenant bearer, or answer 401 and return null.
 *
 * A missing bearer, a made-up bearer, a revoked one and an expired one all get
 * the same reply. Distinguishing them would turn the 401 into an oracle for
 * which tokens once existed.
 */
export async function requireTenant(
  engine: Engine,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<TokenIdentity | null> {
  const raw = parseBearer(request.headers.authorization);
  const identity = raw === null ? null : await resolveApiToken(engine, raw);
  if (!identity) {
    reply.header('WWW-Authenticate', 'Bearer');
    await reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  request.identity = identity;
  return identity;
}

/** Guard an operator route. Returns false once it has answered 401 or 503. */
export async function requireOperator(
  operatorToken: string | null,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (!operatorToken) {
    await reply.code(503).send({ error: 'operator-api-disabled' });
    return false;
  }
  if (!isOperator(request.headers.authorization, operatorToken)) {
    reply.header('WWW-Authenticate', 'Bearer');
    await reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}
