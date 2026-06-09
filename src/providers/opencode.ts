import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';
import { requireYenteHostEnv, YENTE_LOCAL_PROXY_HOSTNAMES } from '../yente/service-env.js';

const OPENCODE_ONECLI_PLACEHOLDER = 'onecli-managed';

/**
 * The OPENCODE_* liveness/timeout knobs (Task 3 Step 5). Forwarded only when the
 * operator sets them in host .env; unset keys are omitted so the in-container
 * default applies (passing `undefined`/empty would override it). Defined in
 * container/agent-runner/src/providers/opencode.ts. This is the SINGLE source of
 * truth for the liveness keys — `OPENCODE_HOST_ENV_KEYS` is derived from it so
 * adding a knob in one place cannot drift from the other.
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

const OPENCODE_BASE_HOST_ENV_KEYS = [
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'ONECLI_GATEWAY_URL',
  'GWS_PROXY_URL',
  'MSGVAULT_PROXY_URL',
  'FAMILIAR_PROXY_URL',
  'NYNE_PROXY_URL',
  'YENTE_BROWSER_HANDOFF_URL',
  'NO_PROXY',
  'no_proxy',
  'OPENCODE_PROVIDER',
  'OPENCODE_MODEL',
  'OPENCODE_SMALL_MODEL',
  'OPENCODE_VISION_MODEL',
  'OPENCODE_REASONING_EFFORT',
] as const;

// Derived: base connection/model keys + every forwarded liveness knob. Keeping
// the liveness keys in one list means a new knob is read AND forwarded without
// editing two lists.
const OPENCODE_HOST_ENV_KEYS = [...OPENCODE_BASE_HOST_ENV_KEYS, ...OPENCODE_FORWARDED_LIVENESS_KEYS] as const;

function providerIdFromModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf('/');
  if (slash <= 0) return undefined;
  return model.slice(0, slash);
}

function modelForProvider(model: string | undefined, provider: string): string | undefined {
  return providerIdFromModel(model) === provider ? model : undefined;
}

registerProviderContainerConfig('opencode', ({ hostEnv, sessionDir, groupModel, groupReasoningEffort }) => {
  const mergedHostEnv = { ...readEnvFile([...OPENCODE_HOST_ENV_KEYS]), ...hostEnv };
  const yente = requireYenteHostEnv(mergedHostEnv);
  const opencodeXdgDir = path.join(sessionDir, 'opencode-xdg');

  const resolvedModel = groupModel ?? mergedHostEnv.OPENCODE_MODEL ?? 'opencode-go/deepseek-v4-pro';
  const resolvedProvider = providerIdFromModel(resolvedModel) ?? mergedHostEnv.OPENCODE_PROVIDER ?? 'opencode-go';
  const resolvedSmallModel = modelForProvider(
    mergedHostEnv.OPENCODE_SMALL_MODEL ?? 'opencode-go/deepseek-v4-flash',
    resolvedProvider,
  );
  const resolvedVisionModel = modelForProvider(
    mergedHostEnv.OPENCODE_VISION_MODEL ?? 'opencode-go/qwen3.6-plus',
    resolvedProvider,
  );
  const resolvedReasoningEffort = groupReasoningEffort ?? mergedHostEnv.OPENCODE_REASONING_EFFORT;
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
      OPENCODE_PROVIDER: resolvedProvider,
      OPENCODE_MODEL: resolvedModel,
      ...(resolvedSmallModel ? { OPENCODE_SMALL_MODEL: resolvedSmallModel } : {}),
      ...(resolvedVisionModel ? { OPENCODE_VISION_MODEL: resolvedVisionModel } : {}),
      OPENCODE_API_KEY: OPENCODE_ONECLI_PLACEHOLDER,
      ...(resolvedProvider === 'openai' ? { OPENAI_API_KEY: OPENCODE_ONECLI_PLACEHOLDER } : {}),
      ...(resolvedReasoningEffort ? { OPENCODE_REASONING_EFFORT: resolvedReasoningEffort } : {}),
      ...forwardedLiveness,
    },
    extraHosts: YENTE_LOCAL_PROXY_HOSTNAMES,
  };
});
