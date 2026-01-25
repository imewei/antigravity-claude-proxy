/**
 * Reproduction Test: Rate Limit Wait Blocks Fallback
 *
 * Verifies that when all accounts are rate-limited with a short wait time (< 2min),
 * the system still attempts fallback if enabled, instead of waiting.
 */

async function testRateLimitWaitFallback() {
    console.log('\n============================================================');
    console.log('REPRODUCTION TEST: RATE LIMIT WAIT BLOCKS FALLBACK');
    console.log('============================================================\n');

    try {
        // Mock global fetch
        const originalFetch = global.fetch;
        global.fetch = async () => ({
            ok: false,
            status: 500,
            text: async () => 'Should not be called in this test'
        });

        // We can't easily mock the export, but we can verify the behavior by checking
        // if fallback was called.

        const { sendMessageStream } = await import('../src/cloudcode/streaming-handler.js');

        // Mock AccountManager
        const mockAccountManager = {
            getAvailableAccounts: () => [], // No accounts available
            getAccountCount: () => 1,
            selectAccount: () => ({ account: null, waitMs: 0 }),
            isAllRateLimited: () => true, // All rate limited
            getMinWaitTimeMs: () => 60000, // 1 minute wait (short enough to trigger wait logic)
            clearExpiredLimits: () => {},
            getHealthTracker: () => ({ getConsecutiveFailures: () => 0 })
        };

        const request = {
            model: 'primary-model',
            messages: [{ role: 'user', content: 'hi' }]
        };

        // Mock getFallbackModel using the actual module, or just rely on the fact that
        // the handler calls it. Ideally we want to spy on the recursive call.
        // Since it's a recursive import of the same function, spying is hard.
        // But we can check if it throws "RESOURCE_EXHAUSTED" (current behavior)
        // vs doing something else.

        // Actually, verify logic:
        // Current behavior: Logs "Waiting..." then eventually throws or sleeps.
        // Since we mocked getAvailableAccounts to ALWAYS return [], the loop will continue
        // until retries exhausted IF it waits.
        // IF it falls back, it should call sendMessageStream with new model.

        // To detect fallback, we'll spy on console.warn/info since the code logs fallback attempts.
        const originalWarn = console.warn;
        let logs = [];
        console.warn = (...args) => {
            logs.push(args.join(' '));
            // originalWarn(...args);
        };

        // We also need to mock constants or fallback-config to ensure primary-model has a fallback
        // We use 'gemini-2.5-flash' which maps to 'gemini-2.5-pro' (no cycle)
        request.model = 'gemini-2.5-flash';

        console.log('  Triggering stream request with fallbackEnabled=true...');

        try {
            const generator = sendMessageStream(request, mockAccountManager, true);
            // We need to iterate to trigger execution
            // eslint-disable-next-line no-unused-vars
            for await (const chunk of generator) {
                // If it successfully chains to fallback, it might eventually fail
                // because our mock fetch returns 500. Not important.
            }
        } catch {
            // Expected error from eventual failure or recursion limit
        }

        console.warn = originalWarn;
        global.fetch = originalFetch;

        // Check logs for fallback message
        const fallbackLog = logs.find((l) => l.includes('Attempting fallback'));
        const waitLog = logs.find((l) => l.includes('Waiting 1m 0s'));

        console.log('Logs captured:', logs);

        if (fallbackLog) {
            console.log('  ✓ Fallback triggered successfully');
            console.log(`    Log: "${fallbackLog}"`);
            console.log('\n============================================================');
            console.log('[SHORT WAIT FALLBACK] TEST PASSED');
            console.log('============================================================\n');
            process.exit(0);
        } else {
            console.log('  ✗ Fallback NOT triggered');
            if (waitLog) {
                console.log(`    System chose to wait: "${waitLog}"`);
            }
            process.exit(1);
        }
    } catch (error) {
        console.error('\n[ERROR] Test failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

testRateLimitWaitFallback();
