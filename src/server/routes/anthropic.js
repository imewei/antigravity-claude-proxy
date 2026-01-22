import { Router } from 'express';
import { sendMessage, sendMessageStream } from '../../cloudcode/index.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

/**
 * Parse error message to extract error type, status code, and user-friendly message
 */
function parseError(error) {
    let errorType = 'api_error';
    let statusCode = 500;
    let errorMessage = error.message;

    if (error.message.includes('401') || error.message.includes('UNAUTHENTICATED')) {
        errorType = 'authentication_error';
        statusCode = 401;
        errorMessage =
            'Authentication failed. Make sure Antigravity is running with a valid token.';
    } else if (
        error.message.includes('429') ||
        error.message.includes('RESOURCE_EXHAUSTED') ||
        error.message.includes('QUOTA_EXHAUSTED')
    ) {
        errorType = 'invalid_request_error'; // Use invalid_request_error to force client to purge/stop
        statusCode = 400; // Use 400 to ensure client does not retry (429 and 529 trigger retries)

        // Try to extract the quota reset time from the error
        const resetMatch = error.message.match(/quota will reset after ([\dh\dm\ds]+)/i);
        // Try to extract model from our error format "Rate limited on <model>" or JSON format
        const modelMatch =
            error.message.match(/Rate limited on ([^.]+)\./) ||
            error.message.match(/"model":\s*"([^"]+)"/);
        const model = modelMatch ? modelMatch[1] : 'the model';

        if (resetMatch) {
            errorMessage = `You have exhausted your capacity on ${model}. Quota will reset after ${resetMatch[1]}.`;
        } else {
            errorMessage = `You have exhausted your capacity on ${model}. Please wait for your quota to reset.`;
        }
    } else if (
        error.message.includes('invalid_request_error') ||
        error.message.includes('INVALID_ARGUMENT')
    ) {
        errorType = 'invalid_request_error';
        statusCode = 400;
        const msgMatch = error.message.match(/"message":"([^"]+)"/);
        if (msgMatch) errorMessage = msgMatch[1];
    } else if (error.message.includes('All endpoints failed')) {
        errorType = 'api_error';
        statusCode = 503;
        errorMessage = 'Unable to connect to Claude API. Check that Antigravity is running.';
    } else if (error.message.includes('PERMISSION_DENIED')) {
        errorType = 'permission_error';
        statusCode = 403;
        errorMessage = 'Permission denied. Check your Antigravity license.';
    }

    return { errorType, statusCode, errorMessage };
}

/**
 * Create Anthropic Messages Router
 * @param {Object} context - Server context
 * @param {AccountManager} context.accountManager - Account manager instance
 * @param {Function} context.ensureInitialized - Async function to ensure initialization
 * @param {boolean} context.fallbackEnabled - Whether fallback is enabled
 * @returns {Router} Express router
 */
