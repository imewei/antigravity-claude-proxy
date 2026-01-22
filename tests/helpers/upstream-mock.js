/**
 * Mock Upstream Server for Integration Tests
 *
 * Simulates the Google Cloud Code API behavior to support
 * integration tests without external dependencies.
 */
const http = require('http');

const PORT = 8081; // Mock upstream port

function createMockServer() {
    const server = http.createServer(async (req, res) => {
        // Enable CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        if (req.method !== 'POST' || !req.url.includes('streamGenerateContent')) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
            return;
        }

        // Collect body
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            try {
                const requestData = JSON.parse(body);
                handleRequest(req, res, requestData);
            } catch (error) {
                console.error('[MockUpstream] Invalid JSON:', error);
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    });

    return server;
}

function handleRequest(req, res, data) {
    const model = (data.model || '').toLowerCase();

    // Simulate 429 for Recursive Fallback Test
    if (model.includes('flash-lite') || model === 'gemini-2.5-flash') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.write(JSON.stringify({
            error: {
                message: 'Resource exhausted: model info: model_capacity_exhausted',
                code: 429,
                status: 'RESOURCE_EXHAUSTED'
            }
        }));
        res.end();
        return;
    }

    // Set headers for SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    // Helper to send SSE event
    const sendEvent = (dataObj) => {
        res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
    };

    // Simulate Thinking/Signatures if requested
    // "Thinking Signatures" test checks for signatures.
    // We detect if it's a thinking model test.
    const isThinking = model.includes('thinking') || model.includes('gemini');

    const parts = [];

    if (isThinking) {
        // Add thinking block with signature
        const signature = 's'.repeat(60); // Must be > 50 chars
        parts.push({
            thought: true,
            text: "I am thinking about the weather...",
            thoughtSignature: signature
        });
    }

    // Add normal text response (or tool match if requested)
    // Check if user asked about weather (for tool test)
    const messages = data.messages || [];
    const lastMsg = messages[messages.length - 1] || {};
    const content = JSON.stringify(lastMsg.content || '');

    if (content.includes('weather')) {
        // Return tool call
        parts.push({
            functionCall: {
                name: 'get_weather',
                args: { location: 'Paris' }
            },
            thoughtSignature: isThinking ? 't'.repeat(60) : undefined
        });
    } else {
        parts.push({
            text: "Here is the response from the mock upstream."
        });
    }

    const responsePayload = {
        candidates: [
            {
                content: { parts },
                finishReason: parts.some(p => p.functionCall) ? "STOP" : "STOP",
                usageMetadata: {
                    promptTokenCount: 10,
                    candidatesTokenCount: 10,
                    cachedContentTokenCount: 0
                }
            }
        ]
    };

    sendEvent(responsePayload);
    res.end();
}

if (require.main === module) {
    const server = createMockServer();
    server.listen(PORT, () => {
        console.log(`Mock upstream running on http://localhost:${PORT}`);
    });
}

module.exports = { createMockServer, PORT };
