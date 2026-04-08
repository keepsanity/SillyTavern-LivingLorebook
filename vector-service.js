/**
 * Vector Service — ST 내장 벡터 API를 통한 임베딩/검색
 * 사용자가 설정한 벡터 소스를 그대로 사용
 */

import { getRequestHeaders } from '../../../../script.js';

const LOG_PREFIX = '[LivingLorebook]';

/**
 * ST 벡터 설정 가져오기
 */
function getVectorSettings() {
    const ctx = SillyTavern.getContext();
    return ctx.extensionSettings?.vectors || {};
}

/**
 * 벡터 요청 바디 공통 파라미터
 */
function getVectorsRequestBody(additionalArgs = {}) {
    const vecSettings = getVectorSettings();
    return {
        source: vecSettings.source || 'transformers',
        model: vecSettings.togetherai_model || vecSettings.openai_model || vecSettings.google_model || '',
        ...additionalArgs,
    };
}

/**
 * 해시 생성 (ST의 getStringHash와 동일)
 */
export function getStringHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return hash;
}

/**
 * 컬렉션 ID 생성
 */
export function getCollectionId(lorebookName) {
    return `ll_${lorebookName}`;
}

/**
 * 엔트리들을 벡터 DB에 삽입
 */
export async function insertEntries(collectionId, entries) {
    const items = entries.map(e => ({
        hash: getStringHash(e.uid + '_' + e.content),
        text: `${e.title || e.comment || ''}: ${e.content}`,
    }));

    if (items.length === 0) return;

    const vecSettings = getVectorSettings();
    const response = await fetch('/api/vector/insert', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(),
            collectionId: collectionId,
            items: items,
            source: vecSettings.source || 'transformers',
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to insert vectors for ${collectionId}`);
    }

    console.log(`${LOG_PREFIX} Inserted ${items.length} vectors into ${collectionId}`);
}

/**
 * 벡터 검색
 */
export async function queryEntries(collectionId, searchText, topK = 10, threshold = 0.3) {
    const vecSettings = getVectorSettings();
    const response = await fetch('/api/vector/query', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(),
            collectionId: collectionId,
            searchText: searchText,
            topK: topK,
            source: vecSettings.source || 'transformers',
            threshold: threshold,
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to query vectors for ${collectionId}`);
    }

    return await response.json();
}

/**
 * 벡터 삭제
 */
export async function deleteEntries(collectionId, hashes) {
    if (!hashes || hashes.length === 0) return;

    const vecSettings = getVectorSettings();
    const response = await fetch('/api/vector/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(),
            collectionId: collectionId,
            hashes: hashes,
            source: vecSettings.source || 'transformers',
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to delete vectors from ${collectionId}`);
    }
}

/**
 * 컬렉션 전체 삭제
 */
export async function purgeCollection(collectionId) {
    const vecSettings = getVectorSettings();
    const response = await fetch('/api/vector/purge', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(),
            collectionId: collectionId,
            source: vecSettings.source || 'transformers',
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to purge collection ${collectionId}`);
    }
}

/**
 * 엔트리의 벡터 해시 계산
 */
export function getEntryHash(uid, content) {
    return getStringHash(uid + '_' + content);
}
