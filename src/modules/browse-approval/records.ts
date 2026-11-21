import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowseRecord } from './service.js';
import type { Session } from '../../types.js';

interface Entry {
  agentGroupId: string;
  sessionId: string;
}
/** Small current-state index, containing identifiers only, for crash-safe invalidation. */
export class BrowseRecordStore {
  private indexPath: string;
  constructor(private dataDirectory: string) {
    this.indexPath = path.join(dataDirectory, 'browse-session-access.json');
  }
  private readIndex(): Entry[] {
    if (!fs.existsSync(this.indexPath)) return [];
    let entries: unknown;
    try {
      entries = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
    } catch (error) {
      throw new Error('Browse session access index is unreadable; cannot safely restore browser access.', {
        // eslint-disable-next-line preserve-caught-error -- Parser messages may contain a permit; redact payload while retaining the error category.
        cause: error instanceof SyntaxError ? new SyntaxError('Invalid Browse state JSON') : error,
      });
    }
    if (
      !Array.isArray(entries) ||
      entries.some((x) => !x || typeof x.agentGroupId !== 'string' || typeof x.sessionId !== 'string')
    )
      throw new Error('Browse session access index is malformed.');
    return entries;
  }
  private writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  file(agentGroupId: string, sessionId: string): string {
    return path.join(this.dataDirectory, 'v2-host-correlation', agentGroupId, sessionId, 'browse-session.json');
  }
  write(session: Session, record: BrowseRecord): void {
    const entries = this.readIndex().filter((x) => x.sessionId !== session.id);
    const retained = ['pending', 'approved', 'stopping', 'revocation_failed'].includes(record.status);
    if (retained) entries.push({ agentGroupId: session.agent_group_id, sessionId: session.id });
    // Register before publishing a permit; a crash cannot strand an unindexed token.
    if (retained) this.writeJson(this.indexPath, entries);
    this.writeJson(this.file(session.agent_group_id, session.id), record);
    if (!retained) this.writeJson(this.indexPath, entries);
  }
  invalidateAfterRestart(): number {
    const entries = this.readIndex();
    for (const entry of entries) {
      const file = this.file(entry.agentGroupId, entry.sessionId);
      if (!fs.existsSync(file)) continue;
      let record: BrowseRecord;
      try {
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        throw new Error('A retained Browse access record is malformed; browser access cannot resume.', {
          // eslint-disable-next-line preserve-caught-error -- Parser messages may contain a permit; redact payload while retaining the error category.
          cause: error instanceof SyntaxError ? new SyntaxError('Invalid Browse state JSON') : error,
        });
      }
      const { token: _token, ...safe } = record;
      this.writeJson(file, { ...safe, status: 'ended' });
    }
    this.writeJson(this.indexPath, []);
    return entries.length;
  }
}
