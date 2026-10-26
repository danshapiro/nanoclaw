#!/usr/bin/env bash
# Offline end-to-end transport proof. The model CLI is replaced by an argv/env
# assertion fixture, and Docker networking is disabled. Never invokes inference.
set -euo pipefail
image=${1:?usage: manual-subscription-review.sh IMAGE STOCK_SKILL_DIR}
skill=${2:?stock skill directory required}
test -x "$skill/scripts/fresheyes/run-review.sh" || { echo "stock skill is missing or incomplete: $skill" >&2; exit 2; }
fixture=$(mktemp -d /tmp/nanoclaw-review-smoke.XXXXXX)
trap 'rm -rf -- "$fixture"' EXIT
mkdir "$fixture/broker"
cat > "$fixture/fake-cli" <<'PY'
#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]
assert os.environ['CLAUDE_CODE_OAUTH_TOKEN']=='offline-subscription-fixture'
for key in ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','HTTPS_PROXY','HTTP_PROXY','YENTE_ONECLI_GATEWAY_PROXY_URL']:
    assert key not in os.environ,key
assert args[args.index('--model')+1]=='claude-opus-5-5'
assert args[args.index('--tools')+1]=='Read,Glob,Grep'
assert '--safe-mode' in args and '--no-session-persistence' in args
assert json.loads(args[args.index('--settings')+1])['forceLoginMethod']=='claudeai'
assert 'def add' in open('/fixture/repo/calc.py').read()
with open('/fixture/calls','a') as f:f.write('called\n')
print('## Files Examined\n- calc.py\n\n## Issues Found\n- None.\n\n## Summary\nOffline CLI fixture only; no model inference.\n\n---\n**INDEPENDENT CODE REVIEW PASSED**')
PY
chmod 755 "$fixture/fake-cli"
cat > "$fixture/proof.py" <<'PY'
import json,os,pathlib,socket,subprocess,threading,time
repo=pathlib.Path('/fixture/repo');repo.mkdir()
subprocess.run(['git','init','-q',str(repo)],check=True)
(repo/'calc.py').write_text('def add(a, b):\n    return a + b\n')
subprocess.run(['git','-C',str(repo),'add','calc.py'],check=True)
subprocess.run(['git','-C',str(repo),'-c','user.name=Offline Fixture','-c','user.email=fixture@example.invalid','commit','-qm','offline fixture'],check=True)
state={'policy':'allow','requests':[]}
server=socket.socket(socket.AF_UNIX);server.bind('/run/nanoclaw-review/broker.sock');server.listen(3)
def serve():
    for _ in range(3):
        conn,_=server.accept()
        with conn:
            request=json.loads(conn.recv(4096));state['requests'].append(request)
            assert request=={'op':'get-claude-review-credential','target':'fixture-group'}
            if state['policy']=='quota':r={'ok':False,'error':'included-plan quota exhausted'}
            else:r={'ok':True,'accessToken':'offline-subscription-fixture','expiresAt':time.time()*1000+7200000,'subscriptionType':'max','extraUsageEnabled':state['policy']=='paid'}
            conn.sendall(json.dumps(r).encode()+b'\n')
thread=threading.Thread(target=serve,daemon=True);thread.start()
command=['bash','/app/skills/the-usual/scripts/fresheyes/run-review.sh','--executor-family','gpt','--repo',str(repo),'--scope','Offline transport fixture only.','--log-dir','/fixture/logs']
for policy,expected in [('allow',0),('quota',2),('paid',2)]:
    state['policy']=policy
    r=subprocess.run(command,text=True,capture_output=True,timeout=35)
    if r.returncode!=expected:print(r.stdout,r.stderr);raise RuntimeError(f'{policy} returned {r.returncode}, expected {expected}')
    calls=pathlib.Path('/fixture/calls').read_text().splitlines()
    assert len(calls)==1,f'unexpected CLI calls for {policy}: {calls}'
    print('PASS',policy,'exit',r.returncode,'CLI calls',len(calls))
assert len(state['requests'])==3
thread.join(2);server.close()
print('OFFLINE TRANSPORT CHAIN PASSED; zero inference calls')
PY
docker_user="$(id -u):$(id -g)"
# Root in a rootless daemon maps to this host user; uid 1000 would instead
# map to an unrelated subordinate uid and lose access to the private fixture.
if docker info --format '{{json .SecurityOptions}}' | grep -q 'name=rootless'; then docker_user=0:0; fi
docker run --rm --network none --user "$docker_user" -e HOME=/home/node \
    -e NANOCLAW_AGENT_GROUP_ID=fixture-group -e USUAL_FRESHEYES_TIMEOUT_SECONDS=15 \
    -e ANTHROPIC_API_KEY=paid-must-be-removed -e ANTHROPIC_BASE_URL=https://wrong.invalid \
    -e HTTPS_PROXY=http://injector.invalid:9 -e YENTE_ONECLI_GATEWAY_PROXY_URL=http://injector.invalid:9 \
    -v "$fixture:/fixture" -v "$fixture/broker:/run/nanoclaw-review" \
    -v "$fixture/fake-cli:/usr/local/bin/claude:ro" --mount "type=bind,source=$skill,target=/app/skills/the-usual,readonly" \
    --entrypoint python3 "$image" /fixture/proof.py
