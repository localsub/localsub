import { readFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const svgPath = resolve(root, "public/logo.svg");
const iconsDir = resolve(root, "src-tauri/icons");

mkdirSync(iconsDir, { recursive: true });

const svgBuf = readFileSync(svgPath);

const sizes = [
  { name: "32x32.png", size: 32 },
  { name: "128x128.png", size: 128 },
  { name: "128x128@2x.png", size: 256 },
];

for (const { name, size } of sizes) {
  await sharp(svgBuf).resize(size, size).png().toFile(resolve(iconsDir, name));
  console.log(`  ✓ ${name}`);
}

// Generate ICO with multiple sizes
const icoSizes = [16, 32, 48, 256];
const icoPngs = await Promise.all(
  icoSizes.map((s) => sharp(svgBuf).resize(s, s).png().toBuffer()),
);
const icoBuf = await pngToIco(icoPngs);
const icoPath = resolve(iconsDir, "icon.ico");
const { writeFileSync } = await import("fs");
writeFileSync(icoPath, icoBuf);
console.log("  ✓ icon.ico");

console.log("\nDone! Icons written to src-tauri/icons/");
