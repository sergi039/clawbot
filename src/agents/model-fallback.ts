import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import {
  ensureAuthProfileStore,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  coerceToFailoverError,
  describeFailoverError,
  isFailoverError,
  isTimeoutError,
} from "./failover-error.js";
import {
  buildConfiguredAllowlistKeys,
  buildModelAliasIndex,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";
import { isLikelyContextOverflowError } from "./pi-embedded-helpers.js";

type ModelCandidate = {
  provider: string;
  model: string;
};

type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
};

type ProviderOutageSnapshot = {
  unavailable: boolean;
  message: string;
  checkedAt: number;
  source: string;
};

type ProviderStatusCacheEntry = {
  expiresAt: number;
  snapshot: ProviderOutageSnapshot;
};

const ANTHROPIC_STATUS_ENDPOINT = "https://status.claude.com/api/v2/status.json";
const PROVIDER_STATUS_REQUEST_TIMEOUT_MS = 2_500;
const PROVIDER_STATUS_CACHE_TTL_MS = 60_000;
const PROVIDER_STATUS_MIN_CACHE_TTL_MS = 5_000;
const PROVIDER_STATUS_MAX_CACHE_TTL_MS = 10 * 60_000;
const OPENAI_STATUS_ENDPOINT = "https://status.openai.com/api/v2/status.json";
const STATUSPAGE_OUTAGE_INDICATORS = new Set(["major", "critical"]);
const OPENAI_STATUS_PROVIDERS = new Set(["openai", "openai-codex", "openai-completions"]);
const DISABLED_PROVIDER_STATUS_VALUES = new Set(["0", "false", "off", "no", "disabled"]);
const OPENAI_PROVIDER = "openai";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
const providerStatusCache = new Map<string, ProviderStatusCacheEntry>();

function isProviderStatusCheckEnabled(): boolean {
  const raw = String(process.env.OPENCLAW_PROVIDER_STATUS_CHECK ?? "")
    .trim()
    .toLowerCase();
  if (raw) {
    return !DISABLED_PROVIDER_STATUS_VALUES.has(raw);
  }
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return false;
  }
  return true;
}

function resolveProviderStatusCacheTtlMs(): number {
  const parsed = Number.parseInt(
    String(process.env.OPENCLAW_PROVIDER_STATUS_CACHE_TTL_MS ?? ""),
    10,
  );
  if (!Number.isFinite(parsed)) {
    return PROVIDER_STATUS_CACHE_TTL_MS;
  }
  return Math.min(
    PROVIDER_STATUS_MAX_CACHE_TTL_MS,
    Math.max(PROVIDER_STATUS_MIN_CACHE_TTL_MS, parsed),
  );
}

function formatAnthropicStatusMessage(indicator: string, description?: string): string {
  const detail = description?.trim();
  return detail
    ? `status.claude.com reports ${indicator}: ${detail}`
    : `status.claude.com reports ${indicator}`;
}

function formatOpenAiStatusMessage(indicator: string, description?: string): string {
  const detail = description?.trim();
  return detail
    ? `status.openai.com reports ${indicator}: ${detail}`
    : `status.openai.com reports ${indicator}`;
}

function parseStatuspagePayload(payload: unknown): {
  indicator: string;
  description?: string;
} | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const status = (payload as { status?: unknown }).status;
  if (!status || typeof status !== "object") {
    return null;
  }
  const indicatorRaw = (status as { indicator?: unknown }).indicator;
  if (typeof indicatorRaw !== "string") {
    return null;
  }
  const indicator = indicatorRaw.trim().toLowerCase();
  if (!indicator) {
    return null;
  }
  const descriptionRaw = (status as { description?: unknown }).description;
  const description =
    typeof descriptionRaw === "string" && descriptionRaw.trim().length > 0
      ? descriptionRaw.trim()
      : undefined;
  return { indicator, description };
}

