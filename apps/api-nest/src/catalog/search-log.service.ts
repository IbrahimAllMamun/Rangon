import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { pySlice, pySplit } from '../common/python';
import { Database } from '../database/database.service';

const MAX_TERM_LENGTH = 120;

/** `catalog.search.normalise_term`: trimmed, lower-cased, single-spaced, capped. */
export function normaliseTerm(query: string): string {
  return pySlice(pySplit((query ?? '').toLowerCase()).join(' '), MAX_TERM_LENGTH);
}

/** What shoppers type and whether it found anything (`catalog.search`). */
@Injectable()
export class SearchLogService {
  private readonly logger = new Logger('rangon.catalog');

  constructor(private readonly db: Database) {}

  /** `log_search`: fire-and-forget; never fails a shopper's search. */
  async logSearch(query: string, resultCount: number): Promise<void> {
    const term = normaliseTerm(query);
    if (!term) return;
    try {
      const updated = await this.db.pool.query(
        `UPDATE catalog_searchterm
            SET hits = hits + 1, last_result_count = $2, last_searched_at = now()
          WHERE term = $1`,
        [term, resultCount],
      );
      if (!updated.rowCount) {
        await this.db.pool.query(
          `INSERT INTO catalog_searchterm
                  (id, created_at, updated_at, term, hits, last_result_count, last_searched_at)
           VALUES ($1::uuid, now(), now(), $2, 1, $3, now())`,
          [randomUUID(), term, resultCount],
        );
      }
    } catch {
      this.logger.warn(`Could not log the search term ${JSON.stringify(term)}`);
    }
  }

  /** `popular_terms`: searched *and* found something, most searched first. */
  async popularTerms(limit = 5): Promise<string[]> {
    const rows = await this.db.query<{ term: string }>(
      `SELECT term FROM catalog_searchterm WHERE hits > 0 AND last_result_count > 0
        ORDER BY hits DESC, term ASC LIMIT $1`,
      [limit],
    );
    return rows.map((row) => row.term);
  }
}
