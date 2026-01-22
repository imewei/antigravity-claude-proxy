/**
 * Mock Upstream Server for Integration Tests
 *
 * Simulates the Google Cloud Code API behavior to support
 * integration tests without external dependencies.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const PORT = 8081; // Mock upstream port

export function createMockServer() {
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

    // Support GCP envelope: { request: { contents: ... } }
    const reqData = data.request || data;

    // DEBUG: Log received data structure (shallow)
    // console.log('[Mock] Received data keys:', Object.keys(data));
    // if (reqData.contents) console.log('[Mock] Contents:', JSON.stringify(reqData.contents, null, 2).substring(0, 500));

    // Extract content from Google API format
    // Google uses 'contents' array with 'parts', not 'messages'
    const contents = reqData.contents || [];
    const lastMsg = contents[contents.length - 1] || {};
    const contentParts = lastMsg.parts || [];

    // Extract text content for pattern matching triggers
    const textParts = contentParts.filter(p => p.text).map(p => p.text).join(' ');
    const content = textParts || '';

    // Simulate 429 for Recursive Fallback Test
    if (model.includes('flash-lite') || model === 'gemini-2.5-flash') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.write(
            JSON.stringify({
                error: {
                    message: 'Resource exhausted: model info: model_capacity_exhausted',
                    code: 429,
                    status: 'RESOURCE_EXHAUSTED'
                }
            })
        );
        res.end();
        return;
    }

    // Set headers for SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    });

    // Helper to send SSE event
    const sendEvent = (dataObj) => {
        res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
    };

    // Simulate Prompt Caching
    let cachedTokens = 0;
    // Check system prompt for caching trigger too (test-caching-streaming.cjs uses system prompt)
    // Google format uses 'system_instruction' object with parts
    const systemInstruction = reqData.system_instruction || {};
    const systemParts = (systemInstruction.parts || []).filter(p => p.text).map(p => p.text).join(' ');
    const systemPrompt = systemParts || '';

    if (content.includes('cache') || content.includes('system') || content.length > 500 || systemPrompt.length > 500) {
        cachedTokens = 200;
    }

    // Simulate Image Input
    // Check if any message part has 'inlineData' or 'fileData' (Google format)
    const hasImage = contents.some(m =>
        (m.parts || []).some(p => p.inlineData || p.fileData)
    );

    // Simulate Thinking/Signatures if requested
    const isThinking = model.includes('thinking') || model.includes('gemini');
    const signature = 's'.repeat(60); // Must be > 50 chars for tests

    const parts = [];

    if (isThinking) {
        // Add thinking block with signature
        parts.push({
            thought: true,
            text: 'I am thinking about the weather...',
            thoughtSignature: signature
        });
    }

    // Check for multi-turn weather message or tool results
    const lastUserMsg = contents.filter(m => m.role === 'user').pop();
    // Check if the last part is a functionResponse (tool result)
    const hasToolResult = lastUserMsg && Array.isArray(lastUserMsg.parts) && lastUserMsg.parts.some(c => c.functionResponse || c.tool_result);

    if (content.includes('weather') && !hasToolResult) {
        // Return tool call
        parts.push({
            functionCall: {
                name: 'get_weather',
                args: { location: 'Paris' }
            },
            thoughtSignature: isThinking ? 't'.repeat(60) : undefined
        });
    } else if (content.includes('config.js') && !hasToolResult) {
        // Interleaved Thinking Test: step 1
        parts.push({
            thought: true,
            text: 'I should read the file src/config.js first to understand the structure.',
            thoughtSignature: signature
        });
        parts.push({
            functionCall: {
                name: 'read_file',
                args: { path: 'src/config.js' }
            },
            thoughtSignature: isThinking ? 't'.repeat(60) : undefined
        });
    } else if (content.includes('package.json') && !hasToolResult) {
        // TURN 1 of File Test: Search files
        parts.push({
            functionCall: {
                name: 'search_files',
                args: { path: '.', pattern: 'package.json' }
            },
            thoughtSignature: isThinking ? 't'.repeat(60) : undefined
        });
    } else if (content.includes('ls -la') && !hasToolResult) {
        // TURN 1 of Streaming Test: Run command
        parts.push({
            functionCall: {
                name: 'execute_command',
                args: { command: 'ls -la' }
            },
            thoughtSignature: isThinking ? 't'.repeat(60) : undefined
        });
    } else if (hasToolResult) {
        // Check what the tool result was
        const toolResults = lastUserMsg.parts.filter(c => c.functionResponse || c.tool_result);
        const resultText = JSON.stringify(toolResults);

        if (resultText.includes('Found files')) {
            // TURN 2 of File Test: Read file
            parts.push({
                functionCall: {
                    name: 'read_file',
                    args: { path: '/project/package.json' }
                },
                thoughtSignature: isThinking ? 't'.repeat(60) : undefined
            });
        } else if (resultText.includes('total 32')) {
            // TURN 2 of Streaming Test: Final answer after ls -la
            parts.push({
                text: 'The directory contains package.json and README.md.'
            });
        } else if (resultText.includes('module.exports')) {
            // Interleaved Thinking Test: step 2 (after read config)
            parts.push({
                thought: true,
                text: 'Reflecting on the config content. It seems to be a standard Express config.',
                thoughtSignature: signature
            });
            parts.push({
                text: 'The config file is secure.'
            });
        } else {
            // TURN 3 of File Test or Weather Test: Final Answer
            parts.push({
                text: 'The package.json contains express and cors dependencies.'
            });
        }
    } else if (hasImage) {
        parts.push({
            text: 'I see the image.'
        });
    } else {
        parts.push({
            text: 'Here is the response from the mock upstream.'
        });
    }

    const responsePayload = {
        candidates: [
            {
                content: { parts },
                finishReason: parts.some((p) => p.functionCall) ? 'STOP' : 'STOP'
            }
        ],
        usageMetadata: {
            promptTokenCount: 210,
            candidatesTokenCount: 10,
            cachedContentTokenCount: cachedTokens
        }
    };

    // Debug logging
    // console.log(`[Mock] Handled request. Model: ${model}. Trigger: ${content.substring(0, 50)}... -> ${parts.map(p => p.functionCall ? 'Tool:' + p.functionCall.name : 'Text').join(',')}`);

    sendEvent(responsePayload);
    res.end();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const server = createMockServer();
    server.listen(PORT, () => {
        console.log(`Mock upstream running on http://localhost:${PORT}`);
    });
}