async function fetchAnthropicOutageSnapshot(now: number): Promise<ProviderOutageSnapshot | null> {
  if (typeof globalThis.fetch !== "function") {
    return null;
  }
  try {
    const response = await globalThis.fetch(ANTHROPIC_STATUS_ENDPOINT, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROVIDER_STATUS_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as unknown;
    const parsed = parseStatuspagePayload(payload);
    if (!parsed) {
      return null;
    }
    return {
      unavailable: STATUSPAGE_OUTAGE_INDICATORS.has(parsed.indicator),
      message: formatAnthropicStatusMessage(parsed.indicator, parsed.description),
      checkedAt: now,
      source: ANTHROPIC_STATUS_ENDPOINT,
    };
  } catch {
    return null;
  }
}

async function fetchOpenAiOutageSnapshot(now: number): Promise<ProviderOutageSnapshot | null> {
  if (typeof globalThis.fetch !== "function") {
    return null;
  }
  try {
    const response = await globalThis.fetch(OPENAI_STATUS_ENDPOINT, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROVIDER_STATUS_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as unknown;
    const parsed = parseStatuspagePayload(payload);
    if (!parsed) {
      return null;
    }
    return {
      unavailable: STATUSPAGE_OUTAGE_INDICATORS.has(parsed.indicator),
      message: formatOpenAiStatusMessage(parsed.indicator, parsed.description),
      checkedAt: now,
      source: OPENAI_STATUS_ENDPOINT,
    };
  } catch {
    return null;
  }
}

function resolveProviderStatusScope(provider: string): string {
  const normalizedProvider = normalizeProviderId(provider);
  if (OPENAI_STATUS_PROVIDERS.has(normalizedProvider)) {
    return "openai";
  }
  return normalizedProvider;
}

async function resolveProviderOutageSnapshot(
  provider: string,
  now: number,
): Promise<ProviderOutageSnapshot | null> {
  if (!isProviderStatusCheckEnabled()) {
    return null;
  }
  const providerStatusScope = resolveProviderStatusScope(provider);
  if (providerStatusScope !== "anthropic" && providerStatusScope !== "openai") {
    return null;
  }
  const cached = providerStatusCache.get(providerStatusScope);
  if (cached && cached.expiresAt > now) {
    return cached.snapshot;
  }

  const snapshot =
    providerStatusScope === "anthropic"
      ? await fetchAnthropicOutageSnapshot(now)
      : await fetchOpenAiOutageSnapshot(now);
  if (!snapshot) {
    return cached?.snapshot ?? null;
  }

  providerStatusCache.set(providerStatusScope, {
    expiresAt: now + resolveProviderStatusCacheTtlMs(),
    snapshot,
  });
  return snapshot;
}

function hasCrossProviderCandidate(candidates: ModelCandidate[], index: number): boolean {
  const current = candidates[index];
  if (!current) {
    return false;
  }
  const currentProviderScope = resolveProviderStatusScope(current.provider);
  return candidates.some(
    (candidate, candidateIndex) =>
      candidateIndex !== index &&
      resolveProviderStatusScope(candidate.provider) !== currentProviderScope,
  );
}

function isOpenAiCodexModel(model: string): boolean {
  return model.trim().toLowerCase().includes("codex");
}

function resolveProviderCandidate(params: {
  candidate: ModelCandidate;
  cfg: OpenClawConfig | undefined;
  authStore: ReturnType<typeof ensureAuthProfileStore> | null;
}): ModelCandidate {
  if (!params.authStore) {
    return params.candidate;
  }
  if (normalizeProviderId(params.candidate.provider) !== OPENAI_PROVIDER) {
    return params.candidate;
  }
  if (!isOpenAiCodexModel(params.candidate.model)) {
    return params.candidate;
  }
  if (String(process.env[OPENAI_API_KEY_ENV] ?? "").trim()) {
    return params.candidate;
  }

  const hasOpenAiProfiles =
    resolveAuthProfileOrder({
      cfg: params.cfg,
      store: params.authStore,
      provider: OPENAI_PROVIDER,
    }).length > 0;
  if (hasOpenAiProfiles) {
    return params.candidate;
  }

  const hasOpenAiCodexProfiles =
    resolveAuthProfileOrder({
      cfg: params.cfg,
      store: params.authStore,
      provider: OPENAI_CODEX_PROVIDER,
    }).length > 0;
  if (!hasOpenAiCodexProfiles) {
    return params.candidate;
  }

  return {
    provider: OPENAI_CODEX_PROVIDER,
    model: params.candidate.model,
  };
}

/** @internal – exposed for unit tests only */
export const _providerStatusInternals = {
  providerStatusCache,
  resolveProviderOutageSnapshot,
  isProviderStatusCheckEnabled,
} as const;

/**
 * Fallback abort check. Only treats explicit AbortError names as user aborts.
 * Message-based checks (e.g., "aborted") can mask timeouts and skip fallback.
 */
function isFallbackAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  if (isFailoverError(err)) {
    return false;
  }
  const name = "name" in err ? String(err.name) : "";
  return name === "AbortError";
}

function shouldRethrowAbort(err: unknown): boolean {
  return isFallbackAbortError(err) && !isTimeoutError(err);
}

function createModelCandidateCollector(allowlist: Set<string> | null | undefined): {
  candidates: ModelCandidate[];
  addExplicitCandidate: (candidate: ModelCandidate) => void;
  addAllowlistedCandidate: (candidate: ModelCandidate) => void;
} {
  const seen = new Set<string>();
  const candidates: ModelCandidate[] = [];

  const addCandidate = (candidate: ModelCandidate, enforceAllowlist: boolean) => {
    if (!candidate.provider || !candidate.model) {
      return;
    }
    const key = modelKey(candidate.provider, candidate.model);
    if (seen.has(key)) {
      return;
    }
    if (enforceAllowlist && allowlist && !allowlist.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  const addExplicitCandidate = (candidate: ModelCandidate) => {
    addCandidate(candidate, false);
  };
  const addAllowlistedCandidate = (candidate: ModelCandidate) => {
    addCandidate(candidate, true);
  };

  return { candidates, addExplicitCandidate, addAllowlistedCandidate };
}

type ModelFallbackErrorHandler = (attempt: {
  provider: string;
  model: string;
  error: unknown;
  attempt: number;
  total: number;
}) => void | Promise<void>;

type ModelFallbackRunResult<T> = {
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
};

function buildFallbackSuccess<T>(params: {
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
}): ModelFallbackRunResult<T> {
  return {
    result: params.result,
    provider: params.provider,
    model: params.model,
    attempts: params.attempts,
  };
}

async function runFallbackCandidate<T>(params: {
  run: (provider: string, model: string) => Promise<T>;
  provider: string;
  model: string;
}): Promise<{ ok: true; result: T } | { ok: false; error: unknown }> {
  try {
    return {
      ok: true,
      result: await params.run(params.provider, params.model),
    };
  } catch (err) {
    if (shouldRethrowAbort(err)) {
      throw err;
    }
    return { ok: false, error: err };
  }
}

async function runFallbackAttempt<T>(params: {
  run: (provider: string, model: string) => Promise<T>;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
}): Promise<{ success: ModelFallbackRunResult<T> } | { error: unknown }> {
  const runResult = await runFallbackCandidate({
    run: params.run,
    provider: params.provider,
    model: params.model,
  });
  if (runResult.ok) {
    return {
      success: buildFallbackSuccess({
        result: runResult.result,
        provider: params.provider,
        model: params.model,
        attempts: params.attempts,
      }),
    };
  }
  return { error: runResult.error };
}

function sameModelCandidate(a: ModelCandidate, b: ModelCandidate): boolean {
  return a.provider === b.provider && a.model === b.model;
}

function throwFallbackFailureSummary(params: {
  attempts: FallbackAttempt[];
  candidates: ModelCandidate[];
  lastError: unknown;
  label: string;
  formatAttempt: (attempt: FallbackAttempt) => string;
}): never {
  if (params.attempts.length <= 1 && params.lastError) {
    throw params.lastError;
  }
  const summary =
    params.attempts.length > 0 ? params.attempts.map(params.formatAttempt).join(" | ") : "unknown";
  throw new Error(
    `All ${params.label} failed (${params.attempts.length || params.candidates.length}): ${summary}`,
    {
      cause: params.lastError instanceof Error ? params.lastError : undefined,
    },
  );
}

function resolveImageFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  defaultProvider: string;
  modelOverride?: string;
}): ModelCandidate[] {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: params.defaultProvider,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  const { candidates, addExplicitCandidate, addAllowlistedCandidate } =
    createModelCandidateCollector(allowlist);

  const addRaw = (raw: string, opts?: { allowlist?: boolean }) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: params.defaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      return;
    }
    if (opts?.allowlist) {
      addAllowlistedCandidate(resolved.ref);
      return;
    }
    addExplicitCandidate(resolved.ref);
  };

  if (params.modelOverride?.trim()) {
    addRaw(params.modelOverride);
  } else {
    const primary = resolveAgentModelPrimaryValue(params.cfg?.agents?.defaults?.imageModel);
    if (primary?.trim()) {
      addRaw(primary);
    }
  }

  const imageFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.imageModel);

  for (const raw of imageFallbacks) {
    // Explicitly configured image fallbacks should remain reachable even when a
    // model allowlist is present.
    addRaw(raw);
  }

  return candidates;
}

function resolveFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
}): ModelCandidate[] {
  const primary = params.cfg
    ? resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      })
    : null;
  const defaultProvider = primary?.provider ?? DEFAULT_PROVIDER;
  const defaultModel = primary?.model ?? DEFAULT_MODEL;
  const providerRaw = String(params.provider ?? "").trim() || defaultProvider;
  const modelRaw = String(params.model ?? "").trim() || defaultModel;
  const normalizedPrimary = normalizeModelRef(providerRaw, modelRaw);
  const configuredPrimary = normalizeModelRef(defaultProvider, defaultModel);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider,
  });
  const { candidates, addExplicitCandidate } = createModelCandidateCollector(allowlist);

  addExplicitCandidate(normalizedPrimary);

  const modelFallbacks = (() => {
    if (params.fallbacksOverride !== undefined) {
      return params.fallbacksOverride;
    }
    const configuredFallbacks = resolveAgentModelFallbackValues(
      params.cfg?.agents?.defaults?.model,
    );
    // When user runs a different provider than config, only use configured fallbacks
    // if the current model is already in that chain (e.g. session on first fallback).
    if (normalizedPrimary.provider !== configuredPrimary.provider) {
      const isConfiguredFallback = configuredFallbacks.some((raw) => {
        const resolved = resolveModelRefFromString({
          raw: String(raw ?? ""),
          defaultProvider,
          aliasIndex,
        });
        return resolved ? sameModelCandidate(resolved.ref, normalizedPrimary) : false;
      });
      return isConfiguredFallback ? configuredFallbacks : [];
    }
    // Same provider: always use full fallback chain (model version differences within provider).
    return configuredFallbacks;
  })();

  for (const raw of modelFallbacks) {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      continue;
    }
    // Fallbacks are explicit user intent; do not silently filter them by the
    // model allowlist.
    addExplicitCandidate(resolved.ref);
  }

  if (params.fallbacksOverride === undefined && primary?.provider && primary.model) {
    addExplicitCandidate({ provider: primary.provider, model: primary.model });
  }

  return candidates;
}

