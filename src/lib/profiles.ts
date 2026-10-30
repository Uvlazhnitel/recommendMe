import type Database from 'better-sqlite3';

export const PROFILES = [{ id: 'ilya', name: 'Илья' }, { id: 'valeriy', name: 'Валерий' }] as const;
export type UserId = typeof PROFILES[number]['id'];
export class ProfileError extends Error {
  constructor(public readonly code: 'profile_required' | 'invalid_profile' | 'profile_changed' | 'schema_upgrade_required' | 'profile_mismatch', public readonly status = 400) { super(code); }
}
export function userId(value: unknown): UserId {
  if (value !== 'ilya' && value !== 'valeriy') throw new ProfileError('invalid_profile');
  return value;
}
export function requireProfileSchema(db: Database.Database) {
  if (![8, 9, 10].includes(db.pragma('user_version', { simple: true }) as number)) throw new ProfileError('schema_upgrade_required', 503);
  return 8;
}
export function personalScope(db: Database.Database, value: unknown): asserts value is UserId { userId(value); requireProfileSchema(db); }
export function assertReportOwner(value: unknown, owner: UserId) {
  userId(owner);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProfileError('profile_mismatch', 409);
  const declared = (value as { user_id?: unknown }).user_id;
  // Ownerless pre-profile reports are historical Ilya artifacts, never a caller default.
  if ((declared === undefined ? 'ilya' : userId(declared)) !== owner) throw new ProfileError('profile_mismatch', 409);
}
