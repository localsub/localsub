# LocalSub 표준 기술 용어 사전 (Technical Glossary)

본 문서는 LocalSub 시스템 전반의 아키텍처 설계, 구현 명세, 엔지니어링 문서 및 다이어그램에서 사용하는 핵심 기술 용어의 정본(Canonical Reference) 기준을 정의합니다.
문서 간 용어 불일치(Drift)를 방지하고, 부자연스러운 기계 번역체, 구어체 및 의인화 비유를 배제하며, 일관되고 명확한 산업 엔지니어링 표준 어휘 체계를 유지하는 것을 목적으로 합니다.

---

## 1. 미디어 처리 및 음성/언어 신경망 인공지능 (Media Processing & Neural AI)

| 표준 기술 용어 (국문/영문) | 약어 | 기술적 정의 및 공학적 의미 | 코드베이스 대응 심볼 / 경로 | 비표준 / 지양 표현 |
|---|---|---|---|---|
| **음성 인식**<br/>(Speech-to-Text) | STT | 오디오 스트림의 음향 신호를 시계열 텍스트 토큰 및 타임스탬프 세그먼트로 변환하는 공정. CTranslate2 가속 엔진 기반 faster-whisper를 사용. | `stt_engine.py`<br/>`commands_stt.rs` | 받아쓰기, 음성 타이핑, 알아듣기 |
| **음성 활동 감지**<br/>(Voice Activity Detection) | VAD | 오디오 신호 내에서 비음성 구간(침묵, 배경 잡음)과 유효 발화 구간을 분리 판별하는 전처리 공정. faster-whisper 내장 Silero VAD 적용 (`vad_filter=True`). | `stt_engine.py` | 음성 필터링, 말소리 골라내기 |
| **화자 분리**<br/>(Speaker Diarization) | - | "누가 언제 발화했는가"를 기준으로 오디오 구간을 발화자별 세그먼트로 분할하고 클러스터링하는 공정. ONNX Runtime 음향 임베딩 추출 및 scikit-learn 응집 군집화(Agglomerative Clustering) 알고리즘 수행. | `diarization_engine.py`<br/>`src/lib/diarization.ts` | 화자 나누기, 목소리 구분, 발화자 쪼개기 |
| **신경망 기계번역**<br/>(Neural Machine Translation) | NMT / Translation | 거대 언어 모델(LLM)을 활용하여 원천 언어(Source) 자막 세그먼트를 목표 언어(Target) 문맥에 부합하도록 변환하는 공정. | `llm_engine.py`<br/>`commands_translate.rs` | 말 바꾸기, 자동 번역기 |
| **거대 언어 모델**<br/>(Large Language Model) | LLM | 트랜스포머 디코더 기반 언어 모델(Qwen3 등). 로컬 환경에서 llama-cpp-python을 통해 구동. | `llm_engine.py`<br/>`model_catalog.json` | 인공지능 두뇌, 생각하는 기계 |
| **가중치 양자화**<br/>(Weight Quantization) | - | 16비트 부동소수점(FP16) 모델 가중치를 정수 단위(Q4_K_M, Q5_K_M, Q8_0 등)로 축소하여 메모리 점유율을 줄이고 추론 속도를 최적화하는 기법. GGUF 포맷 사용. | `model_catalog.json`<br/>`SPEC.md` | 모델 압축, 용량 줄이기 |
| **퓨샷 예시 턴**<br/>(Few-shot Example Turns) | - | 현재 세그먼트 앞에 사용자/어시스턴트 대화 턴 쌍으로 주입되는 번역 예시. 용어집 항목과 직전 번역 3건(`RECENT_FEW_SHOT_WINDOW`)으로 구성되며, 앞뒤 세그먼트 원문이나 요약문은 주입하지 않음. | `prompt_builder.py`<br/>`llm_engine.py` | 기억 공간, 앞뒤 문맥 창 |
| **오디오 청킹**<br/>(Audio Chunking) | - | 60분 초과 미디어 파일의 메모리 오버플로우를 방지하기 위해 30분 단위 오디오 청크로 분할하여 순차 처리하는 배치 분할 기법. FFmpeg를 통해 수행. | `stt_engine.py`<br/>`commands_ffmpeg.rs` | 오디오 자르기, 쪼개기, 토막내기 |

