import { createTimeoutSignal } from '../utils/helpers.js';

export async function fetchWithTimeout(url, options, timeoutMs, externalSignal = null) {
    const { signal, cleanup, didTimeout } = createTimeoutSignal(timeoutMs, externalSignal);
    try {
        return await fetch(url, { ...options, signal });
    } catch (error) {
        if (didTimeout()) {
            const timeoutError = new Error('Request timeout');
            timeoutError.name = 'TimeoutError';
            throw timeoutError;
        }
        throw error;
    } finally {
        cleanup();
    }
}

export default {
    fetchWithTimeout
};
