import { emailLocalPart, isValidEmail, MIN_PASSWORD_LENGTH, normalizeEmail } from '@coc/shared'
import { EmailTakenError, isValidDisplayName, type AuthStore } from './store.ts'

/**
 * First-boot admin, **and** the lockout escape hatch for a database that predates
 * email being the credential.
 *
 * There is no signup form — a public one on a ten-person tool is a liability — so
 * the only ways an account comes into being are this and an admin inviting people.
 *
 * Two jobs, separate on purpose:
 *
 * 1. `users` empty → create the first admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
 *    Only when empty, which is what makes it idempotent: a restart with the vars
 *    still set finds a user and does nothing, so it can never reset a password
 *    that has since been changed.
 * 2. `users` non-empty but the oldest admin has **no email** → fill it in from
 *    `ADMIN_EMAIL`, *without touching the password*. This is the case the
 *    username→email migration creates: an account whose legacy username had no
 *    `@` in it has nothing to sign in with, and without this its owner is locked
 *    out of their own app. Also idempotent — once the email is set, the query
 *    that looks for a candidate returns nothing.
 *
 * With nobody able to sign in and nothing configured, it deliberately leaves the
 * app unusable and says exactly what to set, rather than falling back to a known
 * default: a guessable admin on the public internet is worse than an app nobody
 * can log into.
 */

export type BootstrapStatus =
  | 'created'
  | 'existing'
  | 'emailBackfilled'
  | 'noUsableEmail'
  | 'unconfigured'
  | 'invalid'

export interface BootstrapResult {
  status: BootstrapStatus
  message: string
}

/** `ADMIN_DISPLAY_NAME`, or the local part of the address as a sane default. */
function displayNameFor(env: Record<string, string | undefined>, email: string): string {
  const configured = env.ADMIN_DISPLAY_NAME?.trim() ?? ''
  return isValidDisplayName(configured) ? configured : emailLocalPart(email)
}

export function bootstrapAdmin(
  store: AuthStore,
  env: Record<string, string | undefined>,
): BootstrapResult {
  const rawEmail = env.ADMIN_EMAIL?.trim() ?? ''
  const email = normalizeEmail(rawEmail)
  const password = env.ADMIN_PASSWORD ?? ''

  /* ---------- a database that already has accounts ---------- */

  if (store.countUsers() > 0) {
    const stranded = store.findOldestAdminWithoutEmail()

    if (stranded && email) {
      if (!isValidEmail(email)) {
        return {
          status: 'invalid',
          message: `ADMIN_EMAIL "${rawEmail}" is not a usable email address (one @, no spaces). Admin "${stranded.displayName}" still has no email and cannot sign in.`,
        }
      }

      try {
        store.setEmail(stranded.id, email)
      } catch (cause) {
        if (cause instanceof EmailTakenError) {
          return {
            status: 'invalid',
            message: `ADMIN_EMAIL "${email}" already belongs to another account, so admin "${stranded.displayName}" was left without one. Use a different address.`,
          }
        }
        throw cause
      }

      return {
        status: 'emailBackfilled',
        message: `Existing admin "${stranded.displayName}" had no email; set it to "${email}" from ADMIN_EMAIL. The password is untouched — sign in with that address and the password you already had.`,
      }
    }

    if (store.countUsersWithEmail() === 0) {
      return {
        status: 'noUsableEmail',
        message:
          `${store.countUsers()} account(s) exist but not one has an email address, so nobody can ` +
          'sign in — email is the login credential. ' +
          (stranded
            ? `Set ADMIN_EMAIL to the address admin "${stranded.displayName}" should use and restart once. `
            : 'Set ADMIN_EMAIL and restart once — though note no *admin* is missing an email, so no account can be adopted automatically. ') +
          'No password is changed by this, so the account keeps the one it already had. ' +
          'Refusing to invent a credential.',
      }
    }

    return { status: 'existing', message: 'Users already exist; skipping admin bootstrap.' }
  }

  /* ---------- a fresh database ---------- */

  if (!email || !password) {
    return {
      status: 'unconfigured',
      message:
        'No users exist and ADMIN_EMAIL / ADMIN_PASSWORD are not set, so nobody can sign in. ' +
        'Set both, restart once to create the first admin, then remove ADMIN_PASSWORD from the ' +
        'environment. Refusing to invent a default password.',
    }
  }

  if (!isValidEmail(email)) {
    return {
      status: 'invalid',
      message: `ADMIN_EMAIL "${rawEmail}" is not a usable email address (one @, no spaces). No admin created.`,
    }
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      status: 'invalid',
      message: `ADMIN_PASSWORD is shorter than the ${MIN_PASSWORD_LENGTH}-character minimum. No admin created.`,
    }
  }

  const admin = store.createUser({
    email,
    displayName: displayNameFor(env, email),
    password,
    role: 'admin',
  })
  return {
    status: 'created',
    message: `Created first admin "${admin.displayName}" <${admin.email ?? ''}>. Remove ADMIN_PASSWORD from the environment now — it is not needed again.`,
  }
}
