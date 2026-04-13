import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { WalletActivity } from '../../src/types/wallet';
import { fetchWalletActivity } from '../lib/polymarket-wallet-client';
import {
  getCachedWalletActivity,
  getStaleWalletMemoryCache,
  getWalletActivityKey,
  setCachedWalletActivity,
} from '../lib/wallet-cache';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const WALLET_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

interface WalletActivityFilters {
  wallet: string;
  limit: number;
  since?: string;
}

interface WalletActivityResponse {
  success: true;
  data: {
    activity: WalletActivity[];
    count: number;
  };
  filters: WalletActivityFilters;
  timestamp: string;
  metadata: {
    wallet: string;
    source: 'polymarket';
    processing_time_ms: number;
    cached: boolean;
    cached_at?: string | null;
    cache_age_seconds: number | null;
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({
      success: false,
      error: 'Method not allowed. Use GET.',
    });
    return;
  }

  const startTime = Date.now();

  try {
    const filters = parseFilters(req);
    if ('error' in filters) {
      res.status(400).json({
        success: false,
        error: filters.error,
      });
      return;
    }

    const cached = await getCachedWalletActivity(filters.wallet, filters.limit, filters.since);
    if (cached) {
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
      res.status(200).json(buildResponse(
        filters,
        cached.data,
        startTime,
        true,
        cached.cached_at,
        cached.cache_age_seconds,
      ));
      return;
    }

    const activity = await fetchWalletActivity(filters.wallet, {
      limit: filters.limit,
      since: filters.since,
    });

    await setCachedWalletActivity(filters.wallet, filters.limit, filters.since, activity);

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json(buildResponse(filters, activity, startTime, false, null, null));
  } catch (error) {
    const fallback = getStaleActivity(req);
    if (fallback) {
      res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
      res.status(200).json(buildResponse(
        fallback.filters,
        fallback.activity,
        startTime,
        true,
        fallback.cachedAt,
        fallback.cacheAgeSeconds,
      ));
      return;
    }

    console.error('[Wallet Activity API] Error:', error);
    res.status(503).json({
      success: false,
      error: 'Wallet activity temporarily unavailable. Try again later.',
      metadata: {
        processing_time_ms: Date.now() - startTime,
      },
    });
  }
}

/**
 * Parse and validate activity query filters.
 *
 * @param req Vercel request with wallet query params.
 */
function parseFilters(req: VercelRequest): WalletActivityFilters | { error: string } {
  const walletParam = getSingleQueryValue(req.query.wallet);
  if (!walletParam) {
    return { error: 'Missing wallet query parameter.' };
  }

  if (!WALLET_ADDRESS_REGEX.test(walletParam)) {
    return { error: 'Invalid wallet. Use a 0x-prefixed 40-byte address.' };
  }

  const limit = parseLimit(getSingleQueryValue(req.query.limit));
  if (typeof limit === 'string') {
    return { error: limit };
  }

  const since = getSingleQueryValue(req.query.since);
  if (since && Number.isNaN(Date.parse(since))) {
    return { error: 'Invalid since timestamp. Use ISO 8601 format.' };
  }

  return {
    wallet: walletParam.toLowerCase(),
    limit,
    since,
  };
}

/**
 * Build the wallet activity response envelope.
 *
 * @param filters Validated query filters.
 * @param activity Normalized Polymarket activity rows.
 * @param startTime Request start time in milliseconds.
 * @param cached Whether the data came from cache.
 * @param cachedAt Cache write timestamp.
 * @param cacheAgeSeconds Cache age in seconds.
 */
function buildResponse(
  filters: WalletActivityFilters,
  activity: WalletActivity[],
  startTime: number,
  cached: boolean,
  cachedAt: string | null,
  cacheAgeSeconds: number | null,
): WalletActivityResponse {
  return {
    success: true,
    data: {
      activity,
      count: activity.length,
    },
    filters,
    timestamp: new Date().toISOString(),
    metadata: {
      wallet: filters.wallet,
      source: 'polymarket',
      processing_time_ms: Date.now() - startTime,
      cached,
      cached_at: cachedAt,
      cache_age_seconds: cacheAgeSeconds,
    },
  };
}

/**
 * Find stale memory data for the current activity query.
 *
 * @param req Vercel request with wallet query params.
 */
function getStaleActivity(req: VercelRequest): {
  filters: WalletActivityFilters;
  activity: WalletActivity[];
  cachedAt: string | null;
  cacheAgeSeconds: number | null;
} | null {
  const filters = parseFilters(req);
  if ('error' in filters) return null;

  const key = getWalletActivityKey(filters.wallet, filters.limit, filters.since);
  const stale = getStaleWalletMemoryCache<WalletActivity[]>(key);
  if (!stale) return null;

  return {
    filters,
    activity: stale.data,
    cachedAt: stale.cached_at,
    cacheAgeSeconds: stale.cache_age_seconds,
  };
}

function parseLimit(value: string | undefined): number | string {
  if (value === undefined) return DEFAULT_LIMIT;

  if (!/^\d+$/.test(value)) {
    return `Invalid limit. Must be between 1 and ${MAX_LIMIT}.`;
  }

  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return `Invalid limit. Must be between 1 and ${MAX_LIMIT}.`;
  }

  return limit;
}

function getSingleQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
