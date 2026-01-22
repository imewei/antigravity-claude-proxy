import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AccountManager } from '../account-manager/index.js';
import { config } from '../config.js';
import { REQUEST_BODY_LIMIT } from '../constants.js';
import { logger } from '../utils/logger.js';
import usageStats from '../modules/usage-stats.js';
import { mountWebUI } from '../webui/index.js';
import { clearThinkingSignatureCache } from '../format/signature-cache.js';
import { createHealthRouter } from './routes/health.js';
import { createLimitsRouter } from './routes/limits.js';
import { createAuthRouter } from './routes/auth.js';
import { createAnthropicRouter } from './routes/anthropic.js';

const __filename = fileURLToPath(import.meta.url);
// __dirname should be root/src/server, but mountWebUI expects root/src (based on original __dirname being root/src)
// Original server.js was in src/. So __dirname was src/.
// Now ProxyServer.js is in src/server/. So __dirname is src/server/.
// We need to pass the equivalent of src/ to mountWebUI?
// checking mountWebUI usage: mountWebUI(app, __dirname, accountManager);
// src/webui/index.js probably uses it to serve static files from public/
const ROOT_DIR = path.resolve(__filename, '../..'); // Go up to src/

export class ProxyServer {
    constructor() {
        this.app = express();
        this.accountManager = new AccountManager();
        this.server = null;
        this.isInitialized = false;
        this.initPromise = null;
        this.activeStreams = new Set();
    }

    /**
     * Initialize the server and account manager
     * @param {string} strategyOverride - Optional strategy override
     */
    async initialize(strategyOverride = null) {
        if (this.isInitialized) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            try {
                await this.accountManager.initialize(strategyOverride);
                this.isInitialized = true;
                const status = this.accountManager.getStatus();
                logger.success(`[Server] Account pool initialized: ${status.summary}`);
            } catch (error) {
                this.initPromise = null;
                logger.error('[Server] Failed to initialize account manager:', error.message);
                throw error;
            }
        })();

        return this.initPromise;
    }

    /**
     * Ensure initialization is complete
     */
    async ensureInitialized() {
        return this.initialize();
    }

    /**
     * Setup middleware and routes
     * @param {boolean} fallbackEnabled - Whether fallback is enabled
     */
    setup(fallbackEnabled = false) {
        // Disable x-powered-by
        this.app.disable('x-powered-by');

        // Core Middleware
        const corsOrigin = process.env.CORS_ORIGIN ?? config.corsOrigin;
        const corsOptions = corsOrigin
            ? {
                origin: corsOrigin
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean)
            }
            : { origin: false };
        this.app.use(cors(corsOptions));
        this.app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

        // Request logging middleware
        this._setupRequestLogging();

        // API Key authentication middleware
        this._setupAuthMiddleware();

        // Usage statistics
        usageStats.setupMiddleware(this.app);

        // Silent handlers for Claude Code CLI
        this._setupSilentHandlers();

        // Mount WebUI
        // Note: passing ROOT_DIR (src/) to match original __dirname behavior
        mountWebUI(this.app, ROOT_DIR, this.accountManager);

        // Test utility endpoints
        this.app.post('/test/clear-signature-cache', (req, res) => {
            clearThinkingSignatureCache();
            logger.debug('[Test] Cleared thinking signature cache');
            res.json({ success: true, message: 'Thinking signature cache cleared' });
        });

        // Mount Routes
        const context = {
            accountManager: this.accountManager,
            ensureInitialized: this.ensureInitialized.bind(this),
            fallbackEnabled,
            registerStream: this._registerStream.bind(this)
        };

        this.app.use('/health', createHealthRouter(context));
        this.app.use('/account-limits', createLimitsRouter(context));

        // Mount Auth/Models router at root (handles /v1/models and /refresh-token)
        this.app.use('/', createAuthRouter(context));

        // Mount Anthropic router at /v1 (handles /v1/messages)
        this.app.use('/v1', createAnthropicRouter(context));
    }

    _setupRequestLogging() {
        this.app.use((req, res, next) => {
            const start = Date.now();
            res.on('finish', () => {
                const duration = Date.now() - start;
                const status = res.statusCode;
                const logMsg = `[${req.method}] ${req.path} ${status} (${duration}ms)`;

                if (
                    req.path === '/api/event_logging/batch' ||
                    req.path === '/v1/messages/count_tokens'
                ) {
                    if (logger.isDebugEnabled) logger.debug(logMsg);
                } else {
                    if (status >= 500) logger.error(logMsg);
                    else if (status >= 400) logger.warn(logMsg);
                    else logger.info(logMsg);
                }
            });
            next();
        });
    }

    _setupAuthMiddleware() {
        this.app.use('/v1', (req, res, next) => {
            if (!config.apiKey) return next();

            const authHeader = req.headers['authorization'];
            const xApiKey = req.headers['x-api-key'];

            let providedKey = '';
            if (authHeader && authHeader.startsWith('Bearer ')) {
                providedKey = authHeader.substring(7);
            } else if (xApiKey) {
                providedKey = xApiKey;
            }

            if (!providedKey || providedKey !== config.apiKey) {
                logger.warn(`[API] Unauthorized request from ${req.ip}, invalid API key`);
                return res.status(401).json({
                    type: 'error',
                    error: {
                        type: 'authentication_error',
                        message: 'Invalid or missing API key'
                    }
                });
            }
            next();
        });
    }

    _setupSilentHandlers() {
        this.app.use((req, res, next) => {
            if (req.method === 'POST') {
                if (req.path === '/api/event_logging/batch' || req.path === '/') {
                    return res.status(200).json({ status: 'ok' });
                }
            }
            next();
        });
    }

    /**
     * Start the server
     * @param {number} port - Port to listen on
     */
    start(port) {
        return new Promise((resolve, reject) => {
            this.server = this.app.listen(port, () => {
                resolve(this.server);
            });

            this.server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    reject(new Error(`Port ${port} is already in use. Please stop other processes or use a different port.`));
                } else {
                    reject(err);
                }
            });
        });
    }

    /**
     * Stop the server
     */
    async stop() {
        if (this.server) {
            await this._waitForStreamsToDrain();
            return new Promise((resolve, reject) => {
                this.server.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }
    }

    _registerStream(res) {
        if (!res) return;
        this.activeStreams.add(res);
        const cleanup = () => {
            this.activeStreams.delete(res);
        };
        res.on('close', cleanup);
        res.on('finish', cleanup);
    }

    _waitForStreamsToDrain(timeoutMs = 5000) {
        if (this.activeStreams.size === 0) return Promise.resolve();

        return new Promise((resolve) => {
            const start = Date.now();
            const check = () => {
                if (this.activeStreams.size === 0) {
                    resolve();
                    return;
                }
                if (Date.now() - start >= timeoutMs) {
                    logger.warn(
                        `[Server] Timed out waiting for ${this.activeStreams.size} active stream(s) to finish`
                    );
                    resolve();
                    return;
                }
                setTimeout(check, 100);
            };
            check();
        });
    }
}