const lastProbeAttempt = new Map<string, number>();
const MIN_PROBE_INTERVAL_MS = 30_000; // 30 seconds between probes per key
const PROBE_MARGIN_MS = 2 * 60 * 1000;
const PROBE_SCOPE_DELIMITER = "::";

function resolveProbeThrottleKey(provider: string, agentDir?: string): string {
  const scope = String(agentDir ?? "").trim();
  return scope ? `${scope}${PROBE_SCOPE_DELIMITER}${provider}` : provider;
}

function shouldProbePrimaryDuringCooldown(params: {
  isPrimary: boolean;
  hasFallbackCandidates: boolean;
  now: number;
  throttleKey: string;
  authStore: ReturnType<typeof ensureAuthProfileStore>;
  profileIds: string[];
}): boolean {
  if (!params.isPrimary || !params.hasFallbackCandidates) {
    return false;
  }

  const lastProbe = lastProbeAttempt.get(params.throttleKey) ?? 0;
  if (params.now - lastProbe < MIN_PROBE_INTERVAL_MS) {
    return false;
  }

  const soonest = getSoonestCooldownExpiry(params.authStore, params.profileIds);
  if (soonest === null || !Number.isFinite(soonest)) {
    return true;
  }

  // Probe when cooldown already expired or within the configured margin.
  return params.now >= soonest - PROBE_MARGIN_MS;
}

