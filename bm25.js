/**
 * BM25 Ranker — pure JS, vector 인덱스 의존성 0.
 *
 * 매 호출에 즉석 계산. 토큰화 → IDF/TF 계산 → score 정렬.
 * entries 200개에 ~50ms 정도.
 *
 * 사용:
 *   const ranker = buildBM25(entries, { textOf: e => `${e.title} ${e.summary} ${e.content}` });
 *   const top = ranker.search(queryText, topK);
 */

// 한글/영문/숫자 토큰 추출. 1자 이하 stopword.
const TOKEN_RE = /[\w가-힣]{2,}/g;

// 흔한 stopwords (한/영). lightweight — 정확도엔 큰 영향 X
const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'were', 'has', 'have', 'had',
    'from', 'they', 'them', 'their', 'which', 'when', 'where', 'what', 'will', 'would', 'could',
    '그리고', '그래서', '하지만', '그러나', '이것', '저것', '있다', '없다', '되다', '하다',
    '있는', '없는', '같은', '다른', '많은', '작은', '큰',
]);

function tokenize(text) {
    if (!text) return [];
    const lower = text.toLowerCase();
    const tokens = [];
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(lower))) {
        const tok = m[0];
        if (STOPWORDS.has(tok)) continue;
        tokens.push(tok);
    }
    return tokens;
}

/**
 * @param {Array} entries - 임의 객체 배열
 * @param {object} options
 * @param {(e: any) => string} options.textOf - entry → 문서 텍스트 변환기
 * @param {(e: any) => string} [options.titleOf] - title 추출 (가중치용)
 * @param {number} [options.k1=1.5]
 * @param {number} [options.b=0.75]
 * @param {number} [options.titleBoost=3] - title 단어 가중치 (반복 횟수)
 * @returns {{ search: (q: string, k: number) => Array<{entry: any, score: number}> }}
 */
export function buildBM25(entries, {
    textOf,
    titleOf = (e) => e.title || '',
    k1 = 1.5,
    b = 0.75,
    titleBoost = 3,
} = {}) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return { search: () => [] };
    }

    // 1. 각 문서 토큰화 (+title boost)
    const docTokens = entries.map(e => {
        const titleTokens = tokenize(titleOf(e));
        const bodyTokens = tokenize(textOf(e));
        // title 단어를 titleBoost번 반복해서 TF 증폭
        const boosted = [];
        for (let i = 0; i < titleBoost; i++) boosted.push(...titleTokens);
        return [...boosted, ...bodyTokens];
    });

    // 2. 문서 길이 + 평균
    const docLengths = docTokens.map(t => t.length);
    const avgDocLen = docLengths.reduce((a, b) => a + b, 0) / Math.max(1, entries.length);

    // 3. document frequency (df) — 각 term이 등장한 문서 수
    const df = new Map();
    for (const tokens of docTokens) {
        const uniqueInDoc = new Set(tokens);
        for (const t of uniqueInDoc) {
            df.set(t, (df.get(t) || 0) + 1);
        }
    }
    const N = entries.length;

    // 4. 문서별 term frequency (tf) — Map<term, count>
    const docTF = docTokens.map(tokens => {
        const tf = new Map();
        for (const t of tokens) {
            tf.set(t, (tf.get(t) || 0) + 1);
        }
        return tf;
    });

    // 5. IDF 계산 — 미리 캐시
    function idf(term) {
        const n_t = df.get(term) || 0;
        return Math.log(1 + (N - n_t + 0.5) / (n_t + 0.5));
    }

    function search(queryText, topK = 30) {
        const queryTokens = tokenize(queryText);
        if (queryTokens.length === 0) return [];
        // unique query terms (중복 무시 — 그게 BM25 표준)
        const queryUnique = [...new Set(queryTokens)];

        // 각 문서 score
        const scores = [];
        for (let i = 0; i < entries.length; i++) {
            const tf = docTF[i];
            const dl = docLengths[i];
            let score = 0;
            for (const term of queryUnique) {
                const t_tf = tf.get(term);
                if (!t_tf) continue;
                const normTF = (t_tf * (k1 + 1)) / (t_tf + k1 * (1 - b + b * dl / avgDocLen));
                score += idf(term) * normTF;
            }
            if (score > 0) {
                scores.push({ entry: entries[i], score });
            }
        }

        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, topK);
    }

    return { search };
}
