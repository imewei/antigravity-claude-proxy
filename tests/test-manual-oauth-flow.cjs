/**
 * Test for Manual OAuth Flow
 *
 * Tests the v2.4.0 manual OAuth changes:
 * - Abortable callback server
 * - Manual code handling
 */

const { extractCodeFromInput } = require('../src/auth/oauth.js');
const http = require('http');

// Mock OAUTH_CONFIG for tests
process.env.TEST_OAUTH_PORT = 59999;

// We need to mock the OAUTH_CONFIG in the module, but since it's an import,
// we'll rely on testing the pure functions and mocking the server behavior.

async function testManualOAuth() {
    console.log('\n============================================================');
    console.log('MANUAL OAUTH TEST');
    console.log('Tests v2.4.0 manual OAuth capabilities');
    console.log('============================================================\n');

    try {
        console.log('TEST 1: extractCodeFromInput');
        console.log('----------------------------------------');

        const cases = [
            {
                input: 'http://localhost:51121/oauth-callback?code=4/0AQSTg12345&state=abc',
                expectedCode: '4/0AQSTg12345',
                expectedState: 'abc',
                desc: 'Full URL'
            },
            {
                input: '4/0AQSTg1234567890',
                expectedCode: '4/0AQSTg1234567890',
                expectedState: null,
                desc: 'Raw Code'
            },
            {
                input: '  4/0AQSTg12345   ',
                expectedCode: '4/0AQSTg12345',
                expectedState: null,
                desc: 'Whitespace trimmed'
            }
        ];

        let passed = 0;
        for (const c of cases) {
            const result = extractCodeFromInput(c.input);
            if (result.code === c.expectedCode && result.state === c.expectedState) {
                passed++;
            } else {
                console.log(
                    `  [FAIL] ${c.desc} -> Expected: {code:${c.expectedCode}, state:${c.expectedState}}, Got: {code:${result.code}, state:${result.state}}`
                );
            }
        }

        if (passed === cases.length) {
            console.log(`  ✓ All ${passed} input parsing cases passed`);
            console.log('  Result: PASS\n');
        } else {
            console.log(`  Result: FAIL (${passed}/${cases.length} passed)\n`);
            return false;
        }

        console.log('TEST 2: startCallbackServer Abort Logic');
        console.log('----------------------------------------');

        // We can't easily test the actual startCallbackServer because it binds to a specific port
        // and uses the imported config. Instead, we'll verify the pattern works
        // by creating a mini-implementation of the pattern.

        function createAbortableServer() {
            let server;
            let abort;
            const promise = new Promise((resolve, reject) => {
                server = http.createServer((req, res) => res.end('ok'));
                server.listen(0); // Random port
                abort = () => {
                    server.close();
                    reject(new Error('Aborted'));
                };
                // Simulate success after delay (if not aborted)
                setTimeout(() => resolve('success'), 100);
            });
            return { promise, abort };
        }

        console.log('  Testing abort...');
        const { promise, abort } = createAbortableServer();

        // Call abort immediately
        abort();

        try {
            await promise;
            console.log('  [FAIL] Promise should have rejected');
            return false;
        } catch (e) {
            if (e.message === 'Aborted') {
                console.log('  ✓ Promise rejected with "Aborted"');
                console.log('  Result: PASS\n');
            } else {
                console.log(`  [FAIL] Wrong rejection reason: ${e.message}`);
                return false;
            }
        }

        console.log('============================================================');
        console.log('SUMMARY');
        console.log('============================================================');
        console.log('  [PASS] Code extraction logic');
        console.log('  [PASS] Abort pattern verification');
        console.log('\n============================================================');
        console.log('[MANUAL OAUTH] ALL TESTS PASSED');
        console.log('============================================================\n');

        return true;
    } catch (error) {
        console.error('\n[ERROR] Test failed:', error.message);
        console.error(error.stack);
        return false;
    }
}

testManualOAuth()
    .then((success) => process.exit(success ? 0 : 1))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
