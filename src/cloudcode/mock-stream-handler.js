
import { logger } from '../utils/logger.js';
import crypto from 'node:crypto';

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

    // Determine response type based on content
    const isWeatherRequest = content.toLowerCase().includes('weather');
    const isRunCommandRequest = content.toLowerCase().includes('run "ls -la"');
    const isComplexStepByStep = content.toLowerCase().includes('step by step');
    const isToolResult = Array.isArray(lastMessage.content) && lastMessage.content.some(c => c.type === 'tool_result');
    const isAnalyzeConfig = content.toLowerCase().includes('analyze the src/config.js');

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

    // Simulate Thinking Block if model supports it (mock check)
    if (anthropicRequest.thinking) {

        // Skip thinking for simple tool results to test interleaved behavior (optional, matches test expectations easier)
        // But for turn 1 of complex task, WE NEED THINKING

        yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'thinking', thinking: '' }
        };

        const thought = isWeatherRequest ? "I should check the weather for the user." :
            isRunCommandRequest ? "I should run the ls -la command." :
                isComplexStepByStep ? "I need to read the config file first." :
                    "I am thinking about the response.";

        yield {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'thinking_delta', thinking: thought }
        };

        // Emit signature
        yield {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'signature_delta', signature: 'mock_signature_longer_than_50_chars_for_validation_purposes_123456789' }
        };

        yield { type: 'content_block_stop', index: blockIndex };
        blockIndex++;
    }

    // Simulate Tool Use
    if (isWeatherRequest) {
        yield* emitToolUse(blockIndex, 'get_weather', { location: "Paris" });
    } else if (isRunCommandRequest) {
        yield* emitToolUse(blockIndex, 'execute_command', { command: "ls -la" });
    } else if (isComplexStepByStep) {
        yield* emitToolUse(blockIndex, 'read_file', { path: "src/config.js" });
    } else if (isAnalyzeConfig) {
        // Complex task interleaving: Tool result came back, now respond with text or another tool
        // Test expects "Response after tool result" -> Text or Tool
        // We'll just return text
        yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' }
        };

        yield {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: 'The config file looks secure enough for development, but debug:true is risky for production.' }
        };

        yield { type: 'content_block_stop', index: blockIndex };

        yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 20 }
        };
    } else if (isToolResult) {
        // Generic tool result handling -> Respond with text
        yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' }
        };

        yield {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: 'Here is the output/result you requested.' }
        };

        yield { type: 'content_block_stop', index: blockIndex };

        yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 20 }
        };
    } else {
        // Regular text response
        yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' }
        };

        yield {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: 'Here is the response.' }
        };

        yield { type: 'content_block_stop', index: blockIndex };

        yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 20 }
        };
    }

    yield { type: 'message_stop' };
}

function* emitToolUse(blockIndex, name, input) {
    const toolId = `toolu_${crypto.randomBytes(12).toString('hex')}`;
    const toolUse = {
        type: 'tool_use',
        id: toolId,
        name: name,
        input: {}
    };

    toolUse.thoughtSignature = 'mock_signature_longer_than_50_chars_for_validation_purposes_on_tool_use_9876543210';

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
