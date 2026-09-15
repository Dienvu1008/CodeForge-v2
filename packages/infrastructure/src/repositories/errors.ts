// Repository errors — DOMAIN_CONTRACTS §23.
// Distinct from DbError (driver-level): these are domain-repository semantics.

export type RepoErrorCode =
  | 'NOT_FOUND' // entity does not exist
  | 'VERSION_CONFLICT' // optimistic-lock mismatch on update (mutable aggregates)
  | 'ALREADY_EXISTS' // create() on an existing primary key
  | 'IMMUTABLE_VIOLATION' // attempt to mutate an immutable/finalized entity
  | 'INVALID_STATE'; // operation not allowed in the current state

export class RepoError extends Error {
  public readonly code: RepoErrorCode;
  public readonly entity: string;
  public readonly id?: string;

  constructor(code: RepoErrorCode, entity: string, id?: string, message?: string) {
    super(message ?? `${code}: ${entity}${id ? ` (${id})` : ''}`);
    this.name = 'RepoError';
    this.code = code;
    this.entity = entity;
    if (id !== undefined) {
      this.id = id;
    }
  }
}
