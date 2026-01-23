/**
 * Quota Manager
 *
 * Periodically refreshes quota and subscription data for all accounts.
 * This ensures that load balancing strategies have up-to-date information.
 */

import { getModelQuotas, getSubscriptionTier } from '../../cloudcode/model-api.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/helpers.js';

// Default refresh interval: 15 minutes
const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
// Stagger delay between accounts to avoid hitting API limits
const STAGGER_DELAY_MS = 2000;

export class QuotaManager {
    #accountManager;
    #refreshInterval;
    #timer = null;
    #isRefreshing = false;

    /**
     * Create a new QuotaManager
     * @param {Object} accountManager - Account manager instance
     * @param {Object} options - Configuration options
     * @param {number} [options.refreshIntervalMs] - Quota refresh interval
     */
    constructor(accountManager, options = {}) {
        this.#accountManager = accountManager;
        this.#refreshInterval = options.refreshIntervalMs || DEFAULT_REFRESH_INTERVAL_MS;
    }

    /**
     * Start the periodic quota refresh
     */
    start() {
        if (this.#timer) return;

        logger.info(
            `[QuotaManager] Starting periodic quota refresh (interval: ${this.#refreshInterval / 60000}m)`
        );

        // Initial refresh
        this.refreshAll().catch((e) =>
            logger.error(`[QuotaManager] Initial refresh failed: ${e.message}`)
        );

        // Set up timer
        this.#timer = setInterval(() => {
            this.refreshAll().catch((e) =>
                logger.error(`[QuotaManager] Periodic refresh failed: ${e.message}`)
            );
        }, this.#refreshInterval);
    }

    /**
     * Stop the periodic quota refresh
     */
    stop() {
        if (this.#timer) {
            clearInterval(this.#timer);
            this.#timer = null;
        }
    }

    /**
     * Refresh quota and subscription for all enabled accounts
     */
    async refreshAll() {
        if (this.#isRefreshing) return;
        this.#isRefreshing = true;

        const accounts = this.#accountManager.getAllAccounts();
        const enabledAccounts = accounts.filter((acc) => acc.enabled !== false && !acc.isInvalid);

        logger.info(`[QuotaManager] Refreshing quota for ${enabledAccounts.length} accounts...`);

        for (const account of enabledAccounts) {
            try {
                await this.refreshAccount(account);
                // Stagger requests
                await sleep(STAGGER_DELAY_MS);
            } catch (error) {
                logger.warn(
                    `[QuotaManager] Failed to refresh account ${account.email}: ${error.message}`
                );
            }
        }

        this.#isRefreshing = false;
        logger.info('[QuotaManager] Quota refresh completed');
    }

    /**
     * Refresh quota and subscription for a specific account
     * @param {Object} account - Account object
     */
    async refreshAccount(account) {
        // 1. Get token
        const token = await this.#accountManager.getTokenForAccount(account);

        // 2. Discover/Verify project and get subscription tier
        // Note: This also verifies if the account is still valid
        const { tier, projectId } = await getSubscriptionTier(token);

        // Update subscription if changed
        if (tier !== 'unknown' || projectId) {
            account.subscription = {
                tier,
                projectId,
                detectedAt: new Date().toISOString()
            };
            if (projectId && !account.projectId) {
                account.projectId = projectId;
            }
        }

        // 3. Get model quotas
        const quotas = await getModelQuotas(token, account.projectId);

        // Update quota data
        account.quota = {
            models: quotas,
            lastChecked: Date.now()
        };

        // 4. Persistence
        await this.#accountManager.saveToDisk();

        logger.debug(
            `[QuotaManager] Refreshed ${account.email}: tier=${tier}, models=${Object.keys(quotas).length}`
        );
    }
}

export default QuotaManager;
