/**
 * LLM Service — Connection Profile 또는 메인 API를 통한 LLM 호출
 */

import { generateRaw } from '../../../../script.js';

const LOG_PREFIX = '[LivingLorebook]';

let _context = null;

export function initLLMService(context) {
    _context = context;
}

/**
 * Connection Profile 또는 메인 API로 LLM 호출
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} maxTokens
 * @param {object} settings
 * @param {string} [profileIdOverride] - 비우거나 생략 시 settings.profileId 사용
 */
export async function callLLM(systemPrompt, userPrompt, maxTokens, settings, profileIdOverride) {
    const effectiveProfileId = profileIdOverride !== undefined && profileIdOverride !== null
        ? profileIdOverride
        : settings.profileId;
    if (effectiveProfileId && _context?.ConnectionManagerRequestService) {
        return await callProfileAPI(systemPrompt, userPrompt, maxTokens, effectiveProfileId);
    }
    return await callMainAPI(systemPrompt, userPrompt, maxTokens);
}

async function callMainAPI(systemPrompt, userPrompt, maxTokens) {
    const result = await generateRaw({
        prompt: userPrompt,
        systemPrompt: systemPrompt,
        responseLength: maxTokens,
    });
    return stripThinkTags((result || '').trim());
}

async function callProfileAPI(systemPrompt, userPrompt, maxTokens, profileId) {
    if (!_context?.ConnectionManagerRequestService) {
        throw new Error('Connection Manager is not available.');
    }

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];

    const response = await _context.ConnectionManagerRequestService.sendRequest(
        profileId,
        messages,
        maxTokens,
        {
            stream: false,
            extractData: true,
            includePreset: false,
            includeInstruct: false,
        },
    ).catch(err => {
        throw new Error(`Connection Profile request failed: ${err.message || 'Unknown error'}`);
    });

    let text = '';
    if (typeof response === 'string') {
        text = response;
    } else if (response?.choices?.[0]?.message) {
        text = response.choices[0].message.content || '';
    } else if (typeof response?.text === 'string') {
        // Gemini / 일부 ST connection 형식 — { text: "..." }
        text = response.text;
    } else if (Array.isArray(response?.content)) {
        // Anthropic 형식 — { content: [{ type: "text", text: "..." }, ...] }
        const textBlock = response.content.find(b => b?.type === 'text' && typeof b.text === 'string');
        text = textBlock?.text || '';
    } else if (typeof response?.content === 'string') {
        text = response.content;
    } else {
        text = response?.message || '';
    }

    return stripThinkTags(text.trim());
}

function stripThinkTags(text) {
    return text.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
}
