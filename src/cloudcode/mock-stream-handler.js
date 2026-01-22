import { logger } from '../utils/logger.js';
import crypto from 'node:crypto';

// Constants
const MOCK_SIGNATURE = 'mock_signature_longer_than_50_chars_for_validation_purposes_123456789';
const MOCK_TOOL_SIGNATURE = 'mock_signature_longer_than_50_chars_for_validation_purposes_on_tool_use_9876543210';

/**
 * Mock Stream Handler for Testing
 * Simulates Google Cloud Code API responses in Anthropic format
 */
export async function* mockMessageStream(anthropicRequest) {
    logger.info(`[Mock] Handling request for model: ${anthropicRequest.model}`);

    const lastMessage = anthropicRequest.messages[anthropicRequest.messages.length - 1];
    const content = Array.isArray(lastMessage.content)
        ? lastMessage.content.map(c => c.text || '').join('')
        : lastMessage.content;

    const scenario = detectScenario(content, lastMessage);
    const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`;

    yield {
        type: 'message_start',
        message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: anthropicRequest.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 }
        }
    };

    let blockIndex = 0;

    // Simulate Thinking Block if model supports it
    if (anthropicRequest.thinking) {
        const thought = getThinkingContent(scenario);
        yield* emitThinking(blockIndex, thought);
        blockIndex++;
    }

    // Emit content based on scenario
    yield* emitScenarioContent(blockIndex, scenario);

    yield { type: 'message_stop' };
}

/**
 * Detect the test scenario based on request content
 */
function detectScenario(content, lastMessage) {
    const lowerContent = content.toLowerCase();

    if (lowerContent.includes('weather')) return 'WEATHER';
    if (lowerContent.includes('run "ls -la"')) return 'RUN_COMMAND';
    if (lowerContent.includes('step by step')) return 'COMPLEX_TASK';
    if (lowerContent.includes('analyze the src/config.js')) return 'ANALYZE_CONFIG';

    const isToolResult = Array.isArray(lastMessage.content) &&
        lastMessage.content.some(c => c.type === 'tool_result');

    if (isToolResult) return 'TOOL_RESULT';

    return 'DEFAULT';
}

/**
 * Get appropriate thinking content for the scenario
 */
function getThinkingContent(scenario) {
    switch (scenario) {
        case 'WEATHER': return "I should check the weather for the user.";
        case 'RUN_COMMAND': return "I should run the ls -la command.";
        case 'COMPLEX_TASK': return "I need to read the config file first.";
        default: return "I am thinking about the response.";
    }
}

/**
 * Emit content blocks for the specific scenario
 */
function* emitScenarioContent(blockIndex, scenario) {
    switch (scenario) {
        case 'WEATHER':
            yield* emitToolUse(blockIndex, 'get_weather', { location: "Paris" });
            break;

        case 'RUN_COMMAND':
            yield* emitToolUse(blockIndex, 'execute_command', { command: "ls -la" });
            break;

        case 'COMPLEX_TASK':
            yield* emitToolUse(blockIndex, 'read_file', { path: "src/config.js" });
            break;

        case 'ANALYZE_CONFIG':
            yield* emitTextResponse(blockIndex, 'The config file looks secure enough for development, but debug:true is risky for production.');
            break;

        case 'TOOL_RESULT':
            yield* emitTextResponse(blockIndex, 'Here is the output/result you requested.');
            break;

        default: // DEFAULT
            yield* emitTextResponse(blockIndex, 'Here is the response.');
            break;
    }
}

/**
 * Emit a thinking block with signature
 */
function* emitThinking(blockIndex, thought) {
    yield {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'thinking', thinking: '' }
    };

    yield {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'thinking_delta', thinking: thought }
    };

    yield {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'signature_delta', signature: MOCK_SIGNATURE }
    };

    yield { type: 'content_block_stop', index: blockIndex };
}

/**
 * Emit a tool use block with signature
 */
function* emitToolUse(blockIndex, name, input) {
    const toolId = `toolu_${crypto.randomBytes(12).toString('hex')}`;
    const toolUse = {
        type: 'tool_use',
        id: toolId,
        name: name,
        input: {}
    };

    toolUse.thoughtSignature = MOCK_TOOL_SIGNATURE;

    yield {
        type: 'content_block_start',
        index: blockIndex,
        content_block: toolUse
    };

    yield {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) }
    };

    yield { type: 'content_block_stop', index: blockIndex };

    yield {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 50 }
    };
}

/**
 * Emit a standard text response
 */
function* emitTextResponse(blockIndex, text) {
    yield {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' }
    };

    yield {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: text }
    };

    yield { type: 'content_block_stop', index: blockIndex };

    yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 20 }
    };
}
