#!/usr/bin/env node
/**
 * Test Runner
 *
 * Runs all tests in sequence and reports results.
 * Usage: node tests/run-all.cjs
 */
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const http = require('http');

const tests = [
    { name: 'Account Selection Strategies', file: 'test-strategies.cjs' },
    { name: 'Thinking Signatures', file: 'test-thinking-signatures.cjs' },
    { name: 'Multi-turn Tools (Non-Streaming)', file: 'test-multiturn-thinking-tools.cjs' },
    { name: 'Multi-turn Tools (Streaming)', file: 'test-multiturn-thinking-tools-streaming.cjs' },
    { name: 'Interleaved Thinking', file: 'test-interleaved-thinking.cjs' },
    { name: 'Image Support', file: 'test-images.cjs' },
    { name: 'Prompt Caching', file: 'test-caching-streaming.cjs' },
    { name: 'Cross-Model Thinking', file: 'test-cross-model-thinking.cjs' },
    { name: 'OAuth No-Browser Mode', file: 'test-oauth-no-browser.cjs' },
    { name: 'Empty Response Retry', file: 'test-empty-response-retry.cjs' },
    { name: 'Schema Sanitizer', file: 'test-schema-sanitizer.cjs' },
    { name: 'Streaming Whitespace', file: 'test-streaming-whitespace.cjs' },
    { name: 'Recursive Fallback', file: 'test-recursive-fallback.cjs' }
];

// Helper to check if a port is in use
function isPortInUse(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);
        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.on('error', () => {
            socket.destroy();
            resolve(false);
        });
        socket.connect(port, '127.0.0.1');
    });
}

// Helper to wait for health check
function waitForHealth(url, timeoutMs = 10000) {
    const startTime = Date.now();
    return new Promise((resolve, reject) => {
        const check = () => {
            if (Date.now() - startTime > timeoutMs) {
                reject(new Error(`Timeout waiting for ${url}`));
                return;
            }

            http.get(url, (res) => {
                if (res.statusCode === 200) {
                    resolve();
                } else {
                    setTimeout(check, 500);
                }
            }).on('error', () => {
                setTimeout(check, 500);
            });
        };
        check();
    });
}

async function runTest(test) {
    return new Promise((resolve) => {
        const testPath = path.join(__dirname, test.file);
        const child = spawn('node', [testPath], {
            stdio: 'inherit',
            env: { ...process.env, FORCE_COLOR: '1' }
        });

        child.on('close', (code) => {
            resolve({ ...test, passed: code === 0 });
        });

        child.on('error', (err) => {
            console.error(`Error running ${test.name}:`, err);
            resolve({ ...test, passed: false });
        });
    });
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║              ANTIGRAVITY PROXY TEST SUITE                    ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');

    // Check if we need to start servers
    let startedMock = false;
    let startedProxy = false;
    let mockProcess = null;
    let proxyProcess = null;

    try {
        // 1. Check Mock Upstream (8081)
        const mockRunning = await isPortInUse(8081);
        if (!mockRunning) {
            console.log('Starting mock upstream server on port 8081...');
            mockProcess = spawn('node', [path.join(__dirname, 'helpers/upstream-mock.js')], {
                stdio: 'ignore', // Detached/ignore to avoid output mixing, or 'pipe' if we want logs
                detached: false
            });
            startedMock = true;
            await waitForHealth('http://127.0.0.1:8081/health');
            console.log('✓ Mock upstream ready');
        } else {
            console.log('✓ Mock upstream already running');
        }

        // 2. Check Proxy Server (8080)
        const proxyRunning = await isPortInUse(8080);
        if (!proxyRunning) {
            console.log('Starting proxy server on port 8080...');
            // We use 'npm start' or node directly
            // Using node directly to ensure we control the process better
            proxyProcess = spawn('node', ['src/index.js'], {
                stdio: 'ignore',
                detached: false,
                cwd: path.resolve(__dirname, '..'),
                env: {
                    ...process.env,
                    PORT: '8080',
                    ANTIGRAVITY_UPSTREAM_URL: 'http://127.0.0.1:8081' // Point to mock
                }
            });
            startedProxy = true;
            await waitForHealth('http://127.0.0.1:8080/health');
            console.log('✓ Proxy server ready');
        } else {
            console.log('✓ Proxy server already running');
        }
    } catch (err) {
        console.error('Failed to setup test environment:', err);
        if (mockProcess) mockProcess.kill();
        if (proxyProcess) proxyProcess.kill();
        process.exit(1);
    }

    console.log('');

    // cleanup function
    const cleanup = () => {
        if (startedProxy && proxyProcess) {
            console.log('Stopping proxy server...');
            proxyProcess.kill();
        }
        if (startedMock && mockProcess) {
            console.log('Stopping mock server...');
            mockProcess.kill();
        }
    };

    // Handle interrupts
    process.on('SIGINT', () => {
        cleanup();
        process.exit();
    });

    try {
        // Check if running specific test
        const specificTest = process.argv[2];
        let testsToRun = tests;

        if (specificTest) {
            testsToRun = tests.filter(
                (t) =>
                    t.file.includes(specificTest) ||
                    t.name.toLowerCase().includes(specificTest.toLowerCase())
            );
            if (testsToRun.length === 0) {
                console.log(`No test found matching: ${specificTest}`);
                console.log('\nAvailable tests:');
                tests.forEach((t) => console.log(`  - ${t.name} (${t.file})`));
                cleanup();
                process.exit(1);
            }
        }

        const results = [];

        for (const test of testsToRun) {
            console.log('\n');
            console.log('╔' + '═'.repeat(60) + '╗');
            console.log('║ Running: ' + test.name.padEnd(50) + '║');
            console.log('╚' + '═'.repeat(60) + '╝');
            console.log('');

            const result = await runTest(test);
            results.push(result);

            console.log('\n');
        }

        // Summary
        console.log('╔══════════════════════════════════════════════════════════════╗');
        console.log('║                      FINAL RESULTS                           ║');
        console.log('╠══════════════════════════════════════════════════════════════╣');

        let allPassed = true;
        for (const result of results) {
            const status = result.passed ? '✓ PASS' : '✗ FAIL';
            console.log(`║ ${status.padEnd(8)} ${result.name.padEnd(50)} ║`);
            if (!result.passed) allPassed = false;
        }

        console.log('╠══════════════════════════════════════════════════════════════╣');
        const overallStatus = allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED';
        console.log(`║ ${overallStatus.padEnd(60)} ║`);
        console.log('╚══════════════════════════════════════════════════════════════╝');

        cleanup();
        process.exit(allPassed ? 0 : 1);
    } catch (err) {
        console.error('Test runner failed:', err);
        cleanup();
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Test runner failed:', err);
    process.exit(1);
});
