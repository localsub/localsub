# LocalSub 랜딩 페이지 아키텍처 및 배포 가이드 (Landing Page)

LocalSub 랜딩 페이지는 외부 빌드 단계 없이 독립적으로 제공되는 정적 웹 애플리케이션(`landing/index.html`)으로 구성되어 있습니다. Tailwind CSS 및 바닐라 JavaScript를 기반으로 구현되어 단일 정적 호스팅 환경(GitHub Pages, Cloudflare Pages, S3 등)에 즉시 배포 가능합니다.

## 1. 릴리스 다운로드 및 링크 설정

`landing/index.html` 하단의 `CONFIG` 블록을 통해 릴리스 엔드포인트 및 메타데이터를 구성합니다:

```js
const CONFIG = {
  REPO_URL:    "https://github.com/localsub/localsub",
  RELEASE_URL: "https://github.com/localsub/localsub/releases/latest",
  VERSION:     "v0.1.3",
  SIZE:        "약 48 MB",
};
```

- `RELEASE_URL`이 빈 문자열인 경우 다운로드 버튼은 비활성화 상태("출시 준비 중 / Coming soon")로 안전하게 전환됩니다.
- `REPO_URL`이 빈 문자열인 경우 GitHub 저장소 링크가 인터페이스에서 자동으로 숨김 처리됩니다.

## 2. 미디어 슬롯 및 자산 구성 (Media Configuration)

모든 미디어 슬롯은 파일 부재 시 내장된 기본 UI 컴포넌트(파형, 큐 카드, 아이콘)로 자동 대체되는 폴백(Graceful Fallback) 메커니즘을 내장하고 있습니다.
실제 캡처 이미지 및 데모 비디오를 구성하려면 `landing/assets/` 경로에 자산을 배치하고 `MEDIA` 객체를 업데이트합니다:

```js
const MEDIA = {
  heroVideo:  "assets/hero-demo.mp4",   // 히어로 섹션 비디오 데모 (16:10 비율)
  heroPoster: "assets/hero-poster.jpg", // 비디오 로드 전 또는 미지원 브라우저용 포스터 이미지
  editor:     "assets/editor.png",      // 메인 에디터 대시보드 캡처 (고해상도 피처 카드)
  features: {
    speaker: "assets/speaker.png",      // 화자 분리 및 이중 언어 자막 목록
    batch:   "assets/batch.png",        // 배치 작업 큐 및 진행 상태 화면
    models:  "assets/models.png",       // 모델 관리 및 GPU 하드웨어 감지 패널
  },
};
```

- `.mp4`, `.webm`, `.mov` 포맷은 음소거 자동 재생 루프로 렌더링되며, 기타 이미지 포맷은 표준 고해상도 그래픽으로 출력됩니다.

### 권장 미디어 자산 규격

| 슬롯 식별자 | 캡처 대상 및 콘텐츠 요구사항 | 파일 포맷 | 권장 해상도 및 종횡비 |
|---|---|---|---|
| `heroVideo` | 파일 드래그앤드롭 → STT 실시간 스트리밍 → 신경망 번역 → 자막 내보내기 흐름 | MP4/WebM (음소거, ~10초 루프) | **16:10**, 가로 ≥1280px (수 MB 이내 최적화) |
| `editor` | 통합 자막 에디터: 오디오 파형 + 화자 라벨 + 이중 언어 라인 단위 편집 | PNG | **16:10**, 가로 ≥1600px |
| `features.speaker` | 화자 라벨이 부여된 이중 언어 세그먼트 목록 | PNG | **16:10** |
| `features.batch` | 복수 작업 큐 일괄 처리 및 진행률 상태 | PNG | **16:10** |
| `features.models` | 모델 다운로드 진행률 및 하드웨어 사양 진단 카드 | PNG | **16:10** |
| **Open Graph (OG)** | 소셜 미리보기 대표 이미지 (에디터 전경 뷰) | PNG / JPG | **1200×630** (고정 규격) |

## 3. 소셜 메타데이터 (Open Graph / Twitter Card)

소셜 플랫폼 및 메신저 크롤러는 클라이언트 자바스크립트를 실행하지 않으므로, Open Graph 태그는 `index.html`의 `<head>` 태그 내에 정적으로 선언되어 있습니다.
`og-image.png` (1200×630) 자산을 루트에 배치하고 정식 배포 도메인(`https://localsub.app`)을 `og:url`에 설정합니다.
