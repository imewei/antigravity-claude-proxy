/**
 * Streaming Handler for Cloud Code
 *
 * Handles streaming message requests with multi-account support,
 * retry logic, and endpoint failover.
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    MAX_RETRIES,
    MAX_EMPTY_RESPONSE_RETRIES,
    MAX_WAIT_BEFORE_ERROR_MS,
    MAX_CONSECUTIVE_FAILURES,
    EXTENDED_COOLDOWN_MS,
    CAPACITY_BACKOFF_TIERS_MS,
    MAX_CAPACITY_RETRIES,
    CAPACITY_RETRY_DELAY_MS,
    REQUEST_TIMEOUT_MS
} from '../constants.js';
import { isRateLimitError, isAuthError, isEmptyResponseError } from '../errors.js';
import {
    formatDuration,
    sleep,
    isNetworkError,
    isTimeoutError,
    getExponentialBackoffMs
} from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { parseResetTime, parseRateLimitReason } from './rate-limit-parser.js';
import { buildCloudCodeRequest, buildHeaders } from './request-builder.js';
import { streamSSEResponse } from './sse-streamer.js';
import { getFallbackModel } from '../fallback-config.js';
import crypto from 'node:crypto';
import { fetchWithTimeout } from './fetch-utils.js';
import { mockMessageStream } from './mock-stream-handler.js';
import {
    getRateLimitBackoff,
    clearRateLimitState,
    isPermanentAuthFailure,
    isModelCapacityExhausted,
    calculateSmartBackoff
} from './retry-utils.js';

/**
 * Send a streaming request to Cloud Code with multi-account support
 * Streams events in real-time as they arrive from the server
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} anthropicRequest.model - Model name to use
 * @param {Array} anthropicRequest.messages - Array of message objects
 * @param {number} [anthropicRequest.max_tokens] - Maximum tokens to generate
 * @param {Object} [anthropicRequest.thinking] - Thinking configuration
 * @param {import('../account-manager/index.js').default} accountManager - The account manager instance
 * @yields {Object} Anthropic-format SSE events (message_start, content_block_start, content_block_delta, etc.)
 * @throws {Error} If max retries exceeded or no accounts available
 */
