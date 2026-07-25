# Living Lorebook
SillyTavern 확장. 로어북을 수동으로 관리하는 대신, **AI가 대화에서 기억을 정리하고 매 생성 직전 관련 로어만 골라 주입**합니다. Made mostly for personal use (_._)

## 선택 엔진

| 엔진 | 동작 | 속도 |
|---|---|---|
| **hybrid** (기본) | BM25 + 벡터를 RRF로 융합 | ~0.3초 |
| vector | 의미 검색만 | ~0.3초 |
| bm25 | 텍스트 매칭만 (임베딩 불필요) | ~10ms |
| ai | AI가 summary 보고 선택 (정밀) | 10~20초 |

임베딩 소스는 ST의 **Vector Storage** 설정을 그대로 따라갑니다. 로컬 `transformers`는 환경에 따라 크래시가 나므로 원격 소스(Ollama, Google, OpenAI 등)를 권장합니다.

## LICENSE
**AGPL-3.0** — 자세한 내용은 [LICENSE](LICENSE) 참조.

Inspired By
- [SillyTavern](https://github.com/SillyTavern/SillyTavern)
- [sillytavern-DeepLore](https://github.com/pixelnull/sillytavern-DeepLore)
- [SillyTavern-MemoryBooks](https://github.com/aikohanasaki/SillyTavern-MemoryBooks)
- [TunnelVision](https://github.com/Coneja-Chibi/TunnelVision)
- [VectHare](https://github.com/Coneja-Chibi/VectHare)

---

Copyright (C) 2026 keepsanity
