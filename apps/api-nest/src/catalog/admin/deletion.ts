import { Conflict } from '../../common/errors';
import type { Queryable } from '../../database/database.service';

/**
 * Django's `Collector` meeting an `on_delete=PROTECT` reference: it raises
 * `ProtectedError`, an `IntegrityError`, which `core.handlers` answers with
 * the generic 409 -- nothing deleted, nothing said about why.
 */
export class ProtectedError extends Conflict {
  constructor() {
    super('The request conflicts with the current state of the data.');
  }
}

/** Refuse the delete when any of `queries` (each taking the row's id as `$1`) finds a row. */
export async function refuseIfReferenced(
  q: Queryable,
  queries: readonly string[],
  id: string,
): Promise<void> {
  for (const query of queries) {
    if ((await q.query(query, [id])).length) throw new ProtectedError();
  }
}
