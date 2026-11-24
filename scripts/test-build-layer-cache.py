#!/usr/bin/env python3
"""Real BuildKit regression fixture; never connects to a shared Docker socket.

ARG/RUN ordering is read from the actual runtime Dockerfile, replacing expensive
installs with a static executable. An isolated daemon keeps every cache/image,
container and volume under this task's .test-tmp; finally stops and removes it.
"""
import atexit
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = Path(os.environ.get('NANOCLAW_TEST_WORK_ROOT', RUNTIME))
DOCKERFILE = Path(os.environ.get('NANOCLAW_TEST_DOCKERFILE', RUNTIME / 'container/Dockerfile'))


class BuildLayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / '.test-tmp').mkdir(exist_ok=True)
        (ROOT / 'test-results').mkdir(exist_ok=True)
        cls.work = Path(tempfile.mkdtemp(prefix='build-cache-', dir=ROOT / '.test-tmp'))
        # Linux AF_UNIX paths are limited to 108 bytes; this T3 path is longer.
        cls.runtime = Path(tempfile.mkdtemp(prefix='nc-build-', dir=Path.home() / '.cache'))
        (ROOT / 'test-results/build-cache-external-scratch.json').write_text(json.dumps({'path': str(cls.runtime)}))
        cls.addClassCleanup(cls.cleanup)
        atexit.register(cls.cleanup)
        cls.log = (cls.work / 'daemon.log').open('w')
        cls.socket = cls.runtime / 'docker.sock'
        cls.daemon = subprocess.Popen([
            'sudo', '-n', 'dockerd', '--host', 'unix://' + str(cls.socket),
            '--data-root', str(cls.work / 'data'), '--exec-root', str(cls.runtime / 'run'),
            '--pidfile', str(cls.work / 'daemon.pid'), '--bridge=none',
            '--iptables=false', '--ip6tables=false', '--ip-masq=false',
            '--storage-driver=overlay2', '--config-file=/dev/null'],
            stdout=cls.log, stderr=subprocess.STDOUT, start_new_session=True)
        cls.env = {**os.environ, 'DOCKER_HOST': 'unix://' + str(cls.socket),
                   'DOCKER_CONFIG': str(cls.work / 'config')}
        for _ in range(200):
            if cls.daemon.poll() is not None:
                raise RuntimeError((cls.work / 'daemon.log').read_text()[-4000:])
            if cls.docker('info', check=False).returncode == 0:
                break
            time.sleep(.1)
        else:
            raise RuntimeError('Task Docker daemon did not start')
        if cls.docker('info', '--format={{.DockerRootDir}}').stdout.strip() != str(cls.work / 'data'):
            raise RuntimeError('Docker fixture is not using its task-owned data root')
        cls.docker('context', 'create', 'fixture', '--docker', 'host=unix://' + str(cls.socket))
        cls.context = cls.work / 'context'
        cls.context.mkdir()
        source = cls.work / 'fixture.c'
        source.write_text('#include <fcntl.h>\n#include <unistd.h>\nint main(int n,char**v){'
                          'if(n>2){sleep(30);return 0;}int f=open(v[1],O_WRONLY|O_CREAT,0644);'
                          'if(f<0)return 1;int ok=write(f,"fixture",7)==7;close(f);return ok?0:1;}\n')
        subprocess.run(['cc', '-static', '-Os', str(source), '-o', str(cls.context / 'fixture')], check=True)
        (cls.context / 'dependencies').write_text('initial')

    @classmethod
    def cleanup(cls):
        if hasattr(cls, 'daemon') and cls.daemon.poll() is None:
            subprocess.run(['sudo', '-n', 'kill', '-TERM', '--', '-' + str(cls.daemon.pid)], check=False)
            try:
                cls.daemon.wait(timeout=30)
            except subprocess.TimeoutExpired:
                subprocess.run(['sudo', '-n', 'kill', '-KILL', '--', '-' + str(cls.daemon.pid)], check=False)
                cls.daemon.wait(timeout=10)
        if hasattr(cls, 'log'):
            cls.log.close()
        if hasattr(cls, 'work') and cls.work.exists():
            out = ROOT / 'test-results/build-cache-daemon.log'
            out.write_bytes((cls.work / 'daemon.log').read_bytes()[-12000:])
            subprocess.run(['sudo', '-n', 'rm', '-rf', '--', str(cls.work)], check=True)
            subprocess.run(['sudo', '-n', 'rm', '-rf', '--', str(cls.runtime)], check=True)

    @classmethod
    def docker(cls, *args, check=True, **kwargs):
        result = subprocess.run(['docker', *args], env=cls.env, text=True,
                                capture_output=True, timeout=120, **kwargs)
        if check and result.returncode:
            raise RuntimeError(result.stderr[-6000:])
        return result

    def build(self, name, args=()):
        result = self.docker('--context=fixture', 'buildx', 'build', '--progress=rawjson',
                             '--network=none', '--provenance=false', '--load', '-t', name, *args, str(self.context))
        vertices = {}
        for line in result.stderr.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            for vertex in event.get('vertexes', [event]):
                if vertex.get('name', '').startswith('[') and 'RUN ' in vertex.get('name', ''):
                    vertices[vertex['name']] = vertex
        (ROOT / 'test-results' / (name + '.json')).write_text(json.dumps(vertices, indent=2) + '\n')
        return dict(sorted(vertices.items(), key=lambda item: int(re.search(r'/step-(\d+)', item[0])[1])))

    def test_cli_bump_reuses_earlier_layers_and_dependencies_still_invalidate(self):
        source = re.sub(r'\\\n', ' ', DOCKERFILE.read_text())
        lines = ['FROM scratch', 'COPY fixture /fixture']
        runs = []
        for line in source.splitlines():
            if line == 'FROM node:22-slim':
                continue
            if line.startswith('ARG '):
                lines.append(line)
            elif line.startswith('COPY agent-runner/package.json'):
                lines.append('COPY dependencies /dependencies')
            elif line.startswith('RUN '):
                index = len(runs)
                runs.append(line)
                lines.append(f'RUN ["/fixture", "/step-{index}"]')
        (self.context / 'Dockerfile').write_text('\n'.join(lines) + '\n')
        first = self.build('fixture-base')
        self.assertEqual(len(first), len(runs))
        same = self.build('fixture-same')
        self.assertTrue(all(v.get('cached') for v in same.values()))
        for pin in ['CODEX', 'OPENCODE', 'CLAUDE_CODE', 'AGENT_BROWSER', 'VERCEL', 'BUN']:
            changed = self.build('fixture-' + pin.lower(), ['--build-arg', pin + '_VERSION=fixture-next'])
            install = next(i for i, run in enumerate(runs) if '${' + pin + '_VERSION}' in run)
            for index, vertex in enumerate(changed.values()):
                self.assertEqual(bool(vertex.get('cached')), index < install, (pin, index, install, vertex))
            self.build('fixture-reset')
        (self.context / 'dependencies').write_text('changed')
        changed = self.build('fixture-dependencies')
        dependency_run = next(i for i, run in enumerate(runs) if 'bun install' in run)
        for index, vertex in enumerate(changed.values()):
            self.assertEqual(bool(vertex.get('cached')), index < dependency_run)


if __name__ == '__main__':
    def interrupted(_signum, _frame):
        raise SystemExit(130)
    signal.signal(signal.SIGTERM, interrupted)
    unittest.main()
