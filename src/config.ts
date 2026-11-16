// Settings come from the environment, so one hook command works the same in
// every agent and nothing needs a config file. All optional.
//
//   SETHER_PHONE_REGIONS   national phone formats to recognise (default US,GB,NG,CA)
//   SETHER_NETWORK=0       stop flagging public IP addresses
//   SETHER_IDENTITY=1      also flag label-anchored names, DOBs, passports, addresses
//   SETHER_HIGH_ENTROPY=1  also flag random-looking strings with no known prefix
//   SETHER_IGNORE          comma-separated exact values never to flag
//   SETHER_HOOK_FAIL_OPEN=1  let prompts through when the check itself fails
//   SETHER_HOOK_STATE_DIR  where the resend hash lives (default: a per-user temp dir)

import { DEFAULT_CONFIG, type EngineConfig } from './engine/engine.js';

type Env = Readonly<Record<string, string | undefined>>;

const on = (v: string | undefined): boolean => v === '1' || v?.toLowerCase() === 'true';
const off = (v: string | undefined): boolean => v === '0' || v?.toLowerCase() === 'false';
const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function configFromEnv(env: Env): EngineConfig {
  const regions = list(env.SETHER_PHONE_REGIONS);
  return {
    network: !off(env.SETHER_NETWORK),
    identity: on(env.SETHER_IDENTITY),
    highEntropy: on(env.SETHER_HIGH_ENTROPY),
    phoneRegions: regions.length > 0 ? regions : DEFAULT_CONFIG.phoneRegions,
    ignoreValues: list(env.SETHER_IGNORE),
  };
}

export function failOpenFromEnv(env: Env): boolean {
  return on(env.SETHER_HOOK_FAIL_OPEN);
}
