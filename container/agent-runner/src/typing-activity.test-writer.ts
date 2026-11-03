import { Database } from 'bun:sqlite';
import { writeTypingActivityToDb } from './db/session-state.js';

const db = new Database(process.argv[2]);
if (process.argv[5]) Date.now = () => Number(process.argv[5]);
try {
  writeTypingActivityToDb(db, process.argv[3], JSON.parse(process.argv[4]));
} finally {
  db.close();
}
