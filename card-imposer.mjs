import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const codename = process.argv[2];
if (!codename || !/^[a-z0-9_-]+$/i.test(codename)) {
  console.error("Usage: node submodules/card-printing/card-imposer.mjs <codename>");
  process.exit(1);
}

const root = path.join("projects", `${codename}_work`, "cards");
const csvPath = path.join(root, "data", "cards.csv");
const manifestPath = path.join(root, "design", "imports", `google-slides-${codename}`, "manifest.json");
const outDir = path.join(root, "build");
const htmlPath = path.join(outDir, `${codename}_pnp.html`);
const pdfPath = path.join(outDir, `${codename}_pnp.pdf`);
const cardInfoPath = path.join(outDir, `${codename}_card_info.png`);
const teaserPath = path.join(outDir, `${codename}_teaser.png`);
const backPath = path.join(outDir, "back_default.png");
const publishDir = path.join("submodules", `p6388-${codename}`);
const publishPnpDir = path.join(publishDir, "pnp");
const publishTtsDir = path.join(publishDir, "tts");
const mainPageImagePath = path.join("submodules", "project6388-page", "public", "images", "games", `${codename}.png`);
const cardWidthMm = 63;
const cardHeightMm = 88;
const ttsCols = 10;
const ttsRows = 7;

if (!existsSync(csvPath)) throw new Error(`Missing ${csvPath}`);

const rows = parseCsv(await readFile(csvPath, "utf8"));
const manifest = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : null;
if (!manifest && rows.some((row) => !row.svg_file)) throw new Error(`Missing ${manifestPath} or svg_file column`);
const backPng = await readFile(path.join("submodules", "card-printing", "back_default.png"));
const rawByKey = manifest ? rawFileIndex(manifest) : new Map();
const cards = [];

for (const row of rows) {
  const quantity = Number.parseInt(row.quantity || "0", 10);
  const svgPath = row.svg_file
    ? path.join(root, "svg", row.svg_file)
    : path.join(path.dirname(manifestPath), rawByKey.get(`${row.template_id}:${row.label}`) || "");
  if (!existsSync(svgPath)) throw new Error(`Missing SVG for ${row.template_id}:${row.label}`);
  const svg = await readFile(svgPath, "utf8");
  for (let index = 0; index < quantity; index += 1) cards.push({ ...row, svg });
}

await mkdir(outDir, { recursive: true });
await writeFile(backPath, backPng);
await writeFile(htmlPath, renderHtml(codename, cards), "utf8");
const frontSheets = await renderSheets(cards.map((card) => card.svg), "front_sheet");
const backSheets = await renderSheets(cards.map(() => backPng), "back_sheet");
await writeFile(cardInfoPath, await renderCardInfo(cards, backPng));
await writeFile(teaserPath, await renderTeaser(cards));

