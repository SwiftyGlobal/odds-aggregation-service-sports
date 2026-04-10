/**
 * Simple logger with timestamp and icons
 */

import { LOG_CONFIG, LOG_LEVELS } from '../config/index.js';

export class Logger {
    private static getIcon(level: string): string {
        switch (level.toLowerCase()) {
            case 'error': return '❌';
            case 'warn': return '⚠️';
            case 'info': return 'ℹ️';
            case 'debug': return '🔍';
            default: return '📝';
        }
    }

    private static getTimestamp(): string {
        return new Date().toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    private static shouldLog(level: number): boolean {
        return level <= LOG_CONFIG.level;
    }

    static error(message: string, ...args: any[]): void {
        if (!this.shouldLog(LOG_LEVELS.ERROR)) return;
        const icon = this.getIcon('error');
        const timestamp = this.getTimestamp();
        console.error(`[${timestamp}] ${icon}  ${message}`, ...args);
    }

    static warn(message: string, ...args: any[]): void {
        if (!this.shouldLog(LOG_LEVELS.WARN)) return;
        const icon = this.getIcon('warn');
        const timestamp = this.getTimestamp();
        console.warn(`[${timestamp}] ${icon}  ${message}`, ...args);
    }

    static info(message: string, ...args: any[]): void {
        if (!this.shouldLog(LOG_LEVELS.INFO)) return;
        const icon = this.getIcon('info');
        const timestamp = this.getTimestamp();
        console.info(`[${timestamp}] ${icon}  ${message}`, ...args);
    }

    static debug(message: string, ...args: any[]): void {
        if (!this.shouldLog(LOG_LEVELS.DEBUG)) return;
        const icon = this.getIcon('debug');
        const timestamp = this.getTimestamp();
        console.debug(`[${timestamp}] ${icon}  ${message}`, ...args);
    }

    // Legacy methods for compatibility
    static aggregation(message: string, ...args: any[]): void {
        this.info(message, ...args);
    }

    static matching(message: string, ...args: any[]): void {
        this.info(message, ...args);
    }

    static performance(message: string, ...args: any[]): void {
        this.info(message, ...args);
    }
}

export const logger = Logger;
