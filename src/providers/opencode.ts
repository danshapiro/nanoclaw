import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';
import { requireYenteHostEnv, YENTE_LOCAL_PROXY_HOSTNAMES } from '../yente/service-env.js';

const OPENCODE_ONECLI_PLACEHOLDER = 'onecli-managed';

const OPENCODE_HOST_ENV_KEYS = [
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'ONECLI_GATEWAY_URL',
  'GWS_PROXY_URL',
  'MSGVAULT_PROXY_URL',
  'FAMILIAR_PROXY_URL',
  'NYNE_PROXY_URL',
  'NO_PROXY',
  'no_proxy',
  'OPENCODE_PROVIDER',
  'OPENCODE_MODEL',
  'OPENCODE_SMALL_MODEL',
  'OPENCODE_VISION_MODEL',
  // Liveness/timeout knobs (Task 3 Step 5). Forwarded only when the operator
  // sets them in host .env; unset keys are omitted so the in-container default
  // applies. Defined in container/agent-runner/src/providers/opencode.ts.
  'OPENCODE_INACTIVITY_NOTICE_MS',
  'OPENCODE_INACTIVITY_NOTICE_REPEAT_MS',
  'OPENCODE_TRANSPORT_TIMEOUT_MS',
  'OPENCODE_WAIT_TICK_MS',
  'OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS',
  'OPENCODE_NATIVE_QUESTION_CANCEL_GRACE_MS',
  'OPENCODE_LONG_TOOL_TIMEOUT_MAX_MS',
  'OPENCODE_RELAY_DEADLINE_MS',
  'OPENCODE_CONTINUATION_FAILURE_LIMIT',
  'OPENCODE_MODEL_PROVIDER_TIMEOUT_MS',
] as const;

/**
 * The OPENCODE_* liveness knobs forwarded only when present (omit-if-unset), so
 * an unset key falls back to the in-container default rather than overriding it
 * with `undefined`/empty.
 */
const OPENCODE_FORWARDED_LIVENESS_KEYS = [
  'OPENCODE_INACTIVITY_NOTICE_MS',
  'OPENCODE_INACTIVITY_NOTICE_REPEAT_MS',
  'OPENCODE_TRANSPORT_TIMEOUT_MS',
  'OPENCODE_WAIT_TICK_MS',
  'OPENCODE_ABSOLUTE_TURN_TIMEOUT_MS',
  'OPENCODE_NATIVE_QUESTION_CANCEL_GRACE_MS',
  'OPENCODE_LONG_TOOL_TIMEOUT_MAX_MS',
  'OPENCODE_RELAY_DEADLINE_MS',
  'OPENCODE_CONTINUATION_FAILURE_LIMIT',
  'OPENCODE_MODEL_PROVIDER_TIMEOUT_MS',
] as const;

registerProviderContainerConfig('opencode', ({ hostEnv, sessionDir, groupModel }) => {
  const mergedHostEnv = { ...readEnvFile([...OPENCODE_HOST_ENV_KEYS]), ...hostEnv };
  const yente = requireYenteHostEnv(mergedHostEnv);
  const opencodeXdgDir = path.join(sessionDir, 'opencode-xdg');

  const resolvedModel = groupModel ?? mergedHostEnv.OPENCODE_MODEL ?? 'opencode-go/deepseek-v4-pro';
  fs.mkdirSync(opencodeXdgDir, { recursive: true });

  // Forward present liveness-knob overrides; omit unset keys so the in-container
  // default applies (passing `undefined`/empty would override the default).
  const forwardedLiveness: Record<string, string> = {};
  for (const key of OPENCODE_FORWARDED_LIVENESS_KEYS) {
    const v = mergedHostEnv[key];
    if (v !== undefined && v !== '') forwardedLiveness[key] = v;
  }

  return {
    mounts: [
      {
        hostPath: opencodeXdgDir,
        containerPath: '/opencode-xdg',
        readonly: false,
      },
    ],
    env: {
      ...yente.containerEnv,
      XDG_DATA_HOME: '/opencode-xdg',
      OPENCODE_PROVIDER: mergedHostEnv.OPENCODE_PROVIDER ?? 'opencode-go',
      OPENCODE_MODEL: resolvedModel,
      OPENCODE_SMALL_MODEL: mergedHostEnv.OPENCODE_SMALL_MODEL ?? 'opencode-go/deepseek-v4-flash',
      OPENCODE_VISION_MODEL: mergedHostEnv.OPENCODE_VISION_MODEL ?? 'opencode-go/qwen3.6-plus',
      OPENCODE_API_KEY: OPENCODE_ONECLI_PLACEHOLDER,
      ...forwardedLiveness,
    },
    extraHosts: YENTE_LOCAL_PROXY_HOSTNAMES,
  };
});
