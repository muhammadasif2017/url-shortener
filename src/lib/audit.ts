import { env } from '../config/env.ts';
import { hashIdentifier } from './ipHash.ts';
import { log } from './logger.ts';

/**
 * The audit log.
 *
 * Errors say that something broke. An audit trail says who did what, which is a
 * different question and the one asked after an account is compromised: when did
 * this session start, how many attempts preceded it, was anything deleted. None
 * of that was answerable before, because successful sign-ins wrote nothing at
 * all.
 *
 * These lines go to the same structured log as everything else, under a fixed
 * message, so they can be filtered out of the stream without a second sink to
 * operate.
 */

/** Security-relevant actions worth being able to reconstruct later. */
export type AuditEvent =
  | 'auth.register'
  /** A registration naming an address that already has an account. */
  | 'auth.register.duplicate'
  | 'auth.login.succeeded'
  | 'auth.login.failed'
  | 'auth.login.throttled'
  | 'auth.logout'
  | 'link.created'
  | 'link.deleted';

/** What an audit line may carry beyond the event name. */
export type AuditFields = {
  /** The acting account, where one is known. */
  readonly userId?: string;
  /** The affected link, for link events. */
  readonly slug?: string;
  /** The client address. Hashed before it is written; never logged raw. */
  readonly clientIp?: string;
};

/**
 * Records one audit event.
 *
 * The client address is hashed with the same salt the analytics tables use.
 * That keeps two properties at once: two events from one client are still
 * visibly the same client, which is what makes the trail useful, and the log
 * does not become the one place raw addresses are kept after the rest of the
 * service went to some trouble never to store them.
 *
 * @param event - What happened.
 * @param fields - Who it happened to, and from where.
 */
export function audit(event: AuditEvent, fields: AuditFields = {}): void {
  const { clientIp, ...rest } = fields;

  log('info', 'audit', {
    event,
    ...rest,
    ...(clientIp === undefined ? {} : { clientIpHash: hashIdentifier(clientIp, env().ipHashSalt) }),
  });
}
