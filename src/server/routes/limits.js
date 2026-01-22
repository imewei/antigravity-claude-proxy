import { Router } from 'express';
import { formatDuration } from '../../utils/helpers.js';
import { getModelQuotas, getSubscriptionTier } from '../../cloudcode/index.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import usageStats from '../../modules/usage-stats.js';

/**
 * Create Limits Router
 * @param {Object} context - Server context
 * @param {AccountManager} context.accountManager - Account manager instance
 * @param {Function} context.ensureInitialized - Async function to ensure initialization
 * @returns {Router} Express router
 */
export function createLimitsRouter({ accountManager, ensureInitialized }) {
    const router = Router();

    /**
     * Account limits endpoint - fetch quota/limits for all accounts × all models
     * Returns a table showing remaining quota and reset time for each combination
     * Use ?format=table for ASCII table output, default is JSON
     */
    router.get('/', async (req, res) => {
        try {
            await ensureInitialized();
            const allAccounts = accountManager.getAllAccounts();
            const format = req.query.format || 'json';
            const includeHistory = req.query.includeHistory === 'true';

            // Fetch quotas for each account in parallel
            const results = await Promise.allSettled(
                allAccounts.map(async (account) => {
                    // Skip invalid accounts
                    if (account.isInvalid) {
                        return {
                            email: account.email,
                            status: 'invalid',
                            error: account.invalidReason,
                            models: {}
                        };
                    }

                    try {
                        const token = await accountManager.getTokenForAccount(account);

                        // Fetch subscription tier first to get project ID
                        const subscription = await getSubscriptionTier(token);

                        // Then fetch quotas with project ID for accurate quota info
                        const quotas = await getModelQuotas(token, subscription.projectId);

                        // Update account object with fresh data
                        account.subscription = {
                            tier: subscription.tier,
                            projectId: subscription.projectId,
                            detectedAt: Date.now()
                        };
                        account.quota = {
                            models: quotas,
                            lastChecked: Date.now()
                        };

                        // Save updated account data to disk (async, don't wait)
                        accountManager.saveToDisk().catch(err => {
                            logger.error('[Server] Failed to save account data:', err);
                        });

                        return {
                            email: account.email,
                            status: 'ok',
                            subscription: account.subscription,
                            models: quotas
                        };
                    } catch (error) {
                        return {
                            email: account.email,
                            status: 'error',
                            error: error.message,
                            subscription: account.subscription || { tier: 'unknown', projectId: null },
                            models: {}
                        };
                    }
                })
            );

            // Process results
            const accountLimits = results.map((result, index) => {
                if (result.status === 'fulfilled') {
                    return result.value;
                } else {
                    return {
                        email: allAccounts[index].email,
                        status: 'error',
                        error: result.reason?.message || 'Unknown error',
                        models: {}
                    };
                }
            });

            // Collect all unique model IDs
            const allModelIds = new Set();
            for (const account of accountLimits) {
                for (const modelId of Object.keys(account.models || {})) {
                    allModelIds.add(modelId);
                }
            }

            const sortedModels = Array.from(allModelIds).sort();

            // Return ASCII table format
            if (format === 'table') {
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');

                // Build table
                const lines = [];
                const timestamp = new Date().toLocaleString();
                lines.push(`Account Limits (${timestamp})`);

                // Get account status info
                const status = accountManager.getStatus();
                lines.push(`Accounts: ${status.total} total, ${status.available} available, ${status.rateLimited} rate-limited, ${status.invalid} invalid`);
                lines.push('');

                // Table 1: Account status
                const accColWidth = 25;
                const statusColWidth = 15;
                const lastUsedColWidth = 25;
                const resetColWidth = 25;

                let accHeader = 'Account'.padEnd(accColWidth) + 'Status'.padEnd(statusColWidth) + 'Last Used'.padEnd(lastUsedColWidth) + 'Quota Reset';
                lines.push(accHeader);
                lines.push('─'.repeat(accColWidth + statusColWidth + lastUsedColWidth + resetColWidth));

                for (const acc of status.accounts) {
                    const shortEmail = acc.email.split('@')[0].slice(0, 22);
                    const lastUsed = acc.lastUsed ? new Date(acc.lastUsed).toLocaleString() : 'never';

                    // Get status and error from accountLimits
                    const accLimit = accountLimits.find(a => a.email === acc.email);
                    let accStatus;
                    if (acc.isInvalid) {
                        accStatus = 'invalid';
                    } else if (accLimit?.status === 'error') {
                        accStatus = 'error';
                    } else {
                        // Count exhausted models (0% or null remaining)
                        const models = accLimit?.models || {};
                        const modelCount = Object.keys(models).length;
                        const exhaustedCount = Object.values(models).filter(
                            q => q.remainingFraction === 0 || q.remainingFraction === null
                        ).length;

                        if (exhaustedCount === 0) {
                            accStatus = 'ok';
                        } else {
                            accStatus = `(${exhaustedCount}/${modelCount}) limited`;
                        }
                    }

                    // Get reset time from quota API
                    const claudeModel = sortedModels.find(m => m.includes('claude'));
                    const quota = claudeModel && accLimit?.models?.[claudeModel];
                    const resetTime = quota?.resetTime
                        ? new Date(quota.resetTime).toLocaleString()
                        : '-';

                    let row = shortEmail.padEnd(accColWidth) + accStatus.padEnd(statusColWidth) + lastUsed.padEnd(lastUsedColWidth) + resetTime;

                    // Add error on next line if present
                    if (accLimit?.error) {
                        lines.push(row);
                        lines.push('  └─ ' + accLimit.error);
                    } else {
                        lines.push(row);
                    }
                }
                lines.push('');

                // Calculate column widths - need more space for reset time info
                const modelColWidth = Math.max(28, ...sortedModels.map(m => m.length)) + 2;
                const accountColWidth = 30;

                // Header row
                let header = 'Model'.padEnd(modelColWidth);
                for (const acc of accountLimits) {
                    const shortEmail = acc.email.split('@')[0].slice(0, 26);
                    header += shortEmail.padEnd(accountColWidth);
                }
                lines.push(header);
                lines.push('─'.repeat(modelColWidth + accountLimits.length * accountColWidth));

                // Data rows
                for (const modelId of sortedModels) {
                    let row = modelId.padEnd(modelColWidth);
                    for (const acc of accountLimits) {
                        const quota = acc.models?.[modelId];
                        let cell;
                        if (acc.status !== 'ok' && acc.status !== 'rate-limited') {
                            cell = `[${acc.status}]`;
                        } else if (!quota) {
                            cell = '-';
                        } else if (quota.remainingFraction === 0 || quota.remainingFraction === null) {
                            // Show reset time for exhausted models
                            if (quota.resetTime) {
                                const resetMs = new Date(quota.resetTime).getTime() - Date.now();
                                if (resetMs > 0) {
                                    cell = `0% (wait ${formatDuration(resetMs)})`;
                                } else {
                                    cell = '0% (resetting...)';
                                }
                            } else {
                                cell = '0% (exhausted)';
                            }
                        } else {
                            const pct = Math.round(quota.remainingFraction * 100);
                            cell = `${pct}%`;
                        }
                        row += cell.padEnd(accountColWidth);
                    }
                    lines.push(row);
                }

                return res.send(lines.join('\n'));
            }

            // Get account metadata from AccountManager
            const accountStatus = accountManager.getStatus();
            const accountMetadataMap = new Map(
                accountStatus.accounts.map(a => [a.email, a])
            );

            // Build response data
            const responseData = {
                timestamp: new Date().toLocaleString(),
                totalAccounts: allAccounts.length,
                models: sortedModels,
                modelConfig: config.modelMapping || {},
                accounts: accountLimits.map(acc => {
                    // Merge quota data with account metadata
                    const metadata = accountMetadataMap.get(acc.email) || {};
                    return {
                        email: acc.email,
                        status: acc.status,
                        error: acc.error || null,
                        // Include metadata from AccountManager (WebUI needs these)
                        source: metadata.source || 'unknown',
                        enabled: metadata.enabled !== false,
                        projectId: metadata.projectId || null,
                        isInvalid: metadata.isInvalid || false,
                        invalidReason: metadata.invalidReason || null,
                        lastUsed: metadata.lastUsed || null,
                        modelRateLimits: metadata.modelRateLimits || {},
                        // Subscription data (new)
                        subscription: acc.subscription || metadata.subscription || { tier: 'unknown', projectId: null },
                        // Quota limits
                        limits: Object.fromEntries(
                            sortedModels.map(modelId => {
                                const quota = acc.models?.[modelId];
                                if (!quota) {
                                    return [modelId, null];
                                }
                                return [modelId, {
                                    remaining: quota.remainingFraction !== null
                                        ? `${Math.round(quota.remainingFraction * 100)}%`
                                        : 'N/A',
                                    remainingFraction: quota.remainingFraction,
                                    resetTime: quota.resetTime || null
                                }];
                            })
                        )
                    };
                })
            };

            // Optionally include usage history (for dashboard performance optimization)
            if (includeHistory) {
                responseData.history = usageStats.getHistory();
            }

            res.json(responseData);
        } catch (error) {
            res.status(500).json({
                status: 'error',
                error: error.message
            });
        }
    });

    return router;
}