---

## 2. 인터페이스 및 통신 계약 (Interface & Communication Contracts)

| 표준 기술 용어 (국문/영문) | 약어 | 기술적 정의 및 공학적 의미 | 코드베이스 대응 심볼 / 경로 | 비표준 / 지양 표현 |
|---|---|---|---|---|
| **Tauri IPC 브리지**<br/>(Tauri Inter-Process Communication Bridge) | Tauri IPC | WebKit/WebView 프론트엔드와 Rust 네이티브 백엔드 코어 간의 비동기 메시지 직렬화 통신 채널 (`window.__TAURI_INTERNALS__.invoke`). | `src/lib/tauriApi.ts`<br/>`src-tauri/src/lib.rs` | 프론트-백 연결 통로, 호출 문 |
| **로컬 추론 REST API**<br/>(Local Inference REST API) | - | Rust 코어와 독립 분리된 Python FastAPI 자식 프로세스 간의 통신 프로토콜 (루프백 IP `127.0.0.1:9111`). | `python-server/main.py`<br/>`src-tauri/src/commands_*.rs` | 파이썬 웹서버 통신, 내부 웹 API |
| **서버-전송 이벤트**<br/>(Server-Sent Events) | SSE | Python 추론 엔진에서 처리 진행률(Progress), 상태 전이 이벤트, 부분 결과를 Rust/React 계층으로 단방향 실시간 푸시하는 HTTP 기반 스트리밍 프로토콜 (`GET .../stream/{job_id}`). | `python-server/*_router.py`<br/>`src-tauri/src/job_manager.rs` | 실시간 알림, 스트림 통로 |
| **직렬화 및 역직렬화**<br/>(Serialization & Deserialization) | Serde | 언어 및 프로세스 경계를 넘어 데이터 구조를 JSON 문자열 또는 바이너리로 변환하고 환원하는 규약. | `serde`, `serde_json`<br/>`pydantic` | 데이터 포장/풀기, 직렬화 |
| **상태 페이로드**<br/>(State Payload) | - | IPC 명령 호출 또는 SSE 스트림을 통해 전달되는 엄격한 타입 정의 데이터 객체. | `src/types/*`<br/>`src-tauri/src/state.rs` | 데이터 보따리, 전달값 |
| **협조적 작업 취소**<br/>(Cooperative Job Cancellation) | - | 외부에서 스레드를 강제 종료(kill)하지 않고, 실행 루프가 원자적 플래그(`cancel_requested`)를 주기적으로 폴링하여 안전하게 자원을 회수하고 종료하는 메커니즘. | `POST .../cancel/{job_id}`<br/>`stt_engine.py`, `llm_engine.py` | 강제 중단, 날려버리기 |

---

## 3. 프로세스 수명주기 및 리소스 거버넌스 (Process Lifecycle & Resource Governance)

