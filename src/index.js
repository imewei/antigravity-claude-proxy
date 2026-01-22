/**
 * Antigravity Claude Proxy
 * Entry point - starts the proxy server
 */

import { proxyServer, accountManager } from './server.js';
import { ACCOUNT_CONFIG_PATH, DEFAULT_PORT } from './constants.js';
import { logger } from './utils/logger.js';
import { STRATEGY_NAMES } from './account-manager/strategies/index.js';
import path from 'node:path';

// Parse command line arguments
const args = process.argv.slice(2);
const isDebug = args.includes('--debug') || process.env.DEBUG === 'true';
const isFallbackEnabled = args.includes('--fallback') || process.env.FALLBACK === 'true';

// Parse --strategy flag (format: --strategy=sticky or --strategy sticky)
let strategyOverride = null;
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--strategy=')) {
        strategyOverride = args[i].split('=')[1];
    } else if (args[i] === '--strategy' && args[i + 1]) {
        strategyOverride = args[i + 1];
    }
}
// Validate strategy
if (strategyOverride && !STRATEGY_NAMES.includes(strategyOverride.toLowerCase())) {
    logger.warn(
        `[Startup] Invalid strategy "${strategyOverride}". Valid options: ${STRATEGY_NAMES.join(', ')}. Using default.`
    );
    strategyOverride = null;
}

// Initialize logger
logger.setDebug(isDebug);

if (isDebug) {
    logger.debug('Debug mode enabled');
}

if (isFallbackEnabled) {
    logger.info('Model fallback mode enabled');
}

// Export fallback flag
export const FALLBACK_ENABLED = isFallbackEnabled;

const PORT = process.env.PORT || DEFAULT_PORT;

// Home directory for account storage
const CONFIG_DIR = path.dirname(ACCOUNT_CONFIG_PATH);

// Setup and start server
async function main() {
    // Setup middleware and routes
    proxyServer.setup(isFallbackEnabled);

    // Initialize account manager (async, starts in background)
    proxyServer.initialize(strategyOverride).catch((err) => {
        logger.error('[Startup] Failed to initialize account manager:', err);
    });

    // Start listening
    await proxyServer.start(PORT);

    // Clear console for a clean start
    console.clear();

    const border = '║';
    const align = (text) => text + ' '.repeat(Math.max(0, 60 - text.length));
    const align4 = (text) => text + ' '.repeat(Math.max(0, 58 - text.length));

    // Build Control section dynamically
    const strategyOptions = `(${STRATEGY_NAMES.join('/')})`;
    const strategyLine2 = '                       ' + strategyOptions;
    let controlSection = '║  Control:                                                    ║\n';
    controlSection += '║    --strategy=<s>     Set account selection strategy         ║\n';
    controlSection += `${border}  ${align(strategyLine2)}${border}\n`;
    if (!isDebug) {
        controlSection += '║    --debug            Enable debug logging                   ║\n';
    }
    if (!isFallbackEnabled) {
        controlSection += '║    --fallback         Enable model fallback on quota exhaust ║\n';
    }
    controlSection += '║    Ctrl+C             Stop server                            ║';

    // Get the strategy label
    const strategyLabel = accountManager.getStrategyLabel();

    // Build status section
    let statusSection = '║                                                              ║\n';
    statusSection += '║  Active Modes:                                               ║\n';
    statusSection += `${border}    ${align4(`✓ Strategy: ${strategyLabel}`)}${border}\n`;
    if (isDebug) {
        statusSection += '║    ✓ Debug mode enabled                                      ║\n';
    }
    if (isFallbackEnabled) {
        statusSection += '║    ✓ Model fallback enabled                                  ║\n';
    }

    logger.log(`
╔══════════════════════════════════════════════════════════════╗
║           Antigravity Claude Proxy Server                    ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
${border}  ${align(`Server and WebUI running at: http://localhost:${PORT}`)}${border}
${statusSection}║                                                              ║
${controlSection}
║                                                              ║
║  Endpoints:                                                  ║
║    POST /v1/messages         - Anthropic Messages API        ║
║    GET  /v1/models           - List available models         ║
║    GET  /health              - Health check                  ║
║    GET  /account-limits      - Account status & quotas       ║
║    POST /refresh-token       - Force token refresh           ║
║                                                              ║
${border}  ${align(`Configuration:`)}${border}
${border}    ${align4(`Storage: ${CONFIG_DIR}`)}${border}
║                                                              ║
║  Usage with Claude Code:                                     ║
${border}    ${align4(`export ANTHROPIC_BASE_URL=http://localhost:${PORT}`)}${border}
║    export ANTHROPIC_API_KEY=dummy                            ║
║    claude                                                    ║
║                                                              ║
║  Add Google accounts:                                        ║
║    npm run accounts                                          ║
║                                                              ║
║  Prerequisites (if no accounts configured):                  ║
║    - Antigravity must be running                             ║
║    - Have a chat panel open in Antigravity                   ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);

    logger.success(`Server started successfully on port ${PORT}`);
    if (isDebug) {
        logger.warn('Running in DEBUG mode - verbose logs enabled');
    }
}

main().catch((err) => {
    logger.error('Fatal error starting server:', err);
    process.exit(1);
});

import { closeDatabase } from './auth/database.js';

// Graceful shutdown
const shutdown = async () => {
    logger.info('Shutting down server...');
    await proxyServer.stop();
    // Close shared database connection
    closeDatabase();
    logger.success('Server stopped');
    process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
