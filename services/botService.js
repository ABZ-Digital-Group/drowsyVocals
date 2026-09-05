'use strict';

class BotApiError extends Error {
    constructor(message, code, status = 502) {
        super(message);
        this.name = 'BotApiError';
        this.code = code;
        this.status = status;
    }
}

function createBotService({ baseUrl = process.env.BOT_API_URL, secret = process.env.BOT_API_SECRET || process.env.BOT_API_TOKEN, timeoutMs = 5000 } = {}) {
    const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');

    async function request(pathname, options = {}) {
        if (!normalizedBaseUrl || !secret) {
            throw new BotApiError('Bot API is not configured.', 'unavailable');
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(`${normalizedBaseUrl}${pathname}`, {
                ...options,
                headers: {
                    Accept: 'application/json',
                    'X-Bot-Api-Key': secret,
                    ...(options.headers || {}),
                },
                signal: controller.signal,
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                const error = String(payload.error || 'Bot API request failed.');
                if (response.status === 401) throw new BotApiError('Unauthorized.', 'unauthorized', 502);
                if (response.status === 409) throw new BotApiError('Action already running.', 'conflict', 409);
                if (response.status === 503) throw new BotApiError('Bot offline.', 'offline', 503);
                throw new BotApiError(error, 'bot_error', 502);
            }
            return payload;
        } catch (error) {
            if (error instanceof BotApiError) throw error;
            if (error.name === 'AbortError') throw new BotApiError('Bot API unavailable.', 'timeout');
            throw new BotApiError('Bot API unavailable.', 'unavailable');
        } finally {
            clearTimeout(timeout);
        }
    }

    return {
        getBotHealth() {
            return request('/health');
        },
        getBotStatus() {
            return request('/status');
        },
        syncBot(payload) {
            return request('/actions/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(payload).toString(),
            });
        },
        sendAnnouncement(payload) {
            return request('/actions/announcement', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(payload).toString(),
            });
        },
    };
}

module.exports = { BotApiError, createBotService };
