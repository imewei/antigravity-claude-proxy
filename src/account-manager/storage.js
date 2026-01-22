/**
 * Account Storage
 *
 * Handles loading and saving account configuration to disk.
 */

import { writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.js';
// ...
// Inside saveAccounts
export async function saveAccounts(configPath, accounts, settings, activeIndex) {
    try {
        // Ensure directory exists
        const dir = path.dirname(configPath);
        await mkdir(dir, { recursive: true });

        const config = {
            accounts: accounts.map(acc => ({
                email: acc.email,
                source: acc.source,
                enabled: acc.enabled !== false, // Persist enabled state
                dbPath: acc.dbPath || null,
                refreshToken: acc.source === 'oauth' ? acc.refreshToken : undefined,
                apiKey: acc.source === 'manual' ? acc.apiKey : undefined,
                projectId: acc.projectId || undefined,
                addedAt: acc.addedAt || undefined,
                isInvalid: acc.isInvalid || false,
                invalidReason: acc.invalidReason || null,
                modelRateLimits: acc.modelRateLimits || {},
                lastUsed: acc.lastUsed,
                // Persist subscription and quota data
                subscription: acc.subscription || { tier: 'unknown', projectId: null, detectedAt: null },
                quota: acc.quota || { models: {}, lastChecked: null }
            })),
            settings: settings,
            activeIndex: activeIndex
        };

        // Atomic write: write to .tmp file then rename
        const tempPath = `${configPath}.tmp`;
        await writeFile(tempPath, JSON.stringify(config, null, 2));
        await rename(tempPath, configPath);
    } catch (error) {
        logger.error('[AccountManager] Failed to save config:', error.message);
    }
}
