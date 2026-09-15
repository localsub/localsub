/**
 * scripts/verify-diagrams.mjs
 *
 * docs/diagrams/ 내 모든 SVG 다이어그램의 시각적 기하 구조 및 렌더링 무결성을 검증하는 도구.
 * 3대 결함(Canvas/Rect Overflow, Text Collision, Box Overflow) 0건 여부와
 * sharp를 통한 무손실 래스터화(PNG 렌더링)를 전수 검증합니다.
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIAGRAMS_DIR = join(__dirname, "..", "docs", "diagrams");

if (!existsSync(DIAGRAMS_DIR)) {
  console.error(`[verify-diagrams] Directory does not exist: ${DIAGRAMS_DIR}`);
  process.exit(1);
}

const svgFiles = readdirSync(DIAGRAMS_DIR).filter((f) => f.endsWith(".svg"));

if (svgFiles.length === 0) {
  console.error(`[verify-diagrams] No SVG files found in ${DIAGRAMS_DIR}`);
  process.exit(1);
}

// ── 폰트 메트릭스 추정 함수 ──────────────────────────────────────────────────
function estimateTextWidth(text, fontSize) {
  let width = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    // 한글 및 CJK 완성형/자모
    if ((code >= 0xac00 && code <= 0xd7a3) || (code >= 0x1100 && code <= 0x11ff) || (code >= 0x3000 && code <= 0x9fff)) {
      width += fontSize * 1.0;
    } else if (/[A-Z0-9@#%&+]/.test(char)) {
      width += fontSize * 0.65;
    } else if (/[a-z]/.test(char)) {
      width += fontSize * 0.55;
    } else if (/\s/.test(char)) {
      width += fontSize * 0.32;
    } else if (/[-•,.:;'"!_()/]/.test(char)) {
      width += fontSize * 0.38;
    } else {
      width += fontSize * 0.6;
    }
  }
  return width;
}

// ── 단일 SVG 검증 함수 ──────────────────────────────────────────────────────
async function verifySvg(filename) {
  const filePath = join(DIAGRAMS_DIR, filename);
  const rawSvg = readFileSync(filePath, "utf-8");
  const errors = [];

  // 1. Sharp 래스터화 스모크 테스트 (SVG 구문 무결성)
  try {
    const pngBuffer = await sharp(Buffer.from(rawSvg)).png().toBuffer();
    if (pngBuffer.length < 100) {
      errors.push({ type: "RasterizationError", detail: "Rendered PNG buffer is suspiciously small." });
    }
  } catch (err) {
    errors.push({ type: "Syntax/RasterizationError", detail: err.message });
  }

  // 2. DOM 파싱 및 기하 구조 분석
  const dom = new JSDOM(rawSvg, { contentType: "image/svg+xml" });
  const doc = dom.window.document;
  const svgEl = doc.querySelector("svg");

  if (!svgEl) {
    errors.push({ type: "StructureError", detail: "Root <svg> element missing." });
    return { filename, errors, textCount: 0, rectCount: 0 };
  }

  const canvasW = parseFloat(svgEl.getAttribute("width") || "0");
  const canvasH = parseFloat(svgEl.getAttribute("height") || "0");

  const rects = Array.from(doc.querySelectorAll("rect")).map((r, i) => {
    return {
      id: r.id || `rect-${i}`,
      x: parseFloat(r.getAttribute("x") || "0"),
      y: parseFloat(r.getAttribute("y") || "0"),
      width: parseFloat(r.getAttribute("width") || "0"),
      height: parseFloat(r.getAttribute("height") || "0"),
      element: r,
    };
  });

  const texts = Array.from(doc.querySelectorAll("text")).map((t, i) => {
    const content = t.textContent.trim();
    const x = parseFloat(t.getAttribute("x") || "0");
    const y = parseFloat(t.getAttribute("y") || "0");

    let fontSize = 12;
    const fontAttr = t.getAttribute("font-size");
    if (fontAttr) {
      fontSize = parseFloat(fontAttr);
    } else {
      const cls = t.getAttribute("class") || "";
      if (cls.includes("title")) fontSize = 20;
      else if (cls.includes("subtitle")) fontSize = 13;
      else if (cls.includes("section-title")) fontSize = 14;
      else if (cls.includes("card-title")) fontSize = 13;
      else if (cls.includes("step-title")) fontSize = 13;
      else if (cls.includes("step-num")) fontSize = 12;
      else if (cls.includes("card-body")) fontSize = 12;
      else if (cls.includes("step-desc")) fontSize = 11;
      else if (cls.includes("badge-text") || cls.includes("proto-text")) fontSize = 11;
      else if (cls.includes("conn-label")) fontSize = 10;
    }

    const estimatedWidth = estimateTextWidth(content, fontSize);
    return {
      id: t.id || `text-${i}`,
      content,
      x,
      y,
      fontSize,
      estimatedWidth,
      element: t,
    };
  });

  // 3. 결함 1: Canvas / Rect Overflow 검증
  for (const t of texts) {
    // 3-1. 캔버스 경계 이탈 검사
    if (t.x + t.estimatedWidth > canvasW - 8) {
      errors.push({
        type: "CanvasOverflow",
        detail: `Text "${t.content}" exceeds canvas width: end=${(t.x + t.estimatedWidth).toFixed(1)} > canvas=${canvasW}`,
      });
    }

    // 3-2. 텍스트를 감싸는 가장 작은 감싸는 사각형(Enclosing Box) 찾기
    const enclosingRects = rects.filter((r) => {
      // 텍스트의 x, y가 rect의 좌표 범위 내에 시작하는지
      return t.x >= r.x && t.x <= r.x + r.width && t.y >= r.y && t.y <= r.y + r.height;
    });

    if (enclosingRects.length > 0) {
      // 가장 좁은(가장 구체적인) rect 선택
      enclosingRects.sort((a, b) => a.width * a.height - b.width * b.height);
      const box = enclosingRects[0];
      const textRight = t.x + t.estimatedWidth;
      const boxRight = box.x + box.width;

      // 텍스트가 박스 우측 경계를 넘는지 검사 (약간의 측정 오차 여유 4px 고려)
      if (textRight > boxRight + 4) {
        errors.push({
          type: "RectOverflow",
          detail: `Text "${t.content}" exceeds enclosing box: textRight=${textRight.toFixed(1)} > boxRight=${boxRight.toFixed(1)} (box: ${box.id || `x:${box.x}`})`,
        });
      }
    }
  }

  // 4. 결함 2: Text Collision 검증
  // 같은 영역에 있는 텍스트들 중 y좌표가 너무 인접하여 줄이 겹치는지 검사
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const t1 = texts[i];
      const t2 = texts[j];

      // x좌표가 중첩되는지 확인
      const xOverlap = Math.max(0, Math.min(t1.x + t1.estimatedWidth, t2.x + t2.estimatedWidth) - Math.max(t1.x, t2.x));
      if (xOverlap > 10) {
        // x가 겹치는데 y좌표 차이가 너무 작으면(최소 줄 간격 미달) 충돌
        const yDiff = Math.abs(t1.y - t2.y);
        const minLineGap = Math.max(t1.fontSize, t2.fontSize) * 0.78;
        if (yDiff < minLineGap) {
          errors.push({
            type: "TextCollision",
            detail: `Collision detected between "${t1.content}" (y=${t1.y}) and "${t2.content}" (y=${t2.y}): yDiff=${yDiff.toFixed(1)} < minGap=${minLineGap.toFixed(1)}`,
          });
        }
      }
    }
  }

  // 5. 결함 3: Box Overflow 검증
  // 자식 박스가 부모 박스의 경계를 삐져나가는지 검사
  for (let i = 0; i < rects.length; i++) {
    for (let j = 0; j < rects.length; j++) {
      if (i === j) continue;
      const child = rects[i];
      const parent = rects[j];

      // child의 중심점이 parent 내부에 위치하는지 확인
      const childCenterX = child.x + child.width / 2;
      const childCenterY = child.y + child.height / 2;

      if (
        childCenterX > parent.x &&
        childCenterX < parent.x + parent.width &&
        childCenterY > parent.y &&
        childCenterY < parent.y + parent.height &&
        child.width < parent.width &&
        child.height < parent.height
      ) {
        // child가 parent 내부에 설계된 자식 박스임
        // 자식 박스가 부모 박스 경계를 벗어나는지 확인
        const overflowLeft = child.x < parent.x - 0.1;
        const overflowRight = child.x + child.width > parent.x + parent.width + 0.1;
        const overflowTop = child.y < parent.y - 0.1;
        const overflowBottom = child.y + child.height > parent.y + parent.height + 0.1;

        if (overflowLeft || overflowRight || overflowTop || overflowBottom) {
          errors.push({
            type: "BoxOverflow",
            detail: `Box [${child.id} (${child.x},${child.y},${child.width}x${child.height})] overflows parent [${parent.id} (${parent.x},${parent.y},${parent.width}x${parent.height})]`,
          });
        }
      }
    }
  }

  return {
    filename,
    errors,
    textCount: texts.length,
    rectCount: rects.length,
    canvas: `${canvasW}x${canvasH}`,
  };
}

// ── 실행 ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[verify-diagrams] Verifying ${svgFiles.length} diagram files in ${DIAGRAMS_DIR}...\n`);

  let totalErrors = 0;
  for (const file of svgFiles) {
    const result = await verifySvg(file);
    if (result.errors.length === 0) {
      console.log(`  ✓ ${file} [${result.canvas}, ${result.rectCount} rects, ${result.textCount} texts] — CLEAN`);
    } else {
      console.error(`  ✗ ${file} [${result.canvas}] — ${result.errors.length} defect(s) detected:`);
      for (const err of result.errors) {
        console.error(`    - [${err.type}] ${err.detail}`);
      }
      totalErrors += result.errors.length;
    }
  }

  console.log(`\n[verify-diagrams] Verification finished with ${totalErrors} total defect(s).`);
  if (totalErrors > 0) {
    process.exit(1);
  } else {
    console.log("[verify-diagrams] 100% PASS: All diagrams are completely free of overflows and collisions.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Unhandled error in verification:", err);
  process.exit(1);
});
