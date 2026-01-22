/**
 * Logger Utility
 *
 * Provides structured logging with colors, debug support, and request context.
 * Simple ANSI codes used to avoid dependencies.
 */

import { EventEmitter } from 'node:events';
import util from 'node:util';

const COLORS = {
    RESET: '\x1b[0m',
    BRIGHT: '\x1b[1m',
    DIM: '\x1b[2m',

    RED: '\x1b[31m',
    GREEN: '\x1b[32m',
    YELLOW: '\x1b[33m',
    BLUE: '\x1b[34m',
    MAGENTA: '\x1b[35m',
    CYAN: '\x1b[36m',
    WHITE: '\x1b[37m',
    GRAY: '\x1b[90m'
};

class Logger extends EventEmitter {
    constructor() {
        super();
        this.isDebugEnabled = false;
        this.history = [];
        this.maxHistory = 1000;
        this.context = {};
    }

    /**
     * Set debug mode
     * @param {boolean} enabled
     */
    setDebug(enabled) {
        this.isDebugEnabled = !!enabled;
    }

    /**
     * Set global warning/error context (e.g. process ID)
     * @param {Object} context
     */
    setContext(context) {
        this.context = { ...this.context, ...context };
    }

    /**
     * Get current timestamp string
     */
    getTimestamp() {
        return new Date().toISOString();
    }

    /**
     * Get log history
     */
    getHistory() {
        return this.history;
    }

    /**
     * Format and print a log message
     * @param {string} level
     * @param {string} color
     * @param {string} message
     * @param  {...any} args
     */
    print(level, color, message, ...args) {
        // Format: [TIMESTAMP] [LEVEL] [CONTEXT] Message
        const timestampStr = this.getTimestamp();
        const timestamp = `${COLORS.GRAY}[${timestampStr}]${COLORS.RESET}`;
        const levelTag = `${color}[${level}]${COLORS.RESET}`;

        let contextTag = '';
        if (Object.keys(this.context).length > 0) {
            const contextStr = Object.entries(this.context)
                .map(([k, v]) => `${k}=${v}`)
                .join(' ');
            contextTag = `${COLORS.DIM}[${contextStr}]${COLORS.RESET} `;
        }

        // Handle errors specially if the first arg is an Error
        if (message instanceof Error) {
            args.unshift(message.stack || message.message);
            message = '%s';
        }

        // Format the message with args similar to console.log
        const formattedMessage = util.format(message, ...args);

        console.log(`${timestamp} ${levelTag} ${contextTag}${formattedMessage}`);

        // Store structured log
        const logEntry = {
            timestamp: timestampStr,
            level,
            message: formattedMessage,
            context: { ...this.context }
        };

        this.history.push(logEntry);
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }

        this.emit('log', logEntry);
    }

    /**
     * Create a child logger with specific context
     * @param {Object} context
     * @returns {Logger} A proxy to this logger with preset context
     */
    child(context) {
        // Lightweight proxy to avoid creating full instances
        return {
            setContext: (newContext) => {
                // Merge into the child's closure context
                context = { ...context, ...newContext };
            },
            info: (msg, ...args) =>
                this.printWithContext('INFO', COLORS.BLUE, context, msg, ...args),
            success: (msg, ...args) =>
                this.printWithContext('SUCCESS', COLORS.GREEN, context, msg, ...args),
            warn: (msg, ...args) =>
                this.printWithContext('WARN', COLORS.YELLOW, context, msg, ...args),
            error: (msg, ...args) =>
                this.printWithContext('ERROR', COLORS.RED, context, msg, ...args),
            debug: (msg, ...args) => {
                if (this.isDebugEnabled) {
                    this.printWithContext('DEBUG', COLORS.MAGENTA, context, msg, ...args);
                }
            },
            log: (msg, ...args) => console.log(msg, ...args),
            header: (title) =>
                console.log(`\n${COLORS.BRIGHT}${COLORS.CYAN}=== ${title} ===${COLORS.RESET}\n`)
        };
    }

    /**
     * Internal helper for child loggers
     */
    printWithContext(level, color, childContext, message, ...args) {
        // Merge global context with child context temporarilly
        const originalContext = this.context;
        this.context = { ...this.context, ...childContext };
        try {
            this.print(level, color, message, ...args);
        } finally {
            this.context = originalContext;
        }
    }

    /**
     * Standard info log
     */
    info(message, ...args) {
        this.print('INFO', COLORS.BLUE, message, ...args);
    }

    /**
     * Success log
     */
    success(message, ...args) {
        this.print('SUCCESS', COLORS.GREEN, message, ...args);
    }

    /**
     * Warning log
     */
    warn(message, ...args) {
        this.print('WARN', COLORS.YELLOW, message, ...args);
    }

    /**
     * Error log
     */
    error(message, ...args) {
        this.print('ERROR', COLORS.RED, message, ...args);
    }

    /**
     * Debug log - only prints if debug mode is enabled
     */
    debug(message, ...args) {
        if (this.isDebugEnabled) {
            this.print('DEBUG', COLORS.MAGENTA, message, ...args);
        }
    }

    /**
     * Direct log (for raw output usually) - proxied to console.log but can be enhanced
     */
    log(message, ...args) {
        console.log(message, ...args);
    }

    /**
     * Print a section header
     */
    header(title) {
        console.log(`\n${COLORS.BRIGHT}${COLORS.CYAN}=== ${title} ===${COLORS.RESET}\n`);
    }
}

// Export a singleton instance
export const logger = new Logger();
