import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration015: Migration = {
  version: 15,
  name: 'scheduler-supersession-response-address',
  up(db: Database.Database) {
    addColumnIfMissing(db, 'response_channel_type', 'TEXT');
    addColumnIfMissing(db, 'response_platform_id', 'TEXT');
    addColumnIfMissing(db, 'response_thread_id', 'TEXT');
  },
};

function addColumnIfMissing(db: Database.Database, column: string, type: string): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('scheduler_session_supersessions')").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  if (columns.has(column)) return;
  db.prepare(`ALTER TABLE scheduler_session_supersessions ADD COLUMN ${column} ${type}`).run();
}