const child = spawn(process.execPath, [vivliostyleCliPath(), "build", htmlPath, "-s", "A4", "-o", pdfPath], {
  stdio: "inherit",
  shell: false,
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on("exit", async (code) => {
  await cleanupTempFiles();
  if (code) process.exit(code);
  await copyPublishOutputs(frontSheets, backSheets);
  console.log(`Saved ${pdfPath}`);
  console.log(`Saved ${cardInfoPath}`);
  console.log(`Saved ${teaserPath}`);
  for (const file of [...frontSheets, ...backSheets]) console.log(`Saved ${path.join(outDir, file.filename)}`);
  console.log(`Copied outputs to ${publishDir}`);
});

async function cleanupTempFiles() {
  await Promise.all([htmlPath, backPath].map((target) => rm(target, { force: true })));
}

async function copyPublishOutputs(frontSheets, backSheets) {
  if (!existsSync(publishDir)) return;
  await mkdir(publishPnpDir, { recursive: true });
  await mkdir(publishTtsDir, { recursive: true });
  await copyFile(pdfPath, path.join(publishPnpDir, "pnp.pdf"));
  await copyFile(cardInfoPath, path.join(publishDir, `${titleCase(codename)}_card_info.png`));
  await copyFile(teaserPath, path.join(publishDir, `${titleCase(codename)}_teaser.png`));
  if (existsSync(path.dirname(mainPageImagePath))) await copyFile(teaserPath, mainPageImagePath);
  for (const file of [...frontSheets, ...backSheets]) {
    await copyFile(path.join(outDir, file.filename), path.join(publishTtsDir, file.filename));
  }
}

function rawFileIndex(manifest) {
  const index = new Map();
  for (const [group, info] of Object.entries(manifest.groups || {})) {
    for (const slide of info.slides || []) {
      if (slide.raw_file) index.set(`${group}:${slide.label}`, slide.raw_file);
    }
  }
  return index;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const headers = splitCsvLine(lines.shift());
  return lines.map((line) => Object.fromEntries(splitCsvLine(line).map((value, index) => [headers[index], value])));
}

function splitCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function renderHtml(codename, cards) {
  const items = cards.map((card) => `<article class="card" title="${esc(`${card.card_type} ${card.label}`)}">${card.svg}</article>`);
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>${esc(codename)} pnp</title>
  <style>
    @page { size: A4 portrait; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; background: white; }
    .sheet {
      width: 210mm;
      height: 297mm;
      padding: 16.5mm 10.5mm;
      display: grid;
      grid-template-columns: repeat(3, 63mm);
      grid-template-rows: repeat(3, 88mm);
      page-break-after: always;
    }
    .sheet:last-child { page-break-after: auto; }
    .card {
      width: 63mm;
      height: 88mm;
      overflow: hidden;
      outline: .15mm solid rgb(0 0 0 / .32);
      background: white;
    }
    .card svg { display: block; width: 63mm; height: 88mm; }
  </style>
</head>
<body>
${chunk(items, 9).map((sheet) => `<section class="sheet">${sheet.join("")}</section>`).join("\n")}
</body>
</html>
`;
}

async function renderSheets(items, prefix) {
  const pxPerMm = 4096 / (cardWidthMm * ttsCols);
  const cardW = Math.round(cardWidthMm * pxPerMm);
  const cardH = Math.round(cardHeightMm * pxPerMm);
  const perSheet = ttsCols * ttsRows;
  const files = [];

  for (let start = 0; start < items.length; start += perSheet) {
    const sheet = items.slice(start, start + perSheet);
    const canvas = createCanvas(cardW * ttsCols, cardH * ttsRows);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let index = 0; index < sheet.length; index += 1) {
      const image = await loadImage(Buffer.isBuffer(sheet[index]) ? sheet[index] : Buffer.from(sheet[index]));
      drawFit(ctx, image, (index % ttsCols) * cardW, Math.floor(index / ttsCols) * cardH, cardW, cardH);
    }
    const filename = `${prefix}_${files.length + 1}.png`;
    const data = canvas.toBuffer("image/png");
    await writeFile(path.join(outDir, filename), data);
    files.push({ filename, data });
  }
  return files;
}

async function renderCardInfo(cards, backPng) {
  const pairs = rows;
  const cols = Math.min(3, pairs.length);
  const thumbW = 96;
  const thumbH = Math.round(thumbW * (cardHeightMm / cardWidthMm));
  const pairW = thumbW * 2 + 64;
  const pairH = thumbH + 70;
  const pad = 20;
  const gap = 16;
  const headerH = 48;
  const canvas = createCanvas(pad * 2 + cols * pairW + (cols - 1) * gap, pad * 2 + headerH + Math.ceil(pairs.length / cols) * pairH + (Math.ceil(pairs.length / cols) - 1) * gap);
  const ctx = canvas.getContext("2d");
  const back = await loadImage(backPng);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#111827";
  ctx.font = "24px Arial";
  ctx.fillText(`${codename} card info`, pad, pad + 28);

  for (let index = 0; index < pairs.length; index += 1) {
    const row = pairs[index];
    const card = cards.find((item) => item.card_id === row.card_id);
    const image = await loadImage(Buffer.from(card.svg));
    const x = pad + (index % cols) * (pairW + gap);
    const y = pad + headerH + Math.floor(index / cols) * (pairH + gap);
    ctx.fillStyle = "#111827";
    ctx.font = "16px Arial";
    ctx.fillText(`${row.label} x${row.quantity}`, x, y + 20);
    drawFit(ctx, image, x + 10, y + 42, thumbW, thumbH);
    drawFit(ctx, back, x + 10 + thumbW + 44, y + 42, thumbW, thumbH);
  }
  return canvas.toBuffer("image/png");
}

async function renderTeaser(cards) {
  const uniqueCards = diverseCards(cards);
  const canvas = createCanvas(1600, 1200);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2 + 50);
  ctx.rotate(-Math.PI / 6);

  const cardW = 245;
  const cardH = Math.round(cardW * (cardHeightMm / cardWidthMm));
  const gap = 16;
  const stepX = cardW + gap;
  const stepY = cardH + gap;
  const cols = 7;
  const rowsCount = 5;
  const totalW = cols * cardW + (cols - 1) * gap;
  const totalH = rowsCount * cardH + (rowsCount - 1) * gap;
  const images = await Promise.all(uniqueCards.map((card) => loadImage(Buffer.from(card.svg))));

  for (let row = 0; row < rowsCount; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const image = images[(row * cols + col) % images.length];
      const x = col * stepX - totalW / 2 + (row % 2 ? stepX / 2 : 0);
      const y = row * stepY - totalH / 2;
    ctx.save();
    ctx.shadowColor = "rgba(17, 24, 39, .24)";
    ctx.shadowBlur = 26;
    ctx.shadowOffsetX = 18;
    ctx.shadowOffsetY = 18;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, cardW, cardH);
    ctx.restore();
    drawFit(ctx, image, x, y, cardW, cardH);
    }
  }

  return canvas.toBuffer("image/png");
}

function diverseCards(cards) {
  const groups = new Map();
  for (const card of new Map(cards.map((item) => [`${item.template_id}:${item.label}`, item])).values()) {
    const key = card.card_type || card.template_id || "card";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }
  const values = [...groups.values()];
  const selected = [];
  for (let index = 0; selected.length < 12 && values.some((group) => index < group.length); index += 1) {
    for (const group of values) {
      if (group[index]) selected.push(group[index]);
    }
  }
  return selected;
}

function drawFit(ctx, image, x, y, width, height) {
  const scale = Math.min(width / image.width, height / image.height);
  const drawW = Math.round(image.width * scale);
  const drawH = Math.round(image.height * scale);
  ctx.drawImage(image, x + Math.floor((width - drawW) / 2), y + Math.floor((height - drawH) / 2), drawW, drawH);
}

function titleCase(value) {
  return value.replace(/(^|[-_])([a-z0-9])/gi, (_, prefix, char) => prefix + char.toUpperCase());
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function vivliostyleCliPath() {
  return path.join("node_modules", "@vivliostyle", "cli", "dist", "cli.js");
}
