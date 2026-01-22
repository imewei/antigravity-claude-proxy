/**
 * Express Server - Anthropic-compatible API
 * Proxies to Google Cloud Code via Antigravity
 * Supports multi-account load balancing
 */

import { ProxyServer } from './server/ProxyServer.js';

// Create singleton instance for backward compatibility and testing
const proxyServer = new ProxyServer();
const app = proxyServer.app;
const accountManager = proxyServer.accountManager;

// Export for consumption by index.js and tests
export { proxyServer, app, accountManager };