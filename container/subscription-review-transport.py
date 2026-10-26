#!/usr/bin/env python3
"""Adapt the skill's documented alternate transport to its stock CLI runner."""
import importlib.util
import json
import os
from pathlib import Path
import sys

STOCK = '/app/skills/the-usual/scripts/fresheyes/reviewer-transport.py'

def main():
    spec = importlib.util.spec_from_file_location('usual_stock_transport', STOCK)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    packet_path, repo, diff, output = module.parse_review(sys.argv[1:])
    p = Path(packet_path)
    if p.stat().st_size > 8*1024*1024:
        raise ValueError('review packet exceeds 8 MiB')
    data = module.require_exact_packet(json.loads(p.read_text()))
    if data['version'] != 1 or data['transport'] != 'alternate':
        raise ValueError('invalid alternate review packet')
    provider = module.resolve_provider(data['executor_family'], None)
    seconds = data['timeout_seconds']
    if isinstance(seconds, bool) or not isinstance(seconds, int) or not 1 <= seconds <= 3600:
        raise ValueError('review timeout must be between 1 and 3600 seconds')
    if not isinstance(data['prompt'], str) or not data['prompt']:
        raise ValueError('review prompt is empty')
    repo = module.checked_repository(repo)
    diff = module.checked_trusted_diff(diff, data['trusted_diff_path'])
    output = module.checked_raw_output(output)
    packet = module.ReviewPacket(data['executor_family'], None, provider, data['prompt'], seconds,
                                diff, os.environ.get('USUAL_FRESHEYES_CLAUDE_MODEL') or 'claude-opus-5-5',
                                os.environ.get('USUAL_FRESHEYES_GPT_MODEL'))
    if provider == 'claude':
        os.environ['PATH'] = '/usr/local/libexec/nanoclaw-subscription:' + os.environ.get('PATH', '')
        module.exec_claude(packet, repo, diff, output)
    else:
        module.exec_codex(packet, repo, output, packet_path)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Subscription review transport failed: ' + str(error), file=sys.stderr)
        sys.exit(2)
