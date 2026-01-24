/**
 * Message Handler for Cloud Code
 *
 * Handles non-streaming message requests with multi-account support,
 * retry logic, and endpoint failover.
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    MAX_RETRIES,
    MAX_WAIT_BEFORE_ERROR_MS,
    MAX_CONSECUTIVE_FAILURES,
    EXTENDED_COOLDOWN_MS,
    CAPACITY_BACKOFF_TIERS_MS,
    MAX_CAPACITY_RETRIES,
    CAPACITY_RETRY_DELAY_MS,
    isThinkingModel
} from '../constants.js';
import { convertGoogleToAnthropic } from '../format/index.js';
import { isRateLimitError, isAuthError } from '../errors.js';
import { formatDuration, sleep, isNetworkError } from '../utils/helpers.js';
import { fetchWithTimeout } from './fetch-utils.js';
import { logger } from '../utils/logger.js';
import { parseResetTime, parseRateLimitReason } from './rate-limit-parser.js';
import { buildCloudCodeRequest, buildHeaders } from './request-builder.js';
import { parseThinkingSSEResponse } from './sse-parser.js';
import { getFallbackModel } from '../fallback-config.js';
import {
    getRateLimitBackoff,
    clearRateLimitState,
    isPermanentAuthFailure,
    isModelCapacityExhausted,
    calculateSmartBackoff
} from './retry-utils.js';

/**
 * Send a non-streaming request to Cloud Code with multi-account support
 * Uses SSE endpoint for thinking models (non-streaming doesn't return thinking blocks)
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {Object} anthropicRequest.model - Model name to use
 * @param {Array} anthropicRequest.messages - Array of message objects
 * @param {number} [anthropicRequest.max_tokens] - Maximum tokens to generate
 * @param {Object} [anthropicRequest.thinking] - Thinking configuration
 * @param {import('../account-manager/index.js').default} accountManager - The account manager instance
 * @returns {Promise<Object>} Anthropic-format response object
 * @throws {Error} If max retries exceeded or no accounts available
 */
