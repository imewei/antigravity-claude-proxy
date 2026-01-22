import { Router } from 'express';
import { formatDuration } from '../../utils/helpers.js';
import { getModelQuotas } from '../../cloudcode/index.js';
import { logger } from '../../utils/logger.js';

/**
 * Create Health Check Router
 * @param {Object} context - Server context
 * @param {AccountManager} context.accountManager - Account manager instance
 * @param {Function} context.ensureInitialized - Async function to ensure initialization
 * @returns {Router} Express router
 */
export function createHealthRouter({ accountManager, ensureInitialized }) {
    const router = Router();

    /**
     * Health check endpoint - Detailed status
     * Returns status of all accounts including rate limits and model quotas
     */
    router.get('/', async (req, res) => {
        try {
            await ensureInitialized();
            const start = Date.now();

            // Get high-level status first
            const status = accountManager.getStatus();
            const allAccounts = accountManager.getAllAccounts();

            // Fetch quotas for each account in parallel to get detailed model info
            const accountDetails = await Promise.allSettled(
                allAccounts.map(async (account) => {
                    // Check model-specific rate limits
                    const activeModelLimits = Object.entries(account.modelRateLimits || {})
                        .filter(([_, limit]) => limit.isRateLimited && limit.resetTime > Date.now());
                    const isRateLimited = activeModelLimits.length > 0;
                    const soonestReset = activeModelLimits.length > 0
                        ? Math.min(...activeModelLimits.map(([_, l]) => l.resetTime))
                        : null;

                    const baseInfo = {
                        email: account.email,
                        lastUsed: account.lastUsed ? new Date(account.lastUsed).toISOString() : null,
                        modelRateLimits: account.modelRateLimits || {},
                        rateLimitCooldownRemaining: soonestReset ? Math.max(0, soonestReset - Date.now()) : 0
                    };

                    // Skip invalid accounts for quota check
                    if (account.isInvalid) {
                        return {
                            ...baseInfo,
                            status: 'invalid',
                            error: account.invalidReason,
                            models: {}
                        };
                    }

                    try {
                        const token = await accountManager.getTokenForAccount(account);
                        const projectId = account.subscription?.projectId || null;
                        const quotas = await getModelQuotas(token, projectId);

                        // Format quotas for readability
                        const formattedQuotas = {};
                        for (const [modelId, info] of Object.entries(quotas)) {
                            formattedQuotas[modelId] = {
                                remaining: info.remainingFraction !== null ? `${Math.round(info.remainingFraction * 100)}%` : 'N/A',
                                remainingFraction: info.remainingFraction,
                                resetTime: info.resetTime || null
                            };
                        }

                        return {
                            ...baseInfo,
                            status: isRateLimited ? 'rate-limited' : 'ok',
                            models: formattedQuotas
                        };
                    } catch (error) {
                        return {
                            ...baseInfo,
                            status: 'error',
                            error: error.message,
                            models: {}
                        };
                    }
                })
            );

            // Process results
            const detailedAccounts = accountDetails.map((result, index) => {
                if (result.status === 'fulfilled') {
                    return result.value;
                } else {
                    const acc = allAccounts[index];
                    return {
                        email: acc.email,
                        status: 'error',
                        error: result.reason?.message || 'Unknown error',
                        modelRateLimits: acc.modelRateLimits || {}
                    };
                }
            });

            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                latencyMs: Date.now() - start,
                summary: status.summary,
                counts: {
                    total: status.total,
                    available: status.available,
                    rateLimited: status.rateLimited,
                    invalid: status.invalid
                },
                accounts: detailedAccounts
            });

        } catch (error) {
            logger.error('[API] Health check failed:', error);
            res.status(503).json({
                status: 'error',
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    });

    return router;
}
