/**
 * D2: a copy of `env` without ANTHROPIC_API_KEY, for every `claude` child the daemon spawns.
 * A key exported for the daemon (calibration) would otherwise make the child bill the API
 * instead of the user's subscription. The daemon's own use of the key is unaffected.
 */
export function withoutAnthropicApiKey<T extends Record<string, string | undefined>>(env: T): T {
  const { ANTHROPIC_API_KEY: _dropped, ...rest } = env;
  return rest as T;
}
