/**
 * Vector Service — ST 내장 벡터 API를 통한 임베딩/검색
 * 사용자가 설정한 벡터 소스를 그대로 사용
 */

import { getRequestHeaders } from '../../../../script.js';
import { oai_settings } from '../../../openai.js';
import { textgen_types, textgenerationwebui_settings } from '../../../textgen-settings.js';

const LOG_PREFIX = '[LivingLorebook]';

/**
 * ST 벡터 설정 가져오기
 */
function getVectorSettings() {
    const ctx = SillyTavern.getContext();
    return ctx.extensionSettings?.vectors || {};
}

/**
 * 클라이언트가 직접 임베딩을 계산해서 넘겨야 하는 소스 — LL은 지원 안 함.
 * (ST vectors 확장은 WebLlmVectorProvider로 브라우저에서 임베딩을 만들어 body에 실어 보냄)
 */
const CLIENT_EMBEDDING_SOURCES = new Set(['webllm', 'koboldcpp']);

/**
 * 벡터 요청 바디 공통 파라미터.
 *
 * ST 본체(public/scripts/extensions/vectors/index.js getVectorsRequestBody)의 소스별 매핑을
 * 그대로 복제. 소스마다 필요한 필드(model/apiUrl/api/vertexai_*)가 달라서, 예전처럼
 * `togetherai_model || openai_model || ...` 로 아무거나 집어 보내면 엉뚱한 모델명이 서버로 감.
 */
function getVectorsRequestBody(additionalArgs = {}) {
    const v = getVectorSettings();
    const source = v.source || 'transformers';
    const body = { ...additionalArgs, source };

    switch (source) {
        case 'extras': {
            const ctx = SillyTavern.getContext();
            body.extrasUrl = ctx.extensionSettings?.apiUrl;
            body.extrasKey = ctx.extensionSettings?.apiKey;
            break;
        }
        case 'electronhub': body.model = v.electronhub_model; break;
        case 'openrouter': body.model = v.openrouter_model; break;
        case 'togetherai': body.model = v.togetherai_model; break;
        case 'openai': body.model = v.openai_model; break;
        case 'cohere': body.model = v.cohere_model; break;
        case 'chutes': body.model = v.chutes_model; break;
        case 'nanogpt': body.model = v.nanogpt_model; break;
        case 'ollama':
            body.model = v.ollama_model;
            body.apiUrl = v.use_alt_endpoint ? v.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.OLLAMA];
            body.keep = !!v.ollama_keep;
            break;
        case 'llamacpp':
            body.apiUrl = v.use_alt_endpoint ? v.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP];
            break;
        case 'vllm':
            body.model = v.vllm_model;
            body.apiUrl = v.use_alt_endpoint ? v.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.VLLM];
            break;
        case 'palm':
            body.model = v.google_model;
            body.api = 'makersuite';
            break;
        case 'vertexai':
            body.model = v.google_model;
            body.api = 'vertexai';
            body.vertexai_auth_mode = oai_settings.vertexai_auth_mode;
            body.vertexai_region = oai_settings.vertexai_region;
            body.vertexai_express_project_id = oai_settings.vertexai_express_project_id;
            break;
        case 'siliconflow':
            body.model = v.siliconflow_model;
            body.siliconflow_endpoint = oai_settings.siliconflow_endpoint;
            break;
        case 'workers_ai':
            body.model = v.workers_ai_model || '@cf/baai/bge-m3';
            body.workers_ai_account_id = oai_settings.workers_ai_account_id;
            break;
        // mistral / nomicai / transformers 는 서버가 모델을 고정하므로 추가 필드 없음
    }

    return body;
}

/**
 * 현재 임베딩 소스 정보 (UI 표시 / 변경 감지용)
 * @returns {{source: string, model: string}}
 */
export function getVectorSourceInfo() {
    const body = getVectorsRequestBody();
    return { source: body.source, model: String(body.model || '') };
}

/**
 * 임베딩 소스 시그니처. 소스나 모델이 바뀌면 벡터 차원이 달라져서 기존 인덱스와 섞이면
 * 검색이 깨짐 → 이 값을 재색인 시점에 저장해두고 불일치하면 벡터 경로를 막는다.
 */
export function getVectorSourceSignature() {
    const { source, model } = getVectorSourceInfo();
    return `${source}:${model}`;
}

/**
 * 이 소스를 LL이 쓸 수 있는지 검사. 못 쓰면 이유를 담은 Error를 던진다.
 */
