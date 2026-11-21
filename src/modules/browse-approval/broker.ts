import http from 'node:http';
import type { BrowseGrant } from './service.js';

/** Host-only control socket. It is never mounted into agent containers. */
export class BrowseControlClient {
  constructor(
    private socketPath = process.env.NANOCLAW_BROWSE_CONTROL_SOCKET ?? '/srv/opencode-browse/control/broker.sock',
  ) {}
  private request(method: string, path: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { socketPath: this.socketPath, method, path, headers: { 'Content-Type': 'application/json' }, timeout: 5000 },
        (response) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            data += chunk;
            if (data.length > 16384) response.destroy(new Error('Browse control response exceeded its size limit.'));
          });
          response.on('error', reject);
          response.on('end', () => {
            if ((response.statusCode ?? 500) >= 400)
              return reject(new Error(`Browse control returned HTTP ${response.statusCode}.`));
            try {
              resolve(data ? JSON.parse(data) : undefined);
            } catch {
              reject(new Error('Browse control returned invalid JSON.'));
            }
          });
        },
      );
      request.on('error', reject);
      request.on('timeout', () => request.destroy(new Error('Browse approval service timed out.')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async grant(request: { sessionId: string; requestId: string; browser: string }): Promise<BrowseGrant> {
    return (await this.request('POST', '/sessions', request)) as BrowseGrant;
  }
  async revoke(sessionId: string): Promise<void> {
    await this.request('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
  }
  async reset(): Promise<void> {
    await this.request('POST', '/reset');
  }
}