| 표준 기술 용어 (국문/영문) | 약어 | 기술적 정의 및 공학적 의미 | 코드베이스 대응 심볼 / 경로 | 비표준 / 지양 표현 |
|---|---|---|---|---|
| **자식 프로세스 관리자**<br/>(Subprocess Lifecycle Manager) | - | 임베디드 Python 런타임을 무창(`CREATE_NO_WINDOW`) 자식 프로세스로 스폰하고 표준 에러(stderr) 스트림을 전용 로그 파일로 리다이렉트하는 관리 체계. | `src-tauri/src/python_manager.rs` | 파이썬 부모자식, 서브프로세스 살리기 |
| **비디오 메모리 재할당 핸드오버**<br/>(VRAM Reallocation Handover) | - | STT(faster-whisper)와 NMT(llama-cpp-python) 간의 비디오 메모리 충돌을 방지하기 위해, 단계 전환 시 추론 서버 프로세스를 정상 재시작하여 VRAM을 100% 완전 회수하는 자원 분할 점유 전략. | `usePipeline.ts`<br/>`commands_runtime.rs` | GPU 넘겨주기, VRAM 뺏기, 메모리 던지기 |
| **상태 머신**<br/>(State Machine) | - | 파이프라인 및 백엔드 서버의 상태 집합(`STOPPED`, `STARTING`, `HEALTHY`, `BUSY`, `ERROR`)과 허용된 전이(Transition) 규칙 체계. | `RuntimeStatus`<br/>`JobStatus` | 상태 변화 표, 진행 단계 |
| **장애 감지 및 페일오버 복구**<br/>(Fault Detection & Failover Recovery) | - | 런타임 헬스체크 폴링 실패 시 `server-crashed` 이벤트를 브로드캐스트하고, 활성 파이프라인의 안전 상태 보존 후 프론트엔드 감시기를 통해 서버를 자동 재시작하는 무중단 방어 기제. | `useServerStatus.ts`<br/>`commands_runtime.rs` | 크래시 수습, 살려내기 |
| **지연 로딩**<br/>(Lazy Loading) | - | 애플리케이션 시작 시 모든 설정 및 매니페스트를 선점 로드하지 않고, 최초 요청 시점에 안전하게 역직렬화하여 동시성 경합(Race Condition)을 원천 방지하는 패턴. | `config_manager::ensure_loaded` | 늦게 불러오기, 미루기 로드 |
| **체크포인트 복구**<br/>(Checkpoint Resume) | - | 대규모 일괄 작업 도중 예기치 못한 중단이 발생하더라도, 완료된 세그먼트 상태를 원자적으로 영속화하여 미처리 구간부터 재개하는 내고장성 기법. | `src/lib/checkpoint.ts` | 이어받기, 중간 저장 이어하기 |

---

## 4. 품질 보증 및 무결성 게이트 (Quality Assurance & Integrity Gates)

| 표준 기술 용어 (국문/영문) | 약어 | 기술적 정의 및 공학적 의미 | 코드베이스 대응 심볼 / 경로 | 비표준 / 지양 표현 |
|---|---|---|---|---|
| **품질 게이트**<br/>(Quality Gate) | - | LLM의 번역 결과물이 실제 번역문인지, 환각(Hallucination) 또는 거부(Refusal) 응답인지 판별하는 다단계 자동 검증 파이프라인. 통과 실패 시 고온도(High Temperature) 1회 재시도 및 이상 플래그 부여. | `quality_filters.py`<br/>`embedding_gate.py`<br/>`llm_engine.py` | 검사기, 필터 문, 번역 필터 |
| **구조적 품질 필터**<br/>(Structural Quality Filters) | - | 생성된 텍스트의 문자 집합, 길이 팽창 비율, 퇴행적 반복(Degenerative Repetition), 원본 스크립트 누출을 정규식 및 휴리스틱 수치로 정량 분석하는 모델 무관 결정론적 필터. | `quality_filters.py` | 모양 검사, 텍스트 거름망 |
| **의미론적 거부 감지 게이트**<br/>(Semantic Refusal Embedding Gate) | - | 번역 대상 문장이 안전 가이드라인 등의 이유로 번역되지 않고 목표 언어로 거부 문구("죄송하지만 번역할 수 없습니다" 등)를 생성한 경우, 문장 임베딩 벡터 간 코사인 유사도를 계산하여 거부 여부를 의미론적으로 판별하는 최종 게이트. | `embedding_gate.py` | 거절 알아채기, 뜻 검사기 |
| **용어집 제약 조건**<br/>(Vocabulary Constraints) | - | 특정 고유명사, 전문 기술 용어, 인명/지명의 번역 표기를 고정하기 위해 프롬프트 및 후처리에 강제 주입하는 정합성 딕셔너리. | `vocabulary_manager.rs`<br/>`prompt_builder.py` | 단어장, 용어 박기 |

---

## 5. 공급망 보안 및 운영 거버넌스 (Supply Chain Security & Governance)

