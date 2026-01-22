/**
 * Shared Utility Functions
 *
 * General-purpose helper functions used across multiple modules.
 */

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human-readable duration (e.g., "1h23m45s")
 */
export function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return `${hours}h${minutes}m${secs}s`;
    } else if (minutes > 0) {
        return `${minutes}m${secs}s`;
    }
    return `${secs}s`;
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Duration to sleep in milliseconds
 * @returns {Promise<void>} Resolves after the specified duration
 */
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create an AbortSignal that times out and optionally mirrors an external signal
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {AbortSignal|null} externalSignal - Optional external signal to mirror
 * @returns {{signal: AbortSignal, cleanup: Function, didTimeout: Function}}
 */
export function createTimeoutSignal(timeoutMs, externalSignal = null) {
    const controller = new AbortController();
    let timeoutId = null;
    let timedOut = false;

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort(new Error('Request timeout'));
        }, timeoutMs);
    }

    const onAbort = () => {
        controller.abort(externalSignal?.reason);
    };

    if (externalSignal) {
        if (externalSignal.aborted) {
            controller.abort(externalSignal.reason);
        } else {
            externalSignal.addEventListener('abort', onAbort);
        }
    }

    const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (externalSignal) {
            externalSignal.removeEventListener('abort', onAbort);
        }
    };

    return { signal: controller.signal, cleanup, didTimeout: () => timedOut };
}

/**
 * Check if an error is a network error (transient)
 * @param {Error} error - The error to check
 * @returns {boolean} True if it is a network error
 */
export function isNetworkError(error) {
    const msg = error.message.toLowerCase();
    return (
        msg.includes('fetch failed') ||
        msg.includes('network error') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('socket hang up') ||
        msg.includes('timeout') ||
        msg.includes('500') ||
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('504') ||
        msg.includes('internal server error') ||
        msg.includes('bad gateway') ||
        msg.includes('service unavailable') ||
        msg.includes('gateway timeout')
    );
}
