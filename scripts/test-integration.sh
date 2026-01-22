#!/bin/bash
set -e

# Configuration
MOCK_PORT=8081
SERVER_PORT=8080
PROXY_URL="http://localhost:$SERVER_PORT"
UPSTREAM_URL="http://127.0.0.1:$MOCK_PORT"
export ANTIGRAVITY_UPSTREAM_URL="$UPSTREAM_URL"
export ANTHROPIC_BASE_URL="$PROXY_URL"
export ANTHROPIC_API_KEY="test"
export ACCOUNT_CONFIG_PATH="tests/fixtures/ci-accounts.json"

echo "Starting Integration Test Environment..."

# 1. Start Mock Upstream
echo "-> Starting Mock Upstream on port $MOCK_PORT..."
node tests/helpers/upstream-mock.js &
MOCK_PID=$!
echo "   Mock PID: $MOCK_PID"

# Wait for mock to be ready
sleep 1

# 2. Start Proxy Server
echo "-> Starting Proxy Server on port $SERVER_PORT..."
npm start &
SERVER_PID=$!
echo "   Server PID: $SERVER_PID"

# Wait for server to be ready
echo "-> Waiting for server to be ready..."
npx wait-on "$PROXY_URL/health" -t 10000

# 3. Run Tests
echo "-> Running Test Suite..."
# Run all tests (pass arguments if any)
if [ $# -eq 0 ]; then
    npm test
else
    # Run specific test if arg provided
    node "$1"
fi
TEST_EXIT_CODE=$?

# 4. Cleanup
echo "-> Shutting down services..."
kill $SERVER_PID
kill $MOCK_PID

if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo "✅ Integration Tests Passed!"
    exit 0
else
    echo "❌ Integration Tests Failed!"
    exit $TEST_EXIT_CODE
fi
