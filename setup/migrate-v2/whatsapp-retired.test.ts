import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('retired WhatsApp migration', () => {
  it('refuses to copy WhatsApp auth state or credentials into a new install', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-retired-wa-'));
    const source = path.join(temp, 'source');
    const destination = path.join(temp, 'destination');
    fs.mkdirSync(path.join(source, 'data/sessions/baileys'), { recursive: true });
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(source, '.env'), 'WHATSAPP_PHONE=example\n');
    fs.writeFileSync(path.join(source, 'data/sessions/baileys/creds.json'), '{"test":true}');
    const tsx = path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
    const script = path.join(process.cwd(), 'setup/migrate-v2/channel-auth.ts');
    try {
      const result = spawnSync(process.execPath, [tsx, script, source, 'whatsapp'], {
        cwd: destination,
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('not supported');
      expect(fs.existsSync(path.join(destination, '.env'))).toBe(false);
      expect(fs.existsSync(path.join(destination, 'data/sessions/baileys'))).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
