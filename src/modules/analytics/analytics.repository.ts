import { pool } from '../../db/pool.ts';
import type { NewClickEvent } from './analytics.schema.ts';

/** SQL for click events, and nothing else. */

/**
 * Writes one click event.
 *
 * Nothing is returned. The caller does not wait for this and has nowhere to put
 * an id, and selecting one back would cost a round trip that no reader needs.
 *
 * The row is written exactly as given. Truncation and hashing happen in the
 * service, so that a value which would violate a check constraint never reaches
 * the database: this insert is fire-and-forget, and a rejected row is a click
 * that disappears with no response to attach the failure to.
 *
 * @param event - An already-normalised event.
 */
export async function insertClick(event: NewClickEvent): Promise<void> {
  await pool().query(
    `insert into click_events (link_id, referrer, user_agent, ip_hash, is_bot)
     values ($1, $2, $3, $4, $5)`,
    [event.linkId, event.referrer, event.userAgent, event.ipHash, event.isBot],
  );
}