| 표준 기술 용어 (국문/영문) | 약어 | 기술적 정의 및 공학적 의미 | 코드베이스 대응 심볼 / 경로 | 비표준 / 지양 표현 |
|---|---|---|---|---|
| **암호학적 해시 고정**<br/>(Cryptographic Hash Pinning) | - | 첫 실행 셋업 시 다운로드되는 모든 외부 바이너리(Python 패키지, prebuilt 휠, FFmpeg 아카이브, C++ 런타임 인스톨러)의 SHA-256 해시를 사전에 고정 명세하여 위변조를 차단하는 보안 기법. | `src-tauri/resources/integrity.json`<br/>`src-tauri/src/integrity.rs` | 해시 박기, 변조 방지 체크 |
| **의존성 폐포 무결성 검증**<br/>(Dependency Closure Verification) | - | 간접 전이 의존성을 포함한 모든 Python 휠의 정확한 파일명과 SHA-256 체크섬을 고정하고, `pip install --require-hashes`를 통해 1비트의 변조도 허용하지 않는 엄격한 프로비저닝 프로토콜. | `python-server/requirements.lock` | 락파일 맞추기, 패키지 검사 |
| **직접 업스트림 다운로드**<br/>(Direct Upstream Ingestion) | - | 외부 오픈소스 바이너리(예: FFmpeg)의 제3자 재배포/미러링에 따른 라이선스(GPLv3) 전달자(Conveyer) 법적 의무 및 소스 코드 일치 증명 위험을 배제하기 위해, 클라이언트가 공식 벤더 CDN/릴리스로부터 직접 인출하도록 설계된 무미러 아키텍처. | `bundled_ffmpeg_is_not_self_hosted`<br/>`FfmpegEntry` | 미러 금지, 직접 긁어오기 |
| **정적 로컬 경로 누출 방지 가드**<br/>(Static Local Path Leak Guard) | - | 빌드 산출물 및 번들 리소스 트리 내에 개발자 로컬 환경의 절대 경로(`C:\Users\...`, `/home/...` 등)가 포함되는 것을 빌드 선행 단계에서 정규식으로 전수 검사하여 차단하는 배포 무결성 검증기. | `scripts/check-no-local-paths.mjs`<br/>`src/__tests__/localPathGuard.test.ts` | 경로 새는 것 막기, 계정명 방어 |
| **라이선스 거버넌스**<br/>(License Governance) | - | 애플리케이션 코어 라이선스(PolyForm Noncommercial 1.0.0), 번들 런타임(PSF Python, MIT pip), 외부 도구(GPLv3 FFmpeg), AI 가중치(Apache 2.0 / MIT / Gemma)의 법적 요구사항 및 재배포 고지 의무를 엄격히 분리 관리하는 정책. | `LICENSE`<br/>`model_catalog.json` | 라이선스 룰, 저작권 관리 |

---

## 6. 문서 작성 및 코드 스타일 표준 규칙

1. **명확한 주어와 술어**: 문장의 주체(시스템, 모듈, 프로세스, 사용자)를 명시하고, 수동태나 주어가 누락된 AI 번역투를 사용하지 않습니다.
   - *부적절*: 자막이 생성되는 것이 가능하며 고려되어야 합니다.
   - *표준*: 시스템은 오디오 스트림으로부터 타임스탬프가 부여된 자막 세그먼트를 생성합니다.
2. **소설적 의인화 및 감정적 표현 배제**: 코드, 프로세스, 데이터에 인격을 부여하거나 감정을 투영하지 않습니다.
   - *부적절*: 데이터가 메모리에 살고 있으며, 모델이 어디서 흔들렸는지 살펴봅니다.
   - *표준*: 데이터는 물리 메모리에 상주하며, 품질 게이트 임계치를 충족하지 못한 세그먼트를 검출합니다.
3. **공학적 사실과 불변식의 보존**: 심볼명, 포트 번호, 해시 알고리즘, 지원 포맷, 라이선스 식별자 등 기술적 사실은 임의로 축약하거나 변경하지 않고 100% 정합성을 유지합니다.