function assertSourceUsable() {
    const { source } = getVectorSourceInfo();
    if (CLIENT_EMBEDDING_SOURCES.has(source)) {
        throw new Error(`벡터 소스 '${source}'는 브라우저에서 임베딩을 만들어야 해서 LL이 지원하지 않습니다. ST 벡터 설정에서 다른 소스를 골라주세요.`);
    }
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

// 임베딩 입력 길이 캡 — 소스별로 다름. 검색용 벡터만 앞부분 기준으로 만들고
// 실제 엔트리 본문/주입 내용은 안 건드림.
//
// transformers: ST 번들 모델(Xenova/all-mpnet-base-v2)은 ~384토큰까지만 처리 가능 —
//   넘으면 onnxruntime이 OrtRun error 6로 죽음. 영어 기준 1000자면 안전 마진 충분.
// 원격(gemini/openai 등): 입력 한도가 2048토큰 안팎이라 훨씬 여유 있음. 6000자 ≈ 1.5k토큰.
const LOCAL_EMBED_MAX_CHARS = 1000;
const REMOTE_EMBED_MAX_CHARS = 6000;

function embedMaxChars() {
    return (getVectorSettings().source || 'transformers') === 'transformers'
        ? LOCAL_EMBED_MAX_CHARS
        : REMOTE_EMBED_MAX_CHARS;
}

function clampForEmbedding(text) {
    const s = String(text ?? '');
    const max = embedMaxChars();
    return s.length > max ? s.slice(0, max) : s;
}

/**
 * 현재 소스의 임베딩 입력 한도(문자). 호출부가 예산에 맞춰 텍스트를 직접 조립할 때 쓴다.
 * — 채팅 쿼리는 앞에서 자르면(clampForEmbedding) 정작 최신 대화가 날아가므로,
 *   호출부가 최신부터 역순으로 담아야 한다.
 */
export function getEmbedMaxChars() {
    return embedMaxChars();
}

/**
 * 실패한 응답에서 서버 메시지를 뽑아 에러에 붙인다. (401/404 원인 파악용)
 */
async function describeFailure(response, what) {
    let detail = '';
    try {
        detail = (await response.text()).slice(0, 300);
    } catch { /* 본문 없음 */ }
    const { source, model } = getVectorSourceInfo();
    return new Error(`${what} 실패 (${response.status} ${response.statusText}) [${source}${model ? '/' + model : ''}]${detail ? ' — ' + detail : ''}`);
}

/**
 * 엔트리들을 벡터 DB에 삽입
 */
export async function insertEntries(collectionId, entries) {
    const items = entries.map(e => ({
        // 해시 = uid only. 내용 수정해도 해시 고정 → 쿼리 결과를 uid로 안정 매핑 (고아 방지).
        // 임베딩 자체는 stale 가능 → reindexCollection으로 갱신.
        hash: getStringHash(String(e.uid)),
        text: clampForEmbedding(`${e.title || e.comment || ''}: ${e.content}`),
    }));

    if (items.length === 0) return;

    assertSourceUsable();
    const response = await fetch('/api/vector/insert', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(),
            collectionId: collectionId,
            items: items,
        }),
    });

    if (!response.ok) {
        throw await describeFailure(response, `벡터 삽입 (${collectionId})`);
    }

    console.log(`${LOG_PREFIX} Inserted ${items.length} vectors into ${collectionId}`);
}

/**
 * 여러 컬렉션을 한 번에 검색.
 *
 * /query 를 컬렉션마다 부르면 **같은 검색 텍스트를 매번 다시 임베딩**한다 (컬렉션 수만큼 왕복).
 * /query-multi 는 임베딩을 1회만 하고 모든 컬렉션에 재사용 + 컬렉션을 가로질러 전역 정렬 후 topK를 자른다.
 *
 * 주의: 응답은 컬렉션별로 그룹지어 오고 **유사도 점수는 안 준다**. 각 그룹 안의 순서는
 * 전역 정렬 순서를 보존하지만, 그룹을 가로지르는 정확한 전역 순위는 복원할 수 없다.
 *
 * @returns {Promise<Record<string, {hashes: number[], metadata: object[]}>>}
 */
export async function queryMultipleCollections(collectionIds, searchText, topK = 10, threshold = 0) {
    assertSourceUsable();
    const response = await fetch('/api/vector/query-multi', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(),
            collectionIds: collectionIds,
            searchText: clampForEmbedding(searchText),
            topK: topK,
            threshold: threshold,
        }),
    });

    if (!response.ok) {
        throw await describeFailure(response, `벡터 검색 (${collectionIds.length}개 컬렉션)`);
    }

    return await response.json();
}

/**
 * 벡터 삭제
 */
export async function deleteEntries(collectionId, hashes) {
    if (!hashes || hashes.length === 0) return;

    const response = await fetch('/api/vector/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(),
            collectionId: collectionId,
            hashes: hashes,
        }),
    });

    if (!response.ok) {
        throw await describeFailure(response, `벡터 삭제 (${collectionId})`);
    }
}

/**
 * 컬렉션 전체 삭제
 */
async function purgeCollection(collectionId) {
    const response = await fetch('/api/vector/purge', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(),
            collectionId: collectionId,
        }),
    });

    if (!response.ok) {
        throw await describeFailure(response, `컬렉션 삭제 (${collectionId})`);
    }
}

/**
 * 엔트리의 벡터 해시 계산 — uid only (content 인자는 하위호환용, 무시).
 */
export function getEntryHash(uid) {
    return getStringHash(String(uid));
}

/**
 * 컬렉션 재색인 — purge 후 전체 재삽입.
 * 해시 스킴 변경/내용 수정으로 stale해진 임베딩을 한 번에 갱신.
 * @param {string} collectionId
 * @param {Array<{uid, content, title}>} entries
 */
export async function reindexCollection(collectionId, entries) {
    try {
        await purgeCollection(collectionId);
    } catch (err) {
        // 컬렉션이 아직 없을 수 있음 — 무시하고 삽입 진행
        console.log(`${LOG_PREFIX} reindex: purge skipped for ${collectionId} (${err.message})`);
    }
    await insertEntries(collectionId, entries);
}