export async function sendMessage(anthropicRequest, accountManager, fallbackEnabled = false) {
    const model = anthropicRequest.model;
    const isThinking = isThinkingModel(model);

    // Retry loop with account failover
    // Ensure we try at least as many times as there are accounts to cycle through everyone
    const maxAttempts = Math.max(MAX_RETRIES, accountManager.getAccountCount() + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Clear any expired rate limits before picking
        accountManager.clearExpiredLimits();

        // Get available accounts for this model
        const availableAccounts = accountManager.getAvailableAccounts(model);

        // If no accounts available, check if we should wait or throw error
        if (availableAccounts.length === 0) {
            if (accountManager.isAllRateLimited(model)) {
                const minWaitMs = accountManager.getMinWaitTimeMs(model);
                const resetTime = new Date(Date.now() + minWaitMs).toISOString();

                // If wait time is too long (> 2 minutes), try fallback first, then throw error
                if (minWaitMs > MAX_WAIT_BEFORE_ERROR_MS) {
                    // Check if fallback is enabled and available
                    if (fallbackEnabled) {
                        const fallbackModel = getFallbackModel(model);
                        if (fallbackModel) {
                            logger.warn(
                                `[CloudCode] All accounts exhausted for ${model} (${formatDuration(minWaitMs)} wait). Attempting fallback to ${fallbackModel}`
                            );
                            const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
                            // Pass fallbackEnabled to allow chaining
                            return await sendMessage(
                                fallbackRequest,
                                accountManager,
                                fallbackEnabled
                            );
                        }
                    }
                    throw new Error(
                        `RESOURCE_EXHAUSTED: Rate limited on ${model}. Quota will reset after ${formatDuration(minWaitMs)}. Next available: ${resetTime}`
                    );
                }

                // Wait for shortest reset time
                const accountCount = accountManager.getAccountCount();
                logger.warn(
                    `[CloudCode] All ${accountCount} account(s) rate-limited. Waiting ${formatDuration(minWaitMs)}...`
                );
                await sleep(minWaitMs + 500); // Add 500ms buffer
                accountManager.clearExpiredLimits();
                attempt--; // Don't count this wait as a retry attempt
                continue; // Retry the loop
            }

            // No accounts available and not rate-limited (shouldn't happen normally)
            throw new Error('No accounts available for ' + model);
        }

        // Select account using configured strategy
        const { account, waitMs } = accountManager.selectAccount(model);

        // If strategy returns a wait time, sleep and retry
        if (!account && waitMs > 0) {
            logger.info(`[CloudCode] Waiting ${formatDuration(waitMs)} for account...`);
            await sleep(waitMs + 500);
            continue;
        }

        // Safety: If no account and no wait time (shouldn't happen with fixed strategy, but good defense)
        if (!account) {
            logger.warn(
                '[CloudCode] No account selected and no wait time provided. Forcing 1s sleep to prevent loop.'
            );
            await sleep(1000);
            continue;
        }

        try {
            // Get token and project for this account
            let token = await accountManager.getTokenForAccount(account);
            let project = await accountManager.getProjectForAccount(account, token);
            let payload = buildCloudCodeRequest(anthropicRequest, project);

            logger.debug(`[CloudCode] Sending request for model: ${model}`);

            // Try each endpoint with index-based loop for capacity retry support
            let lastError = null;
            let capacityRetryCount = 0; // Gap 4: Track capacity exhaustion retries
            let endpointIndex = 0;

            while (endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length) {
                const endpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointIndex];
                try {
                    const url = isThinking
                        ? `${endpoint}/v1internal:streamGenerateContent?alt=sse`
                        : `${endpoint}/v1internal:generateContent`;

                    const response = await fetchWithTimeout(
                        // Using fetchWithTimeout from internal utils
                        url,
                        {
                            method: 'POST',
                            headers: buildHeaders(
                                token,
                                model,
                                isThinking ? 'text/event-stream' : 'application/json'
                            ),
                            body: JSON.stringify(payload)
                        },
                        300000 // 5m timeout
                    );

                    if (!response.ok) {
                        const errorText = await response.text();
                        logger.warn(
                            `[CloudCode] Error at ${endpoint}: ${response.status} - ${errorText}`
                        );

                        if (response.status === 401) {
                            // Gap 3: Check for permanent auth failures
                            if (isPermanentAuthFailure(errorText)) {
                                logger.error(
                                    `[CloudCode] Permanent auth failure for ${account.email}: ${errorText.substring(0, 100)}`
                                );
                                accountManager.markInvalid(
                                    account.email,
                                    'Token revoked - re-authentication required'
                                );
                                throw new Error(`AUTH_INVALID_PERMANENT: ${errorText}`);
                            }

                            // Transient auth error - clear caches and retry with fresh token
                            logger.warn('[CloudCode] Transient auth error, refreshing token...');
                            accountManager.clearTokenCache(account.email);
                            accountManager.clearProjectCache(account.email);
                            token = await accountManager.getTokenForAccount(account);
                            project = await accountManager.getProjectForAccount(account, token);
                            payload = buildCloudCodeRequest(anthropicRequest, project);
                            // Advance endpoint to avoid tight loop on repeated 401s
                            endpointIndex++;
                            continue;
                        }

                        if (response.status === 429) {
                            const resetMs = parseResetTime(response, errorText);

                            // Gap 4: Check if capacity issue (NOT quota) - retry SAME endpoint
                            if (isModelCapacityExhausted(errorText)) {
                                if (capacityRetryCount < MAX_CAPACITY_RETRIES) {
                                    capacityRetryCount++;
                                    const waitMs =
                                        resetMs ||
                                        CAPACITY_BACKOFF_TIERS_MS[capacityRetryCount - 1] ||
                                        CAPACITY_RETRY_DELAY_MS;
                                    logger.info(
                                        `[CloudCode] Model capacity exhausted, retry ${capacityRetryCount}/${MAX_CAPACITY_RETRIES} after ${formatDuration(waitMs)}...`
                                    );
                                    await sleep(waitMs);
                                    // Don't increment endpointIndex - retry same endpoint
                                    continue;
                                }
                                // Max capacity retries exceeded - treat as quota exhaustion
                                logger.warn(
                                    `[CloudCode] Max capacity retries (${MAX_CAPACITY_RETRIES}) exceeded, switching account`
                                );
                            }

                            // Calculate smart backoff based on error type
                            const { attempt: failAttempt } = getRateLimitBackoff(
                                account.email,
                                model,
                                resetMs
                            );
                            const smartWaitMs = calculateSmartBackoff(
                                errorText,
                                resetMs,
                                failAttempt
                            );

                            // Log detailed 429 info
                            logger.info(
                                `[CloudCode] Rate limit for ${account.email} on ${model} (Reason: ${parseRateLimitReason(errorText)}), Waiting ${formatDuration(smartWaitMs)} then switching...`
                            );

                            // Mark as rate limited with smart wait time
                            accountManager.markRateLimited(account.email, smartWaitMs, model);
                            throw new Error(`RATE_LIMITED: ${errorText}`);
                        }

                        if (response.status >= 500) {
                            logger.warn(
                                `[CloudCode] Server error ${response.status}, waiting 1s...`
                            );
                            await sleep(1000);
                            endpointIndex++;
                            continue;
                        }

                        if (response.status >= 400) {
                            lastError = new Error(`API error ${response.status}: ${errorText}`);
                            // Try next endpoint for 403/404
                            endpointIndex++;
                            continue;
                        }
                    }

                    // For thinking models, parse SSE and accumulate all parts
                    if (isThinking) {
                        const result = await parseThinkingSSEResponse(
                            response,
                            anthropicRequest.model
                        );
                        // Clear rate limit state on success
                        clearRateLimitState(account.email, model);
                        accountManager.notifySuccess(account, model);
                        return result;
                    }

                    // Non-thinking models use regular JSON
                    const data = await response.json();
                    logger.debug('[CloudCode] Response received');
                    // Clear rate limit state on success
                    clearRateLimitState(account.email, model);
                    accountManager.notifySuccess(account, model);
                    return convertGoogleToAnthropic(data, anthropicRequest.model);
                } catch (endpointError) {
                    if (isRateLimitError(endpointError)) {
                        throw endpointError; // Re-throw to trigger account switch
                    }
                    if (endpointError.message.includes('AUTH_INVALID_PERMANENT')) {
                        throw endpointError; // Re-throw fatal auth error
                    }

                    logger.warn(`[CloudCode] Error at ${endpoint}:`, endpointError.message);
                    lastError = endpointError;
                    endpointIndex++;
                }
            }

            // If all endpoints failed for this account
            if (lastError) {
                if (lastError.is429) {
                    // Already handled in loop, but just in case
                    throw lastError;
                }
                throw lastError;
            }
        } catch (error) {
            if (isRateLimitError(error)) {
                // Rate limited - already marked, notify strategy and continue to next account
                accountManager.notifyRateLimit(account, model);
                logger.info(`[CloudCode] Account ${account.email} rate-limited, trying next...`);
                continue;
            }
            if (isAuthError(error)) {
                // Auth invalid - already marked, continue to next account
                logger.warn(
                    `[CloudCode] Account ${account.email} has invalid credentials, trying next...`
                );
                continue;
            }
            // Handle 5xx errors
            if (
                error.message.includes('API error 5') ||
                error.message.includes('500') ||
                error.message.includes('503')
            ) {
                accountManager.notifyFailure(account, model);

                // Gap 2: Check consecutive failures for extended cooldown
                const healthTracker = accountManager.getHealthTracker();
                const consecutiveFailures = healthTracker
                    ? healthTracker.getConsecutiveFailures(account.email)
                    : 0;

                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    logger.warn(
                        `[CloudCode] Account ${account.email} has ${consecutiveFailures} consecutive failures, applying extended cooldown (${formatDuration(EXTENDED_COOLDOWN_MS)})`
                    );
                    accountManager.markRateLimited(account.email, EXTENDED_COOLDOWN_MS, model);
                } else {
                    logger.warn(
                        `[CloudCode] Account ${account.email} failed with 5xx error, trying next...`
                    );
                }
                continue;
            }

            if (isNetworkError(error)) {
                accountManager.notifyFailure(account, model);

                // Gap 2: Check consecutive failures for extended cooldown
                const healthTracker = accountManager.getHealthTracker();
                const consecutiveFailures = healthTracker
                    ? healthTracker.getConsecutiveFailures(account.email)
                    : 0;

                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    logger.warn(
                        `[CloudCode] Account ${account.email} has ${consecutiveFailures} consecutive network failures, applying extended cooldown (${formatDuration(EXTENDED_COOLDOWN_MS)})`
                    );
                    accountManager.markRateLimited(account.email, EXTENDED_COOLDOWN_MS, model);
                } else {
                    logger.warn(
                        `[CloudCode] Network error for ${account.email}, trying next account... (${error.message})`
                    );
                }
                await sleep(1000);
                continue;
            }

            throw error;
        }
    }

    // All retries exhausted - try fallback model if enabled
    if (fallbackEnabled) {
        const fallbackModel = getFallbackModel(model);
        if (fallbackModel) {
            logger.warn(
                `[CloudCode] All retries exhausted for ${model}. Attempting fallback to ${fallbackModel}`
            );
            const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
            // Pass fallbackEnabled to allow chaining
            return await sendMessage(fallbackRequest, accountManager, fallbackEnabled);
        }
    }

    throw new Error('Max retries exceeded');
}
