// Generates landing/shots/assets/sample.mp4 — a tiny clip (cinematic gradient
// video + dynamic audio) that the capture harness serves via a Playwright
// route, so the editor's waveform renders from real decoded audio.
//
//   node landing/shots/gen-sample.mjs   (requires ffmpeg on PATH)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, "assets", "sample.mp4");

const audio =
  "aevalsrc='0.4*sin(220*2*PI*t)*(0.5+0.5*sin(2*PI*t*1.7))" +
  "+0.2*sin(330*2*PI*t)*(0.5+0.5*sin(2*PI*t*0.9)):d=8'";

await execFileP("ffmpeg", [
  "-y",
  "-f", "lavfi", "-i",
  "gradients=s=640x400:c0=0x141a36:c1=0x3b1f52:c2=0x0e1020:c3=0x241540:" +
    "x0=0:y0=0:x1=640:y1=400:nb_colors=4:d=8",
  "-f", "lavfi", "-i", audio,
  "-map", "0:v", "-map", "1:a",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
  out,
]);
console.log("wrote", out);