export async function* sendMessageStream(
    anthropicRequest,
    accountManager,
    fallbackEnabled = false,
    signal = null
) {
    if (process.env.MOCK_UPSTREAM === 'true') {
        yield* mockMessageStream(anthropicRequest);
        return;
    }

    const model = anthropicRequest.model;

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
                                `[CloudCode] All accounts exhausted for ${model} (${formatDuration(minWaitMs)} wait). Attempting fallback to ${fallbackModel} (streaming)`
                            );
                            const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
                            // Pass fallbackEnabled=true (or inherit) to allow chaining
                            yield* sendMessageStream(
                                fallbackRequest,
                                accountManager,
                                fallbackEnabled,
                                signal
                            );
                            return;
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

            logger.debug(`[CloudCode] Starting stream for model: ${model}`);

            // Try each endpoint with index-based loop for capacity retry support
            let lastError = null;
            let capacityRetryCount = 0; // Gap 4: Track capacity exhaustion retries
            let endpointIndex = 0;

            while (endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length) {
                const endpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointIndex];
                try {
                    const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;

                    const response = await fetchWithTimeout(
                        url,
                        {
                            method: 'POST',
                            headers: buildHeaders(token, model, 'text/event-stream'),
                            body: JSON.stringify(payload)
                        },
                        REQUEST_TIMEOUT_MS,
                        signal
                    );

                    if (!response.ok) {
                        const errorText = await response.text();
                        logger.warn(
                            `[CloudCode] Stream error at ${endpoint}: ${response.status} - ${errorText}`
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

                            // Transient auth error - clear caches and retry
                            accountManager.clearTokenCache(account.email);
                            accountManager.clearProjectCache(account.email);
                            token = await accountManager.getTokenForAccount(account);
                            project = await accountManager.getProjectForAccount(account, token);
                            payload = buildCloudCodeRequest(anthropicRequest, project);
                            endpointIndex++;
                            continue;
                        }

                        if (
                            response.status === 429 ||
                            response.status === 503 ||
                            isModelCapacityExhausted(errorText)
                        ) {
                            // Gap 4: Check if capacity issue (NOT quota) - retry SAME endpoint
                            // 503 is almost always capacity/overload, 429 can be both
                            if (isModelCapacityExhausted(errorText) || response.status === 503) {
                                if (capacityRetryCount < MAX_CAPACITY_RETRIES) {
                                    capacityRetryCount++;
                                    const resetMs = parseResetTime(response, errorText);
                                    const waitMs =
                                        resetMs ||
                                        CAPACITY_BACKOFF_TIERS_MS[capacityRetryCount - 1] ||
                                        CAPACITY_RETRY_DELAY_MS;
                                    logger.info(
                                        `[CloudCode] Model capacity exhausted (${response.status}), retry ${capacityRetryCount}/${MAX_CAPACITY_RETRIES} after ${formatDuration(waitMs)}...`
                                    );
                                    await sleep(waitMs);
                                    // Don't increment endpointIndex - retry same endpoint
                                    continue;
                                }
                                // Max capacity retries exceeded - treat as quota exhaustion if it was 429,
                                // or just fail/switch if it was 503
                                logger.warn(
                                    `[CloudCode] Max capacity retries (${MAX_CAPACITY_RETRIES}) exceeded`
                                );
                            }

                            // If it's a 429 (Quota/Rate Limit), handle smart backoff and account switch
                            if (response.status === 429) {
                                const resetMs = parseResetTime(response, errorText);

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

                                logger.info(
                                    `[CloudCode] Rate limit for ${account.email} on ${model} (Reason: ${parseRateLimitReason(errorText)}), Waiting ${formatDuration(smartWaitMs)} then switching...`
                                );

                                accountManager.markRateLimited(account.email, smartWaitMs, model);
                                throw new Error(`RATE_LIMITED: ${errorText}`);
                            }
                        }

                        lastError = new Error(`API error ${response.status}: ${errorText}`);

                        // Try next endpoint for 403/404/5xx errors (if not handled above as capacity)
                        if (response.status === 403 || response.status === 404) {
                            logger.warn(`[CloudCode] ${response.status} at ${endpoint}...`);
                        } else if (response.status >= 500) {
                            logger.warn(
                                `[CloudCode] ${response.status} stream error, waiting 1s before retry...`
                            );
                            await sleep(1000);
                        }

                        endpointIndex++;
                        continue;
                    }

                    // Stream the response with retry logic for empty responses
                    let currentResponse = response;

                    for (
                        let emptyRetries = 0;
                        emptyRetries <= MAX_EMPTY_RESPONSE_RETRIES;
                        emptyRetries++
                    ) {
                        try {
                            yield* streamSSEResponse(currentResponse, anthropicRequest.model);
                            logger.debug('[CloudCode] Stream completed');
                            // Clear rate limit state on success
                            clearRateLimitState(account.email, model);
                            accountManager.notifySuccess(account, model);
                            return;
                        } catch (streamError) {
                            // Only retry on EmptyResponseError
                            if (!isEmptyResponseError(streamError)) {
                                throw streamError;
                            }

                            // Check if we have retries left
                            if (emptyRetries >= MAX_EMPTY_RESPONSE_RETRIES) {
                                logger.error(
                                    `[CloudCode] Empty response after ${MAX_EMPTY_RESPONSE_RETRIES} retries`
                                );
                                yield* emitEmptyResponseFallback(anthropicRequest.model);
                                return;
                            }

                            // Exponential backoff
                            const backoffMs = getExponentialBackoffMs(500, emptyRetries);
                            logger.warn(
                                `[CloudCode] Empty response, retry ${emptyRetries + 1}/${MAX_EMPTY_RESPONSE_RETRIES} after ${backoffMs}ms...`
                            );
                            await sleep(backoffMs);

                            // Refetch the response
                            currentResponse = await fetchWithTimeout(
                                url,
                                {
                                    method: 'POST',
                                    headers: buildHeaders(token, model, 'text/event-stream'),
                                    body: JSON.stringify(payload)
                                },
                                REQUEST_TIMEOUT_MS,
                                signal
                            );

                            // Handle specific error codes on retry
                            if (!currentResponse.ok) {
                                const retryErrorText = await currentResponse.text();

                                // Rate limit error
                                if (currentResponse.status === 429) {
                                    const resetMs = parseResetTime(currentResponse, retryErrorText);
                                    accountManager.markRateLimited(account.email, resetMs, model);
                                    throw new Error(
                                        `429 RESOURCE_EXHAUSTED during retry: ${retryErrorText}`
                                    );
                                }

                                // Auth error
                                if (currentResponse.status === 401) {
                                    if (isPermanentAuthFailure(retryErrorText)) {
                                        logger.error(
                                            `[CloudCode] Permanent auth failure during retry for ${account.email}`
                                        );
                                        accountManager.markInvalid(
                                            account.email,
                                            'Token revoked - re-authentication required'
                                        );
                                        throw new Error(
                                            `AUTH_INVALID_PERMANENT: ${retryErrorText}`
                                        );
                                    }
                                    accountManager.clearTokenCache(account.email);
                                    accountManager.clearProjectCache(account.email);
                                    throw new Error(
                                        `401 AUTH_INVALID during retry: ${retryErrorText}`
                                    );
                                }

                                // For 5xx errors, continue retrying
                                if (currentResponse.status >= 500) {
                                    logger.warn(
                                        `[CloudCode] Retry got ${currentResponse.status}, will retry...`
                                    );
                                    await sleep(1000);
                                    currentResponse = await fetchWithTimeout(
                                        url,
                                        {
                                            method: 'POST',
                                            headers: buildHeaders(
                                                token,
                                                model,
                                                'text/event-stream'
                                            ),
                                            body: JSON.stringify(payload)
                                        },
                                        REQUEST_TIMEOUT_MS,
                                        signal
                                    );
                                    if (currentResponse.ok) {
                                        continue;
                                    }
                                }

                                throw new Error(
                                    `Empty response retry failed: ${currentResponse.status} - ${retryErrorText}`
                                );
                            }
                        }
                    }
                } catch (endpointError) {
                    if (isRateLimitError(endpointError)) {
                        throw endpointError; // Re-throw to trigger account switch
                    }
                    if (isEmptyResponseError(endpointError)) {
                        throw endpointError;
                    }
                    if (endpointError.message.includes('AUTH_INVALID_PERMANENT')) {
                        throw endpointError;
                    }
                    logger.warn(`[CloudCode] Stream error at ${endpoint}:`, endpointError.message);
                    lastError = endpointError;
                    endpointIndex++;
                }
            }

            // If all endpoints failed for this account
            if (lastError) {
                if (lastError.is429) {
                    // Already handled in loop
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
                const consecutiveFailures =
                    accountManager.getHealthTracker()?.getConsecutiveFailures(account.email) || 0;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    logger.warn(
                        `[CloudCode] Account ${account.email} has ${consecutiveFailures} consecutive failures, applying extended cooldown (${formatDuration(EXTENDED_COOLDOWN_MS)})`
                    );
                    accountManager.markRateLimited(account.email, EXTENDED_COOLDOWN_MS, model);
                } else {
                    logger.warn(
                        `[CloudCode] Account ${account.email} failed with 5xx stream error, trying next...`
                    );
                }
                continue;
            }

            if (isNetworkError(error)) {
                if (isTimeoutError(error)) {
                    logger.warn(
                        `[CloudCode] Request timeout for ${account.email} (stream), trying next account...`
                    );
                }
                accountManager.notifyFailure(account, model);

                // Gap 2: Check consecutive failures for extended cooldown
                const consecutiveFailures =
                    accountManager.getHealthTracker()?.getConsecutiveFailures(account.email) || 0;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    logger.warn(
                        `[CloudCode] Account ${account.email} has ${consecutiveFailures} consecutive network failures, applying extended cooldown (${formatDuration(EXTENDED_COOLDOWN_MS)})`
                    );
                    accountManager.markRateLimited(account.email, EXTENDED_COOLDOWN_MS, model);
                } else {
                    logger.warn(
                        `[CloudCode] Network error for ${account.email} (stream), trying next account... (${error.message})`
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
                `[CloudCode] All retries exhausted for ${model}. Attempting fallback to ${fallbackModel} (streaming)`
            );
            const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
            // Pass fallbackEnabled=true (or inherit) to allow chaining
            yield* sendMessageStream(fallbackRequest, accountManager, fallbackEnabled, signal);
            return;
        }
    }

    throw new Error('Max retries exceeded');
}

/**
 * Emit a fallback message when all retry attempts fail with empty response
 * @param {string} model - The model name
 * @yields {Object} Anthropic-format SSE events for empty response fallback
 */
function* emitEmptyResponseFallback(model) {
    // Use proper message ID format consistent with Anthropic API
    const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`;

    yield {
        type: 'message_start',
        message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
        }
    };

    yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
    };

    yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '[No response after retries - please try again]' }
    };

    yield { type: 'content_block_stop', index: 0 };

    yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 }
    };

    yield { type: 'message_stop' };
}
