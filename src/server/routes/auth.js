import { Router } from 'express';
import { forceRefresh } from '../../auth/token-extractor.js';
import { listModels } from '../../cloudcode/index.js';
import { logger } from '../../utils/logger.js';

/**
 * Create Auth/Models Router
 * @param {Object} context - Server context
 * @param {AccountManager} context.accountManager - Account manager instance
 * @param {Function} context.ensureInitialized - Async function to ensure initialization
 * @returns {Router} Express router
 */
export function createAuthRouter({ accountManager, ensureInitialized }) {
    const router = Router();

    /**
     * Force token refresh endpoint
     */
    router.post('/refresh-token', async (req, res) => {
        try {
            await ensureInitialized();
            // Clear all caches
            accountManager.clearTokenCache();
            accountManager.clearProjectCache();
            // Force refresh default token
            const token = await forceRefresh();
            res.json({
                status: 'ok',
                message: 'Token caches cleared and refreshed',
                tokenPrefix: token.substring(0, 10) + '...'
            });
        } catch (error) {
            res.status(500).json({
                status: 'error',
                error: error.message
            });
        }
    });

    /**
     * List models endpoint (OpenAI-compatible format)
     * Maps to /v1/models if mounted at root, or relative if mounted at /v1
     * We'll mount this such that it handles /v1/models
     */
    router.get('/v1/models', async (req, res) => {
        try {
            await ensureInitialized();
            const { account } = accountManager.selectAccount();
            if (!account) {
                return res.status(503).json({
                    type: 'error',
                    error: {
                        type: 'api_error',
                        message: 'No accounts available'
                    }
                });
            }
            const token = await accountManager.getTokenForAccount(account);
            const models = await listModels(token);
            res.json(models);
        } catch (error) {
            logger.error('[API] Error listing models:', error);
            res.status(500).json({
                type: 'error',
                error: {
                    type: 'api_error',
                    message: error.message
                }
            });
        }
    });

    return router;
}
