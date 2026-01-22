/**
 * Test for Recursive Fallback Mechanism
 *
 * Verifies chained fallback logic (Lite -> Flash -> Pro)
 * by mocking upstream API responses.
 */

async function testRecursiveFallback() {
    console.log('\n============================================================');
    console.log('RECURSIVE FALLBACK TEST');
    console.log('Tests chained model fallback logic');
    console.log('============================================================\n');

    try {
        // Mock global fetch
        const originalFetch = global.fetch;
        let fetchCalls = [];

        global.fetch = async (url, options) => {
            const body = JSON.parse(options.body);
            const model = body.model;
            fetchCalls.push(model);

            console.log(`  [MOCK] Fetch called for model: ${model}`);

            // Simulate 429 for Lite and Flash
            if (model.includes('flash-lite') || model === 'gemini-2.5-flash') {
                return {
                    ok: false,
                    status: 429,
                    text: async () => 'Resource exhausted: model info: model_capacity_exhausted',
                    json: async () => ({ error: { message: 'Capacity exhausted' } })
                };
            }

            // Success for Pro
            if (model.includes('pro')) {
                const stream = new ReadableStream({
                    start(controller) {
                        const data = JSON.stringify({
                            candidates: [{ content: { parts: [{ text: 'Success' }] } }]
                        });
                        controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
                        controller.close();
                    }
                });
                return {
                    ok: true,
                    body: stream
                };
            }

            return { ok: false, status: 500, text: async () => 'Unknown model' };
        };

        const { sendMessageStream } = await import('../src/cloudcode/streaming-handler.js');

        // Mock AccountManager
        const mockAccountManager = {
            getAvailableAccounts: () => [{ email: 'test@example.com' }],
            getAccountCount: () => 1,
            selectAccount: () => ({ account: { email: 'test@example.com' }, waitMs: 0 }),
            getTokenForAccount: async () => 'fake-token',
            getProjectForAccount: async () => 'fake-project',
            clearExpiredLimits: () => {},
            isAllRateLimited: () => false,
            notifyFailure: () => {},
            notifySuccess: () => {},
            getHealthTracker: () => ({ getConsecutiveFailures: () => 0 }),
            markRateLimited: () => {},
            notifyRateLimit: () => {}
        };

        console.log('TEST 1: Verify Fallback Chain');
        console.log('----------------------------------------');

        const request = {
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: 'hi' }]
        };

        console.log('  Triggering stream request...');
        const generator = sendMessageStream(request, mockAccountManager, true); // fallbackEnabled=true

        for await (const chunk of generator) {
            // eslint-disable-line no-unused-vars
            // Consume stream
        }

        console.log('  Verifying fetch sequence:');
        console.log(`  Sequence: ${fetchCalls.join(' -> ')}`);

        const expectedChain = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'];
        const passed =
            fetchCalls.length === 3 &&
            fetchCalls[0] === expectedChain[0] &&
            fetchCalls[1] === expectedChain[1] &&
            fetchCalls[2] === expectedChain[2];

        if (passed) {
            console.log('  ✓ Fallback chain executed correctly');
        } else {
            console.log('  ✗ Fallback chain failed');
            console.log(`    Expected: ${expectedChain.join(' -> ')}`);
            console.log(`    Actual:   ${fetchCalls.join(' -> ')}`);
            return false;
        }

        console.log('  Result: PASS\n');

        // Restore fetch
        global.fetch = originalFetch;

        console.log('============================================================');
        console.log('SUMMARY');
        console.log('============================================================');
        console.log('  [PASS] Mocked API confirmed fallback logic');
        console.log('\n============================================================');
        console.log('[RECURSIVE FALLBACK] ALL TESTS PASSED');
        console.log('============================================================\n');

        return true;
    } catch (error) {
        console.error('\n[ERROR] Test failed:', error.message);
        console.error(error.stack);
        return false;
    }
}

testRecursiveFallback()
    .then((success) => {
        process.exit(success ? 0 : 1);
    })
    .catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
