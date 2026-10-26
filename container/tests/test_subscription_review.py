import importlib.util
import json
from pathlib import Path
import os
import socket
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('subscription_review', ROOT/'claude-subscription-review.py')
review = importlib.util.module_from_spec(spec); spec.loader.exec_module(review)

class SubscriptionReviewTests(unittest.TestCase):
    def reply(self, response):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        path = tmp.name+'/broker.sock'
        server=socket.socket(socket.AF_UNIX);server.bind(path);server.listen(1)
        received=[]
        def run():
            try:
                conn,_=server.accept()
                with conn:
                    received.append(json.loads(conn.recv(4096)))
                    conn.sendall(json.dumps(response).encode()+b'\n')
            finally: server.close()
        thread=threading.Thread(target=run);thread.start();self.addCleanup(thread.join,2)
        return path, received
    def good(self):
        return dict(ok=True,accessToken='test-oauth',extraUsageEnabled=False,subscriptionType='max',expiresAt=time.time()*1000+7200000)
    def test_scoped_credential_request_and_response(self):
        p,requests=self.reply(self.good()); d=review.credential(p,'group-1')
        self.assertEqual(d['accessToken'],'test-oauth')
        self.assertEqual(requests,[{'op':'get-claude-review-credential','target':'group-1'}])
    def test_rejects_paid_or_unknown_policy(self):
        for flag in [True,None]:
            p,_=self.reply({**self.good(),'extraUsageEnabled':flag})
            with self.assertRaisesRegex(RuntimeError,'verified subscription'):review.credential(p,'group-1')
    def test_rejects_refresh_tokens_api_keys_expiry_and_missing_subscription(self):
        for field,value in [('refreshToken','refresh'),('apiKey','api'),('expiresAt',1),('subscriptionType',None),('accessToken','')]:
            p,_=self.reply({**self.good(),field:value})
            with self.assertRaises(RuntimeError):review.credential(p,'group-1')
    def test_actionable_missing_login(self):
        p,_=self.reply(dict(ok=False,error='operator re-login required'))
        with self.assertRaisesRegex(RuntimeError,'operator re-login'):review.credential(p,'group-1')
    def test_requires_group(self):
        with mock.patch.dict(os.environ,{},clear=True):
            with self.assertRaisesRegex(RuntimeError,'registered Codex'):review.credential('/nonexistent')
    def test_cleans_all_billing_overrides_and_injecting_proxies(self):
        source={'PATH':'/usr/bin','ANTHROPIC_API_KEY':'paid','ANTHROPIC_AUTH_TOKEN':'paid',
                'ANTHROPIC_BASE_URL':'https://other','CLAUDE_CODE_USE_BEDROCK':'1',
                'CLAUDE_CODE_OAUTH_TOKEN':'old','CLAUDE_CONFIG_DIR':'old','HTTPS_PROXY':'inject',
                'http_proxy':'inject','ALL_PROXY':'inject','NODE_USE_ENV_PROXY':'1',
                'YENTE_ONECLI_GATEWAY_PROXY_URL':'inject','OPENAI_API_KEY':'paid','NODE_OPTIONS':'--inject',
                'BASH_ENV':'inject','ENV':'inject'}
        env=review.environment('test-oauth','/private-profile',source)
        self.assertEqual(env['CLAUDE_CODE_OAUTH_TOKEN'],'test-oauth')
        self.assertEqual(env['CLAUDE_CONFIG_DIR'],'/private-profile')
        self.assertFalse(any(k.startswith('ANTHROPIC_') for k in env))
        for k in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','YENTE_ONECLI_GATEWAY_PROXY_URL','OPENAI_API_KEY','NODE_OPTIONS','BASH_ENV','ENV']:
            self.assertNotIn(k,env)
    def test_no_cli_spawn_when_auth_is_blocked(self):
        with mock.patch.object(review,'credential',side_effect=RuntimeError('quota exhausted')),mock.patch.object(review.subprocess,'Popen') as spawn:
            self.assertEqual(review.main(),2);spawn.assert_not_called()
    def test_forces_subscription_settings_and_temporary_profile(self):
        child=mock.Mock();child.wait.return_value=0
        with mock.patch.object(review,'credential',return_value=self.good()),mock.patch.object(review.subprocess,'Popen',return_value=child) as spawn,mock.patch.object(review.signal,'signal'),mock.patch.object(review.sys,'argv',['review','-p','--model','claude-opus-5-5','--no-session-persistence','--safe-mode','--tools','Read,Glob,Grep','--','read-only test']):
            self.assertEqual(review.main(),0)
            args=spawn.call_args.args[0];settings=json.loads(args[args.index('--settings')+1]);self.assertEqual(settings,{'forceLoginMethod':'claudeai','fastMode':False})
            profile=spawn.call_args.kwargs['env']['CLAUDE_CONFIG_DIR'];self.assertFalse(os.path.exists(profile))
            self.assertIn('--no-session-persistence',args);self.assertIn('claude-opus-5-5',args)

if __name__=='__main__': unittest.main()
