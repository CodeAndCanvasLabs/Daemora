/**
 * Generate the installer icon files from the canonical Daemora favicon.
 *
 * Source:  ui/public/favicon.svg
 * Outputs:
 *   installer/windows/assets/daemora.ico
 *   installer/macos/app-template/Daemora.app/Contents/Resources/daemora.icns
 *   installer/macos/app-template/Stop Daemora.app/Contents/Resources/daemora.icns
 *
 * Run:
 *   pnpm exec node scripts/build-installer-icons.mjs
 *
 * Idempotent — safe to re-run any time the SVG changes.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import png2icons from "png2icons";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SVG_SRC = join(ROOT, "ui/public/favicon.svg");
const WIN_ICO = join(ROOT, "installer/windows/assets/daemora.ico");
const MAC_ICNS_DAEMORA = join(
  ROOT,
  "installer/macos/app-template/Daemora.app/Contents/Resources/daemora.icns",
);
const MAC_ICNS_STOP = join(
  ROOT,
  "installer/macos/app-template/Stop Daemora.app/Contents/Resources/daemora.icns",
);

async function svgToPng(svgBuf, size) {
  // density=384 -> renders the 100×100 viewBox SVG into a sharp source
  // big enough to downsample cleanly to any of the icon sizes we need.
  return sharp(svgBuf, { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function ensureDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

async function main() {
  const svg = await readFile(SVG_SRC);
  console.log(`source: ${SVG_SRC}`);

  // png2icons accepts a single high-res PNG and generates all internal
  // resolutions. 1024×1024 is the highest size .icns supports and a
  // safe ceiling for .ico too.
  const masterPng = await svgToPng(svg, 1024);
  console.log(`rendered master PNG: ${masterPng.length} bytes`);

  const icoBuf = png2icons.createICO(masterPng, png2icons.BICUBIC, 0, false);
  if (!icoBuf) throw new Error("png2icons.createICO returned null");
  await ensureDir(WIN_ICO);
  await writeFile(WIN_ICO, icoBuf);
  console.log(`wrote ${WIN_ICO} (${icoBuf.length} bytes)`);

  const icnsBuf = png2icons.createICNS(masterPng, png2icons.BICUBIC, 0);
  if (!icnsBuf) throw new Error("png2icons.createICNS returned null");
  await ensureDir(MAC_ICNS_DAEMORA);
  await writeFile(MAC_ICNS_DAEMORA, icnsBuf);
  console.log(`wrote ${MAC_ICNS_DAEMORA} (${icnsBuf.length} bytes)`);

  await ensureDir(MAC_ICNS_STOP);
  await writeFile(MAC_ICNS_STOP, icnsBuf);
  console.log(`wrote ${MAC_ICNS_STOP} (${icnsBuf.length} bytes)`);

  console.log("done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
