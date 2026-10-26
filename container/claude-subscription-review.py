#!/usr/bin/env python3
"""Fresh Eyes Claude CLI: host-brokered subscription auth, never API billing."""
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time

BROKER_SOCKET = '/run/nanoclaw-review/broker.sock'
CLI = '/usr/local/bin/claude'

def credential(sock_path=BROKER_SOCKET, target=None):
    target = target or os.environ.get('NANOCLAW_AGENT_GROUP_ID')
    if not target:
        raise RuntimeError('Claude reviewer requires a registered Codex group')
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(45)
        s.connect(sock_path)
        s.sendall((json.dumps({'op': 'get-claude-review-credential', 'target': target}) + '\n').encode())
        data = bytearray()
        while b'\n' not in data:
            chunk = s.recv(8192)
            if not chunk:
                raise RuntimeError('Claude credential broker closed without a response')
            data.extend(chunk)
            if len(data) > 65536:
                raise RuntimeError('Claude credential response exceeded its bound')
    d = json.loads(data.split(b'\n', 1)[0])
    if not isinstance(d, dict):
        raise RuntimeError('Invalid Claude credential broker response')
    if not d.get('ok'):
        raise RuntimeError(str(d.get('error', 'Claude subscription authentication unavailable')))
    if (d.get('extraUsageEnabled') is not False or
        d.get('subscriptionType') not in {'pro', 'max', 'team', 'enterprise'} or
        not isinstance(d.get('accessToken'), str) or not d['accessToken'] or
        not isinstance(d.get('expiresAt'), (int, float)) or d['expiresAt'] < time.time()*1000+60000 or
        d.get('refreshToken') or d.get('apiKey')):
        raise RuntimeError('Claude broker did not return a verified subscription-only credential')
    return d

def environment(token, profile, source=None):
    source = os.environ if source is None else source
    # Existing OneCLI routes can inject a PAYG key, even without an env key.
    # Only this review child goes direct; normal service egress is unchanged.
    removed = {'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy',
               'YENTE_ONECLI_GATEWAY_PROXY_URL','NODE_USE_ENV_PROXY','OPENAI_API_KEY',
               'BASH_ENV','ENV','NODE_OPTIONS'}
    env = {k:v for k,v in source.items() if k not in removed and not k.startswith(('ANTHROPIC_', 'CLAUDE_'))}
    env.update(CLAUDE_CODE_OAUTH_TOKEN=token, CLAUDE_CONFIG_DIR=profile,
               CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_AUTOUPDATER='1')
    return env

def main():
    try:
        d = credential()
        with tempfile.TemporaryDirectory(prefix='nanoclaw-claude-review-') as profile:
            args = [CLI, '--setting-sources', '', '--settings', json.dumps({'forceLoginMethod':'claudeai', 'fastMode':False})] + sys.argv[1:]
            child = subprocess.Popen(args, env=environment(d['accessToken'], profile))
            for sig in (signal.SIGTERM, signal.SIGINT):
                signal.signal(sig, lambda signum, frame: child.send_signal(signum) if child.poll() is None else None)
            status = child.wait()
            return status if status >= 0 else 128-status
    except (OSError, ValueError, RuntimeError) as error:
        print('Claude subscription review blocked: ' + str(error), file=sys.stderr)
        return 2

if __name__ == '__main__':
    sys.exit(main())