/** @internal – exposed for unit tests only */
export const _probeThrottleInternals = {
  lastProbeAttempt,
  MIN_PROBE_INTERVAL_MS,
  PROBE_MARGIN_MS,
  resolveProbeThrottleKey,
} as const;

type CooldownDecision =
  | {
      type: "skip";
      reason: FailoverReason;
      error: string;
    }
  | {
      type: "attempt";
      reason: FailoverReason;
      markProbe: boolean;
    };

function resolveCooldownDecision(params: {
  candidate: ModelCandidate;
  isPrimary: boolean;
  requestedModel: boolean;
  hasFallbackCandidates: boolean;
  now: number;
  probeThrottleKey: string;
  authStore: ReturnType<typeof ensureAuthProfileStore>;
  profileIds: string[];
}): CooldownDecision {
  const shouldProbe = shouldProbePrimaryDuringCooldown({
    isPrimary: params.isPrimary,
    hasFallbackCandidates: params.hasFallbackCandidates,
    now: params.now,
    throttleKey: params.probeThrottleKey,
    authStore: params.authStore,
    profileIds: params.profileIds,
  });

  const inferredReason =
    resolveProfilesUnavailableReason({
      store: params.authStore,
      profileIds: params.profileIds,
      now: params.now,
    }) ?? "rate_limit";
  const isPersistentIssue =
    inferredReason === "auth" ||
    inferredReason === "auth_permanent" ||
    inferredReason === "billing";
  if (isPersistentIssue) {
    return {
      type: "skip",
      reason: inferredReason,
      error: `Provider ${params.candidate.provider} has ${inferredReason} issue (skipping all models)`,
    };
  }

  // For primary: try when requested model or when probe allows.
  // For same-provider fallbacks: only relax cooldown on rate_limit, which
  // is commonly model-scoped and can recover on a sibling model.
  const shouldAttemptDespiteCooldown =
    (params.isPrimary && (!params.requestedModel || shouldProbe)) ||
    (!params.isPrimary && inferredReason === "rate_limit");
  if (!shouldAttemptDespiteCooldown) {
    return {
      type: "skip",
      reason: inferredReason,
      error: `Provider ${params.candidate.provider} is in cooldown (all profiles unavailable)`,
    };
  }

  return {
    type: "attempt",
    reason: inferredReason,
    markProbe: params.isPrimary && shouldProbe,
  };
}

