# LocalSub UI 자동 캡처 하네스 (Landing Screenshot Harness)

본 도구는 Playwright 자동화 엔진을 활용하여 Tauri 백엔드를 모킹(Mocking)하고, 실제 프로덕션 React UI 렌더링 결과물을 랜딩 페이지 및 문서용 자산으로 정밀 캡처하는 테스트 하네스입니다.
프로덕션 소스코드를 일체 수정하지 않고 독립 주입 스크립트를 통해 무결한 고해상도 시각 자료를 생성합니다.

## 1. 생성 산출물 명세

| 파일 경로 | 대응 미디어 슬롯 | 콘텐츠 내용 |
|---|---|---|
| `landing/assets/editor.png` | `heroPoster`, `MEDIA.editor` | 파형 시각화, 이중 언어 자막 목록, 화자 식별 라벨이 포함된 메인 에디터 화면 |
| `landing/assets/speaker.png` | `MEDIA.features.speaker` | 화자 분리(Speaker Diarization) 결과가 반영된 자막 목록 뷰 |
| `landing/assets/batch.png` | `MEDIA.features.batch` | 복수 파일 일괄 처리 작업 큐(Job Queue) 화면 |
| `landing/assets/models.png` | `MEDIA.features.models` | 모델 다운로드 진행률 및 하드웨어 프로파일 진단 패널 |
| `landing/og-image.png` | 소셜 미리보기 메타데이터 | 1200×630 규격으로 크롭된 에디터 대표 이미지 |

상기 산출물은 `landing/index.html`의 미디어 설정 블록에 자동으로 연결됩니다.

## 2. 하네스 아키텍처 및 동작 원리

- **`mock-init.js`**: Playwright의 `addInitScript`를 통해 브라우저 컨텍스트 기동 전 주입됩니다. `window.__TAURI_INTERNALS__` 객체를 정의하여 `@tauri-apps/api`의 `invoke`, `convertFileSrc`, 이벤트 리스너를 네이티브 Rust 백엔드 대신 메모리 픽스처(설정값, 대시보드 작업, 자막 세그먼트, 모델 매니페스트 등)와 연결합니다.
- **`capture.mjs`**: Vite 개발 서버를 기동하고 Chromium 헤드리스 인스턴스를 제어하여 주요 애플리케이션 화면(대시보드 → 설정/모델 관리 → 자막 에디터)을 순차 탐색하며 무손실 캡처를 수행합니다. 오디오 파형은 Playwright 가상 라우트를 통해 실제 샘플 음원으로부터 실시간 디코딩됩니다.
- **`gen-sample.mjs`**: 테스트용 오디오/비디오 샘플 클립(`assets/sample.mp4`)을 생성합니다 (FFmpeg 의존).

## 3. 실행 가이드라인

```bash
# 1. 샘플 미디어 생성 (최초 1회 또는 sample.mp4 누락 시)
node landing/shots/gen-sample.mjs

# 2. 전체 UI 화면 자동 캡처 및 이미지 최적화 수행
node landing/shots/capture.mjs
```

## 4. 엔지니어링 제약 사항 및 고려점

본 하네스는 프로덕션 빌드의 실제 UI 컴포넌트를 정제된 목(Mock) 데이터로 렌더링하는 전용 도구입니다.
실제 런타임의 경우 비정상 종료 후 재기동 시 미완료 `processing` 작업을 `failed`로 전이하는 복구 로직이 동작하므로, 깨끗한 마케팅 및 문서용 시각 자산 생성을 위해 픽스처 상태는 의도적으로 `completed` 및 `pending` 상태만을 채택하여 캡처를 수행합니다.
