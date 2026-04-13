import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { WalletPosition } from '../../src/types/wallet';
import { fetchWalletPositions } from '../lib/polymarket-wallet-client';
import {
  getCachedWalletPositions,
  getStaleWalletMemoryCache,
  getWalletPositionsKey,
  setCachedWalletPositions,
} from '../lib/wallet-cache';

const DEFAULT_LIMIT = 50;
const DEFAULT_MIN_VALUE = 0;
const MAX_LIMIT = 100;
const WALLET_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

interface WalletPositionsFilters {
  wallet: string;
  minValue: number;
  limit: number;
}

interface WalletPositionsResponse {
  success: true;
  data: {
    positions: WalletPosition[];
    count: number;
  };
  filters: WalletPositionsFilters;
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

    const cached = await getCachedWalletPositions(
      filters.wallet,
      filters.minValue,
      filters.limit,
    );
    if (cached) {
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
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

    const positions = await fetchWalletPositions(filters.wallet, {
      limit: filters.limit,
      minValue: filters.minValue,
    });

    await setCachedWalletPositions(
      filters.wallet,
      filters.minValue,
      filters.limit,
      positions,
    );

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json(buildResponse(filters, positions, startTime, false, null, null));
  } catch (error) {
    const fallback = getStalePositions(req);
    if (fallback) {
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
      res.status(200).json(buildResponse(
        fallback.filters,
        fallback.positions,
        startTime,
        true,
        fallback.cachedAt,
        fallback.cacheAgeSeconds,
      ));
      return;
    }

    console.error('[Wallet Positions API] Error:', error);
    res.status(503).json({
      success: false,
      error: 'Wallet positions temporarily unavailable. Try again later.',
      metadata: {
        processing_time_ms: Date.now() - startTime,
      },
    });
  }
}

/**
 * Parse and validate positions query filters.
 *
 * @param req Vercel request with wallet query params.
 */
function parseFilters(req: VercelRequest): WalletPositionsFilters | { error: string } {
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

  const minValue = parseMinValue(getSingleQueryValue(req.query.minValue));
  if (typeof minValue === 'string') {
    return { error: minValue };
  }

  return {
    wallet: walletParam.toLowerCase(),
    minValue,
    limit,
  };
}

/**
 * Build the wallet positions response envelope.
 *
 * @param filters Validated query filters.
 * @param positions Normalized Polymarket position rows.
 * @param startTime Request start time in milliseconds.
 * @param cached Whether the data came from cache.
 * @param cachedAt Cache write timestamp.
 * @param cacheAgeSeconds Cache age in seconds.
 */
function buildResponse(
  filters: WalletPositionsFilters,
  positions: WalletPosition[],
  startTime: number,
  cached: boolean,
  cachedAt: string | null,
  cacheAgeSeconds: number | null,
): WalletPositionsResponse {
  return {
    success: true,
    data: {
      positions,
      count: positions.length,
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
 * Find stale memory data for the current positions query.
 *
 * @param req Vercel request with wallet query params.
 */
function getStalePositions(req: VercelRequest): {
  filters: WalletPositionsFilters;
  positions: WalletPosition[];
  cachedAt: string | null;
  cacheAgeSeconds: number | null;
} | null {
  const filters = parseFilters(req);
  if ('error' in filters) return null;

  const key = getWalletPositionsKey(filters.wallet, filters.minValue, filters.limit);
  const stale = getStaleWalletMemoryCache<WalletPosition[]>(key);
  if (!stale) return null;

  return {
    filters,
    positions: stale.data,
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

function parseMinValue(value: string | undefined): number | string {
  if (value === undefined) return DEFAULT_MIN_VALUE;

  const minValue = Number(value);
  if (!Number.isFinite(minValue) || minValue < 0) {
    return 'Invalid minValue. Must be greater than or equal to 0.';
  }

  return minValue;
}

function getSingleQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