export async function runWithModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  agentDir?: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  run: (provider: string, model: string) => Promise<T>;
  onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveFallbackCandidates({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
  });
  const authStore = params.cfg
    ? ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false })
    : null;
  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  const hasFallbackCandidates = candidates.length > 1;

  for (let i = 0; i < candidates.length; i += 1) {
    const baseCandidate = candidates[i];
    if (!baseCandidate) {
      continue;
    }
    const candidate = resolveProviderCandidate({
      candidate: baseCandidate,
      cfg: params.cfg,
      authStore,
    });
    const now = Date.now();

    const outageSnapshot = await resolveProviderOutageSnapshot(candidate.provider, now);
    if (outageSnapshot?.unavailable && hasCrossProviderCandidate(candidates, i)) {
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: outageSnapshot.message,
        reason: "timeout",
        status: 503,
        code: "provider_status_outage",
      });
      continue;
    }

    if (authStore) {
      const profileIds = resolveAuthProfileOrder({
        cfg: params.cfg,
        store: authStore,
        provider: candidate.provider,
      });
      const isAnyProfileAvailable = profileIds.some((id) => !isProfileInCooldown(authStore, id));

      if (profileIds.length > 0 && !isAnyProfileAvailable) {
        // All profiles for this provider are in cooldown.
        const isPrimary = i === 0;
        const requestedModel =
          params.provider === candidate.provider && params.model === candidate.model;
        const probeThrottleKey = resolveProbeThrottleKey(candidate.provider, params.agentDir);
        const decision = resolveCooldownDecision({
          candidate,
          isPrimary,
          requestedModel,
          hasFallbackCandidates,
          now,
          probeThrottleKey,
          authStore,
          profileIds,
        });

        if (decision.type === "skip") {
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            error: decision.error,
            reason: decision.reason,
          });
          continue;
        }

        if (decision.markProbe) {
          lastProbeAttempt.set(probeThrottleKey, now);
        }
      }
    }

    const attemptRun = await runFallbackAttempt({ run: params.run, ...candidate, attempts });
    if ("success" in attemptRun) {
      return attemptRun.success;
    }
    const err = attemptRun.error;
    {
      // Context overflow errors should be handled by the inner runner's
      // compaction/retry logic, not by model fallback.  If one escapes as a
      // throw, rethrow it immediately rather than trying a different model
      // that may have a smaller context window and fail worse.
      const errMessage = err instanceof Error ? err.message : String(err);
      if (isLikelyContextOverflowError(errMessage)) {
        throw err;
      }
      const normalized =
        coerceToFailoverError(err, {
          provider: candidate.provider,
          model: candidate.model,
        }) ?? err;

      // Even unrecognized errors should not abort the fallback loop when
      // there are remaining candidates.  Only abort/context-overflow errors
      // (handled above) are truly non-retryable.
      const isKnownFailover = isFailoverError(normalized);
      if (!isKnownFailover && i === candidates.length - 1) {
        throw err;
      }

      lastError = isKnownFailover ? normalized : err;
      const described = describeFailoverError(normalized);
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: described.message,
        reason: described.reason ?? "unknown",
        status: described.status,
        code: described.code,
      });
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: isKnownFailover ? normalized : err,
        attempt: i + 1,
        total: candidates.length,
      });
    }
  }

  throwFallbackFailureSummary({
    attempts,
    candidates,
    lastError,
    label: "models",
    formatAttempt: (attempt) =>
      `${attempt.provider}/${attempt.model}: ${attempt.error}${
        attempt.reason ? ` (${attempt.reason})` : ""
      }`,
  });
}

export async function runWithImageModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  modelOverride?: string;
  run: (provider: string, model: string) => Promise<T>;
  onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveImageFallbackCandidates({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    modelOverride: params.modelOverride,
  });
  if (candidates.length === 0) {
    throw new Error(
      "No image model configured. Set agents.defaults.imageModel.primary or agents.defaults.imageModel.fallbacks.",
    );
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const attemptRun = await runFallbackAttempt({ run: params.run, ...candidate, attempts });
    if ("success" in attemptRun) {
      return attemptRun.success;
    }
    {
      const err = attemptRun.error;
      lastError = err;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: err instanceof Error ? err.message : String(err),
      });
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: err,
        attempt: i + 1,
        total: candidates.length,
      });
    }
  }

  throwFallbackFailureSummary({
    attempts,
    candidates,
    lastError,
    label: "image models",
    formatAttempt: (attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`,
  });
}