export function createAnthropicRouter({
    accountManager,
    ensureInitialized,
    fallbackEnabled,
    registerStream
}) {
    const router = Router();

    /**
     * Count tokens endpoint - Anthropic Messages API compatible
     */
    router.post('/messages/count_tokens', (req, res) => {
        try {
            const { messages, system } = req.body;
            let totalChars = 0;

            // Count system prompt
            if (system) {
                if (typeof system === 'string') totalChars += system.length;
                else if (Array.isArray(system)) {
                    totalChars += system
                        .filter((p) => p.text)
                        .reduce((acc, p) => acc + p.text.length, 0);
                }
            }

            // Count messages
            if (messages && Array.isArray(messages)) {
                for (const msg of messages) {
                    if (typeof msg.content === 'string') {
                        totalChars += msg.content.length;
                    } else if (Array.isArray(msg.content)) {
                        for (const part of msg.content) {
                            if (part.type === 'text' && part.text) {
                                totalChars += part.text.length;
                            } else if (part.type === 'image' && part.source?.data) {
                                // Rough estimate for base64 image: 1000 tokens per image?
                                // Cloud Code doesn't "count" image tokens the same way, but let's be conservative
                                totalChars += 1000 * 3.5;
                            }
                        }
                    }
                }
            }

            // Heuristic: ~3.5 chars per token for code/text mix
            const estimatedTokens = Math.ceil(totalChars / 3.5);

            res.json({ input_tokens: estimatedTokens });
        } catch (error) {
            logger.error('[API] Error in count_tokens heuristic:', error);
            res.status(500).json({
                type: 'error',
                error: { type: 'api_error', message: 'Failed to count tokens' }
            });
        }
    });

    /**
     * Anthropic-compatible Messages API
     * POST /v1/messages
     */
    router.post('/messages', async (req, res) => {
        const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 5)}`;
        const reqLogger = logger.child({ requestId });

        try {
            // Ensure account manager is initialized
            await ensureInitialized();

            const {
                model,
                messages,
                stream,
                system,
                max_tokens,
                tools,
                tool_choice,
                thinking,
                top_p,
                top_k,
                temperature
            } = req.body;

            // Resolve model mapping if configured
            let requestedModel = model || 'claude-3-5-sonnet-20241022';
            const modelMapping = config.modelMapping || {};
            if (modelMapping[requestedModel] && modelMapping[requestedModel].mapping) {
                const targetModel = modelMapping[requestedModel].mapping;
                reqLogger.info(`[Server] Mapping model ${requestedModel} -> ${targetModel}`);
                requestedModel = targetModel;
            }

            const modelId = requestedModel;
            // Update logger context with resolved model
            reqLogger.setContext({ model: modelId });

            // Optimistic Retry: If ALL accounts are rate-limited for this model, reset them to force a fresh check.
            if (accountManager.isAllRateLimited(modelId)) {
                reqLogger.warn(
                    `[Server] All accounts rate-limited for ${modelId}. Resetting state for optimistic retry.`
                );
                accountManager.resetAllRateLimits();
            }

            // Validate required fields
            if (!messages || !Array.isArray(messages)) {
                return res.status(400).json({
                    type: 'error',
                    error: {
                        type: 'invalid_request_error',
                        message: 'messages is required and must be an array'
                    }
                });
            }

            // Build the request object
            const request = {
                model: modelId,
                messages,
                max_tokens: max_tokens || 4096,
                stream,
                system,
                tools,
                tool_choice,
                thinking,
                top_p,
                top_k,
                temperature
            };

            reqLogger.info(`[API] Request for model: ${request.model}, stream: ${!!stream}`);

            if (logger.isDebugEnabled) {
                reqLogger.debug('[API] Message structure:');
                messages.forEach((msg, i) => {
                    const contentTypes = Array.isArray(msg.content)
                        ? msg.content.map((c) => c.type || 'text').join(', ')
                        : typeof msg.content === 'string'
                            ? 'text'
                            : 'unknown';
                    reqLogger.debug(`  [${i}] ${msg.role}: ${contentTypes}`);
                });
            }

            if (stream) {
                if (registerStream) registerStream(res);
                // Handle streaming response
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');

                // Flush headers immediately to start the stream
                res.flushHeaders();

                // Create AbortController for this request
                const controller = new AbortController();
                const signal = controller.signal;

                // Handle client disconnection
                req.on('close', () => {
                    if (!res.writableEnded) {
                        reqLogger.info(`[API] Client disconnected during stream (model: ${modelId})`);
                        controller.abort();
                    }
                });

                try {
                    // Use the streaming generator with account manager
                    for await (const event of sendMessageStream(
                        request,
                        accountManager,
                        fallbackEnabled,
                        signal
                    )) {
                        if (signal.aborted) break;
                        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                        // Flush after each event for real-time streaming
                        if (res.flush) res.flush();
                    }
                    res.write('event: ping\ndata: {}\n\n'); // Keep alive
                    res.end();
                } catch (streamError) {
                    if (
                        streamError.name === 'AbortError' ||
                        streamError.message.includes('aborted')
                    ) {
                        reqLogger.info('[API] Stream aborted by client');
                        res.end();
                        return;
                    }

                    // Handle EPIPE/ECONNRESET (client closed connection while writing)
                    if (streamError.code === 'EPIPE' || streamError.code === 'ECONNRESET') {
                        reqLogger.info('[API] Stream connection closed by client (EPIPE/ECONNRESET)');
                        res.end();
                        return;
                    }

                    reqLogger.error('[API] Stream error:', streamError);

                    const { errorType, statusCode, errorMessage } = parseError(streamError);

                    // If we haven't sent any events yet, we can send a proper JSON error
                    // But if we're streaming, we should send an SSE error event
                    if (!res.headersSent) {
                        res.status(statusCode).json({
                            type: 'error',
                            error: { type: errorType, message: errorMessage }
                        });
                    } else {
                        res.write(
                            `event: error\ndata: ${JSON.stringify({
                                type: 'error',
                                error: { type: errorType, message: errorMessage }
                            })}\n\n`
                        );
                    }
                    res.end();
                }
            } else {
                // Handle non-streaming response
                const response = await sendMessage(request, accountManager, fallbackEnabled);
                res.json(response);
            }
        } catch (error) {
            reqLogger.error('[API] Error handling message request:', error);
            const { errorType, statusCode, errorMessage } = parseError(error);
            res.status(statusCode).json({
                type: 'error',
                error: {
                    type: errorType,
                    message: errorMessage
                }
            });
        }
    });

    return router;
}
