import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../../lib/password.ts';
import {
  fail,
  isRecord,
  issue,
  ok,
  type ParseResult,
  type ValidationIssue,
} from '../../lib/validate.ts';

/** A user, as the rest of the service sees one. Never carries the hash. */
export type User = {
  /** `bigint`, so a string. It is an identifier and nothing computes with it. */
  readonly id: string;
  readonly email: string;
  readonly createdAt: Date;
};

/** A user together with the stored hash. Used only inside the service. */
export type UserWithHash = User & { readonly passwordHash: string };

/** A session row. */
export type Session = {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
};

/** Validated registration or sign-in input. */
export type CredentialsInput = {
  readonly email: string;
  readonly password: string;
};

/**
 * Longest email accepted, matching the column constraint.
 *
 * 254 is the practical maximum for an address in a message envelope.
 */
const MAX_EMAIL_LENGTH = 254;

/**
 * Email shape.
 *
 * Deliberately loose. A regular expression cannot decide whether an address is
 * real, and a strict one rejects valid addresses that people actually own. The
 * only structural facts worth enforcing are that there is one `@`, something on
 * each side of it, and a dot in the domain.
 */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Parses credentials for registration or sign-in.
 *
 * The email is lowercased and trimmed here rather than at the database, so that
 * `User@Example.com` and `user@example.com` are one account. The unique
 * constraint enforces it, but only because this function normalises first.
 *
 * @param body - The parsed request body, untrusted.
 * @returns Validated credentials, or every problem found.
 */
export function parseCredentials(body: unknown): ParseResult<CredentialsInput> {
  if (!isRecord(body)) {
    return fail([issue('body', 'Request body must be a JSON object.')]);
  }

  const issues: ValidationIssue[] = [];

  const rawEmail = body['email'];
  let email = '';

  if (typeof rawEmail !== 'string' || rawEmail.trim() === '') {
    issues.push(issue('email', 'An email address is required.'));
  } else {
    email = rawEmail.trim().toLowerCase();
    if (email.length > MAX_EMAIL_LENGTH) {
      issues.push(issue('email', `Must be ${MAX_EMAIL_LENGTH} characters or fewer.`));
    } else if (!EMAIL_PATTERN.test(email)) {
      issues.push(issue('email', 'Must be a valid email address.'));
    }
  }

  const rawPassword = body['password'];

  if (typeof rawPassword !== 'string') {
    issues.push(issue('password', 'A password is required.'));
  } else if (
    rawPassword.length < MIN_PASSWORD_LENGTH ||
    rawPassword.length > MAX_PASSWORD_LENGTH
  ) {
    // The maximum is not arbitrary. Hashing unbounded input is a CPU
    // amplification vector against a single-threaded service.
    issues.push(
      issue(
        'password',
        `Must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`,
      ),
    );
  }

  if (issues.length > 0) return fail(issues);

  return ok({ email, password: rawPassword as string });
}
