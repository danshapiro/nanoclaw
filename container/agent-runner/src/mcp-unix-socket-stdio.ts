import net from 'node:net';
import path from 'node:path';

const SOCKET_ROOT = '/workspace/mcp/';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const socketPath = process.argv[2];
if (!socketPath || process.argv.length !== 3) {
  fail('Usage: mcp-unix-socket-stdio <absolute-socket-path>');
}
if (!path.posix.isAbsolute(socketPath)) {
  fail('MCP Unix socket path must be absolute');
}

const normalized = path.posix.normalize(socketPath);
if (normalized !== socketPath || !socketPath.startsWith(SOCKET_ROOT)) {
  fail(`MCP Unix socket path must stay under ${SOCKET_ROOT}`);
}

const socket = net.createConnection(socketPath);
socket.on('connect', () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on('error', (err) => {
  console.error(`MCP Unix socket connection failed: ${err.message}`);
  process.exit(1);
});
socket.on('close', (hadError) => {
  process.exit(hadError ? 1 : 0);
});
