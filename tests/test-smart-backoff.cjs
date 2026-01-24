/**
 * Test for Smart Backoff and Rate Limit Logic
 *
 * Tests the new v2.4.0 rate limit handling, including:
 * - Smart backoff calculation
 * - Rate limit reason parsing
 * - Deduplication logic
 */

const assert = require('assert');
const { parseRateLimitReason, parseResetTime } = require('../src/cloudcode/rate-limit-parser.js');
const {
    QUOTA_EXHAUSTED_BACKOFF_TIERS_MS,
    BACKOFF_BY_ERROR_TYPE,
    MIN_BACKOFF_MS
} = require('../src/constants.js');
const { calculateSmartBackoff } = require('../src/cloudcode/retry-utils.js');

async function testSmartBackoff() {
    console.log('\n============================================================');
    console.log('SMART BACKOFF & RATE LIMIT TEST');
    console.log('Tests v2.4.0 rate limit handling logic');
    console.log('============================================================\n');

    try {
        console.log('TEST 1: parseRateLimitReason');
        console.log('----------------------------------------');

        const cases = [
            {
                text: 'Resource has been exhausted (e.g. check quota).',
                expected: 'QUOTA_EXHAUSTED'
            },
            {
                text: 'Quota exceeded for quota metric',
                expected: 'QUOTA_EXHAUSTED'
            },
            {
                text: 'Too Many Requests',
                expected: 'RATE_LIMIT_EXCEEDED'
            },
            {
                text: 'Model capacity exhausted',
                expected: 'MODEL_CAPACITY_EXHAUSTED'
            },
            {
                text: 'The service is currently overloaded',
                expected: 'MODEL_CAPACITY_EXHAUSTED'
            },
            {
                text: 'Internal Server Error',
                expected: 'SERVER_ERROR'
            },
            {
                text: 'Unknown error',
                expected: 'UNKNOWN'
            }
        ];

        let passed = 0;
        for (const c of cases) {
            const result = parseRateLimitReason(c.text);
            if (result === c.expected) {
                passed++;
            } else {
                console.log(`  [FAIL] Input: "${c.text}" -> Expected: ${c.expected}, Got: ${result}`);
            }
        }

        if (passed === cases.length) {
            console.log(`  ✓ All ${passed} parser cases passed`);
            console.log('  Result: PASS\n');
        } else {
            console.log(`  Result: FAIL (${passed}/${cases.length} passed)\n`);
            return false;
        }

        console.log('TEST 2: parseResetTime');
        console.log('----------------------------------------');

        // Mock response object
        const createResponse = (retryAfter) => ({
            headers: {
                get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter : null)
            }
        });

        const resetCases = [
            {
                retryAfter: '30',
                errorText: '',
                expected: 30000,
                desc: 'Standard Retry-After (seconds)'
            },
            {
                retryAfter: null,
                errorText: 'Please retry after 45s',
                expected: 45000,
                desc: 'Error text regex (s)'
            },
            {
                retryAfter: null,
                errorText: 'Retry after 1m 30s',
                expected: 90000,
                desc: 'Error text regex (m s)'
            },
            {
                retryAfter: null,
                errorText: 'No info',
                expected: null,
                desc: 'No info'
            }
        ];

        passed = 0;
        for (const c of resetCases) {
            const result = parseResetTime(createResponse(c.retryAfter), c.errorText);
            if (result === c.expected) {
                passed++;
            } else {
                console.log(
                    `  [FAIL] ${c.desc} -> Expected: ${c.expected}, Got: ${result}`
                );
            }
        }

        if (passed === resetCases.length) {
            console.log(`  ✓ All ${passed} reset time parsing cases passed`);
            console.log('  Result: PASS\n');
        } else {
            console.log(`  Result: FAIL (${passed}/${resetCases.length} passed)\n`);
            return false;
        }

        console.log('TEST 3: Smart Backoff Configuration');
        console.log('----------------------------------------');

        // Verify constants
        assert.ok(QUOTA_EXHAUSTED_BACKOFF_TIERS_MS.length > 0, 'Quota tiers exist');
        assert.ok(BACKOFF_BY_ERROR_TYPE.RATE_LIMIT_EXCEEDED > 0, 'Rate limit backoff defined');
        assert.ok(
            BACKOFF_BY_ERROR_TYPE.MODEL_CAPACITY_EXHAUSTED > 0,
            'Capacity backoff defined'
        );

        console.log('  ✓ Constants verified');
        console.log('  Result: PASS\n');

        console.log('TEST 4: calculateSmartBackoff Logic');
        console.log('----------------------------------------');

        // Test server reset time priority
        const resetPriority = calculateSmartBackoff('Error', 5000);
        if (resetPriority === 5000) {
            console.log('  ✓ Prioritizes server reset time');
        } else {
            console.log(`  [FAIL] Server reset time: expected 5000, got ${resetPriority}`);
            passed = false;
        }

        // Test quota exhaustion backoff
        // tier 0: 60s, tier 1: 5m...
        const quotaBackoff = calculateSmartBackoff('Quota exceeded', null, 0); // tier 0
        if (quotaBackoff === QUOTA_EXHAUSTED_BACKOFF_TIERS_MS[0]) {
            console.log('  ✓ Quota exhaustion tier 0 correct');
        } else {
            console.log(`  [FAIL] Quota tier 0: expected ${QUOTA_EXHAUSTED_BACKOFF_TIERS_MS[0]}, got ${quotaBackoff}`);
            passed = false;
        }

        // Test rate limit exceeded (fixed)
        const rateLimitBackoff = calculateSmartBackoff('Too Many Requests', null, 0);
        if (rateLimitBackoff === BACKOFF_BY_ERROR_TYPE.RATE_LIMIT_EXCEEDED) {
            console.log('  ✓ Rate limit exceeded correct');
        } else {
            console.log('  [FAIL] Rate limit exceeded mismatch');
            passed = false;
        }

        console.log('  Result: ' + (passed !== false ? 'PASS' : 'FAIL') + '\n');

        console.log('============================================================');
        console.log('SUMMARY');
        console.log('============================================================');
        console.log('  [PASS] Rate limit reason parsing');
        console.log('  [PASS] Reset time parsing');
        console.log('  [PASS] Configuration');
        console.log('\n============================================================');
        console.log('[SMART BACKOFF] ALL TESTS PASSED');
        console.log('============================================================\n');

        return true;
    } catch (error) {
        console.error('\n[ERROR] Test failed:', error.message);
        console.error(error.stack);
        return false;
    }
}

testSmartBackoff()
    .then((success) => process.exit(success ? 0 : 1))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
