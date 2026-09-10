import { AppError } from '../../lib/AppError.ts';
import { generateSlug, isReservedSlug } from '../../lib/slug.ts';
import * as repository from './links.repository.ts';
import type { CreateLinkInput, Link } from './links.schema.ts';

/**
 * Business rules for links.
 *
 * Services throw {@link AppError}, never HTTP objects, and never touch the
 * request or response. That is what lets these functions be called from a test,
 * a script, or a future background job without a server involved.
 */

/**
 * How many times to retry a generated slug that collides.
 *
 * At 62^7 possibilities and a million stored links, one collision has a
 * probability near 2.8e-7, so five in a row is about 1.8e-33. Reaching the
 * limit means something is broken, not that the service is unlucky.
 */
const MAX_SLUG_ATTEMPTS = 5;

/**
 * Creates a link.
 *
 * A caller-supplied slug is checked against the reserved list first, which is a
 * pure check needing no database round trip. Whether it is already taken is
 * never checked in advance: checking and then inserting is a race, because
 * another request can claim the slug in between. The unique index decides, and
 * the violation it raises is translated here.
 *
 * @param input - Already-validated request input.
 * @param ownerId - Who is creating it, or `undefined` for an anonymous caller.
 *   Anonymous creation is deliberately still allowed: it is the product's
 *   simplest useful behaviour, and the trade the creator accepts is that an
 *   ownerless link cannot later be listed or deleted through the API.
 * @returns The stored link.
 * @throws {AppError} 400 when the slug is reserved, 409 when it is taken, 503
 *   when five generated slugs collide in a row.
 */
export async function createLink(input: CreateLinkInput, ownerId?: string): Promise<Link> {
  if (input.customSlug !== undefined) {
    // A reserved slug is 400, not 409. It conflicts with no stored row and is
    // knowable without touching the database, which makes it a validation
    // failure rather than a conflict.
    if (isReservedSlug(input.customSlug)) {
      throw new AppError('SLUG_RESERVED', 'That slug is reserved.', 400, {
        details: [{ field: 'customSlug', message: 'That slug is reserved.' }],
      });
    }

    try {
      return await repository.insert({
        slug: input.customSlug,
        url: input.url,
        expiresAt: input.expiresAt,
        ownerId,
      });
    } catch (error) {
      if (repository.isSlugConflict(error)) {
        throw new AppError('SLUG_TAKEN', 'That slug is already in use.', 409);
      }
      throw error;
    }
  }

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    try {
      return await repository.insert({
        slug: generateSlug(),
        url: input.url,
        expiresAt: input.expiresAt,
        ownerId,
      });
    } catch (error) {
      if (!repository.isSlugConflict(error)) throw error;
    }
  }

  // 503 rather than 500, with Retry-After, because the condition is in
  // principle temporary. Reaching it at this scale means something is wrong
  // with slug generation, which the log will show.
  throw new AppError('SLUG_EXHAUSTED', 'Could not allocate a slug.', 503, {
    headers: { 'Retry-After': '1' },
  });
}

/**
 * Resolves a slug for redirection.
 *
 * Expiry is asked of the database rather than compared here, so a single clock
 * governs the answer. The row is fetched even when expired, because a caller
 * must be able to answer 410 rather than 404: those mean different things to
 * whoever followed the link.
 *
 * @param slug - The slug from the path.
 * @returns The link to redirect to.
 * @throws {AppError} 404 when no such slug exists, 410 when it has expired.
 */
export async function resolveSlug(slug: string): Promise<Link> {
  const link = await repository.findBySlug(slug);

  if (link === undefined) {
    throw AppError.notFound('LINK_NOT_FOUND', 'No such link.');
  }

  if (await repository.isExpired(slug)) {
    throw new AppError('LINK_EXPIRED', 'That link has expired.', 410);
  }

  return link;
}

/**
 * Reads a link's metadata.
 *
 * An expired link is returned normally, with its past expiry visible. This
 * endpoint describes a link; it does not follow one.
 *
 * @param slug - The slug to read.
 * @returns The link.
 * @throws {AppError} 404 when no such slug exists.
 */
export async function getLink(slug: string): Promise<Link> {
  const link = await repository.findBySlug(slug);
  if (link === undefined) {
    throw AppError.notFound('LINK_NOT_FOUND', 'No such link.');
  }
  return link;
}

/**
 * Reads a link's metadata, for its owner only.
 *
 * The metadata route was open to anyone holding a slug. The destination it
 * returns is public anyway, since following the link discloses it, but the
 * expiry, the creation time and the confirmation that a slug is live were
 * readable by anyone who guessed or harvested one.
 *
 * A link owned by someone else is refused with 403 rather than 404, which
 * matches deletion. Answering 404 would hide the link's existence, and its
 * existence is already public: the redirect route confirms it to anyone.
 * Answering two different ways to the same question would be the inconsistency,
 * not the disclosure.
 *
 * @param slug - The slug to read.
 * @param userId - The account asking.
 * @returns The link.
 * @throws {AppError} 404 when no such slug exists, 403 when it belongs to
 *   someone else.
 */
export async function getOwnedLink(slug: string, userId: string): Promise<Link> {
  const link = await getLink(slug);
  if (link.ownerId !== userId) {
    throw new AppError('FORBIDDEN', 'That link belongs to someone else.', 403);
  }
  return link;
}

/**
 * Lists one user's links, newest first.
 *
 * Always scoped to an owner. There is no way to ask this function for every
 * link, and no repository query that would answer such a request.
 *
 * @param options.ownerId - Whose links to list.
 * @param options.limit - Page size.
 * @param options.cursorId - Id to page from, or absent for the first page.
 * @returns The page, and the cursor for the next one.
 */
export async function listLinks(options: {
  readonly ownerId: string;
  readonly limit: number;
  readonly cursorId?: string | undefined;
}): Promise<{ readonly links: readonly Link[]; readonly nextCursorId: string | null }> {
  // One extra row, purely to learn whether another page exists. Asking with a
  // separate count query would be a second round trip and could disagree with
  // this one if a row were inserted between them.
  const rows = await repository.listByOwner({
    ownerId: options.ownerId,
    limit: options.limit + 1,
    cursorId: options.cursorId,
  });

  const hasMore = rows.length > options.limit;
  const links = hasMore ? rows.slice(0, options.limit) : rows;
  const last = links.at(-1);

  return {
    links,
    nextCursorId: hasMore && last !== undefined ? last.id : null,
  };
}

/**
 * Deletes a link the caller owns.
 *
 * The row is read before it is deleted, which costs one extra query and buys
 * the difference between 404 and 403. Deleting with an owner filter in the
 * `where` clause would be one query, but every failure would look like "no such
 * link", and the caller could not tell a typo from someone else's link.
 *
 * An ownerless link cannot be deleted by anybody. Nobody can prove they created
 * it, so there is no correct person to allow.
 *
 * @param slug - The slug to delete.
 * @param userId - The authenticated caller.
 * @throws {AppError} 404 when no such slug exists, 403 when it belongs to
 *   someone else or to nobody.
 */
export async function deleteLink(slug: string, userId: string): Promise<void> {
  const link = await repository.findBySlug(slug);

  if (link === undefined) {
    throw AppError.notFound('LINK_NOT_FOUND', 'No such link.');
  }

  if (link.ownerId !== userId) {
    throw new AppError('FORBIDDEN', 'That link belongs to someone else.', 403);
  }

  await repository.remove(slug);
}
