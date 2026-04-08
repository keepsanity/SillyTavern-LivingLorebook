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
 */
export async function callLLM(systemPrompt, userPrompt, maxTokens, settings) {
    if (settings.profileId && _context?.ConnectionManagerRequestService) {
        return await callProfileAPI(systemPrompt, userPrompt, maxTokens, settings.profileId);
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
    } else {
        text = response?.content || response?.message || '';
    }

    return stripThinkTags(text.trim());
}

function stripThinkTags(text) {
    return text.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
}
