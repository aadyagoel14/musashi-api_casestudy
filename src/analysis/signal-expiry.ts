/**
 * signal-expiry.ts
 * ----------------
 * Adds time-based expiry to trading signals.
 *
 * Problem: The current API has no signal TTL. A HIGH urgency signal
 * generated at 12:00 is indistinguishable from the same signal at 12:45,
 * even though the edge may have long since disappeared.
 *
 * Solution: Each signal gets an `expires_at` timestamp. Bots should
 * discard any signal past this time.
 *
 * Expiry logic:
 *   - Critical signals: 5 minutes (act now or not at all)
 *   - High signals: 10 minutes
 *   - Medium signals: 20 minutes
 *   - Low signals: 30 minutes
 *   - Arbitrage signals: 3 minutes (spreads close fast)
 *   - All: capped at 10% of market resolution time if known
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type Urgency = "critical" | "high" | "medium" | "low";
export type SignalType = "arbitrage" | "news_event" | "sentiment_shift" | "user_interest";

export interface SignalExpiryInput {
  urgency: Urgency;
  signal_type: SignalType;
  /** ISO 8601 string or ms timestamp. When does the market resolve? Optional. */
  market_resolution_time?: string | number;
  /** When was the signal created (defaults to now) */
  created_at?: Date;
}

export interface SignalExpiry {
  expires_at: string;           // ISO 8601
  expires_at_ms: number;        // Unix ms, convenient for Date.now() comparison
  ttl_seconds: number;          // How long from creation until expiry
  is_expired: boolean;          // Whether it's already expired (useful for cached signals)
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TTL_BY_URGENCY: Record<Urgency, number> = {
  critical: 5 * 60,   // 5 min
  high:     10 * 60,  // 10 min
  medium:   20 * 60,  // 20 min
  low:      30 * 60,  // 30 min
};

/** Arbitrage spreads close faster than news signals */
const ARBITRAGE_TTL_SECONDS = 3 * 60; // 3 min

/** Cap expiry at this fraction of market resolution time */
const RESOLUTION_TIME_FRACTION = 0.10;

/** Absolute max TTL regardless of resolution time */
const MAX_TTL_SECONDS = 30 * 60; // 30 min

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Computes the expiry for a trading signal.
 *
 * Drop-in usage — add to the analyze-text response:
 *
 *   const expiry = computeSignalExpiry({
 *     urgency: result.urgency,
 *     signal_type: result.signal_type,
 *     market_resolution_time: matchedMarket.endDate,
 *   });
 *
 *   return {
 *     ...result,
 *     suggested_action: {
 *       ...result.suggested_action,
 *       expires_at: expiry.expires_at,
 *       ttl_seconds: expiry.ttl_seconds,
 *     }
 *   };
 */
export function computeSignalExpiry(input: SignalExpiryInput): SignalExpiry {
  const now = input.created_at ?? new Date();
  const nowMs = now.getTime();

  // Base TTL from urgency
  let ttlSeconds =
    input.signal_type === "arbitrage"
      ? ARBITRAGE_TTL_SECONDS
      : TTL_BY_URGENCY[input.urgency];

  // Cap by resolution time if available
  if (input.market_resolution_time != null) {
    const resolutionMs =
      typeof input.market_resolution_time === "string"
        ? new Date(input.market_resolution_time).getTime()
        : input.market_resolution_time;

    const timeToResolutionSeconds = (resolutionMs - nowMs) / 1000;

    if (timeToResolutionSeconds > 0) {
      const resolutionCap = timeToResolutionSeconds * RESOLUTION_TIME_FRACTION;
      ttlSeconds = Math.min(ttlSeconds, resolutionCap);
    }
  }

  // Absolute cap
  ttlSeconds = Math.min(ttlSeconds, MAX_TTL_SECONDS);

  // Floor at 60 seconds — a signal that expires in <1min is useless
  ttlSeconds = Math.max(ttlSeconds, 60);

  const expiresAtMs = nowMs + ttlSeconds * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();

  return {
    expires_at: expiresAt,
    expires_at_ms: expiresAtMs,
    ttl_seconds: Math.round(ttlSeconds),
    is_expired: Date.now() > expiresAtMs,
  };
}

/**
 * Checks whether a signal (from feed or cached) is still valid.
 * Use this in bot polling loops to skip stale signals.
 *
 * @example
 *   const signals = await agent.getFeed({ limit: 10 });
 *   const fresh = signals.filter(s => isSignalFresh(s.suggested_action?.expires_at));
 */
export function isSignalFresh(expiresAt: string | undefined | null): boolean {
  if (!expiresAt) return true; // No expiry = assume fresh (legacy signals)
  return Date.now() < new Date(expiresAt).getTime();
}

/**
 * Returns the number of seconds remaining until a signal expires.
 * Returns 0 if already expired.
 */
export function secondsUntilExpiry(expiresAt: string): number {
  const remaining = (new Date(expiresAt).getTime() - Date.now()) / 1000;
  return Math.max(0, Math.round(remaining));
}

// ─── Convenience using repo Market type ──────────────────────────────────────

import type { Market } from '../types/market';

/**
 * Compute signal expiry directly from a repo Market object.
 * Uses market.endDate automatically.
 *
 * @example
 *   const expiry = computeExpiryForMarket(market, urgency, signal_type);
 *   return { ...result, suggested_action: { ...action, expires_at: expiry.expires_at } };
 */
export function computeExpiryForMarket(
  market: Market,
  urgency: Urgency,
  signal_type: SignalType
): SignalExpiry {
  return computeSignalExpiry({
    urgency,
    signal_type,
    market_resolution_time: market.endDate,
  });
}
