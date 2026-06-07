pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const MM_TO_PT = 72.0 / 25.4;
const TTS_SHEET_WIDTH_PX = 4096;
const CARD_RENDER_SUPERSAMPLE = 2;
const CARD_INFO_THUMB_WIDTH_PX = 96;

const PAGE_SIZES = {
  A4: [210, 297],
  A3: [297, 420],
  B4: [250, 353],
  B5: [176, 250],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
};

const $ = (selector) => document.querySelector(selector);
const DEFAULT_BACK_IMAGE_URL = "back_default.png";

let loadedPdfBytes = null;
let sourcePdfDoc = null;
let sourcePdfjsDoc = null;
let pageInfos = [];
let frontMappings = [];
let generatedUrls = [];
let generatedFiles = [];
let previewPdfDoc = null;
let previewCurrentPage = 1;
let cardSizeTouched = false;
let draggedPageNumber = null;
let defaultBackImagePromise = null;
let defaultBackBytesPromise = null;

function mmToPt(mm) {
  return mm * MM_TO_PT;
}

function ptToMm(pt) {
  return pt / MM_TO_PT;
}

function mmToPx(mm, pxPerMm) {
  return Math.round(mm * pxPerMm);
}

function parseNum(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptNum(value) {
  if (value == null || value === "") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function log(message) {
  const area = $("#log-area");
  area.textContent += `${message}\n`;
  area.scrollTop = area.scrollHeight;
}

function clearLog() {
  $("#log-area").textContent = "";
}

function clearGeneratedUrls() {
  generatedUrls.forEach((url) => URL.revokeObjectURL(url));
  generatedUrls = [];
  generatedFiles = [];
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function getZipDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

async function createZipBlob(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;
  const { dosTime, dosDate } = getZipDateTime();

  for (const file of files) {
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const filenameBytes = encoder.encode(file.filename);
    const checksum = crc32(data);

    const localHeader = new Uint8Array(30 + filenameBytes.length);
    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0x0800);
    writeUint16(localHeader, 8, 0);
    writeUint16(localHeader, 10, dosTime);
    writeUint16(localHeader, 12, dosDate);
    writeUint32(localHeader, 14, checksum);
    writeUint32(localHeader, 18, data.length);
    writeUint32(localHeader, 22, data.length);
    writeUint16(localHeader, 26, filenameBytes.length);
    writeUint16(localHeader, 28, 0);
    localHeader.set(filenameBytes, 30);

    chunks.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + filenameBytes.length);
    writeUint32(centralHeader, 0, 0x02014b50);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0x0800);
    writeUint16(centralHeader, 10, 0);
    writeUint16(centralHeader, 12, dosTime);
    writeUint16(centralHeader, 14, dosDate);
    writeUint32(centralHeader, 16, checksum);
    writeUint32(centralHeader, 20, data.length);
    writeUint32(centralHeader, 24, data.length);
    writeUint16(centralHeader, 28, filenameBytes.length);
    writeUint16(centralHeader, 30, 0);
    writeUint16(centralHeader, 32, 0);
    writeUint16(centralHeader, 34, 0);
    writeUint16(centralHeader, 36, 0);
    writeUint32(centralHeader, 38, 0);
    writeUint32(centralHeader, 42, offset);
    centralHeader.set(filenameBytes, 46);
    centralDirectory.push(centralHeader);

    offset += localHeader.length + data.length;
  }

  const centralDirectoryOffset = offset;
  let centralDirectorySize = 0;
  centralDirectory.forEach((header) => {
    centralDirectorySize += header.length;
    chunks.push(header);
  });

  const endRecord = new Uint8Array(22);
  writeUint32(endRecord, 0, 0x06054b50);
  writeUint16(endRecord, 8, files.length);
  writeUint16(endRecord, 10, files.length);
  writeUint32(endRecord, 12, centralDirectorySize);
  writeUint32(endRecord, 16, centralDirectoryOffset);
  writeUint16(endRecord, 20, 0);
  chunks.push(endRecord);

  return new Blob(chunks, { type: "application/zip" });
}

function isFileProtocol() {
  return window.location.protocol === "file:";
}

function showEnvironmentWarning() {
  if (!isFileProtocol()) return;
  const container = document.querySelector(".container");
  if (!container || document.querySelector(".env-warning")) return;

  const warning = document.createElement("div");
  warning.className = "env-warning";
  warning.textContent =
    "This app must be opened through a local web server. Opening index.html directly can taint canvases and block PNG export.";
  container.insertBefore(warning, container.querySelector("main"));
}

function loadDefaultBackImage() {
  if (defaultBackImagePromise) return defaultBackImagePromise;
  defaultBackImagePromise = new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load ${DEFAULT_BACK_IMAGE_URL}`));
    image.src = DEFAULT_BACK_IMAGE_URL;
  });
  return defaultBackImagePromise;
}

async function loadDefaultBackBytes() {
  if (!defaultBackBytesPromise) {
    defaultBackBytesPromise = fetch(DEFAULT_BACK_IMAGE_URL).then((response) => {
      if (!response.ok) throw new Error(`Failed to fetch ${DEFAULT_BACK_IMAGE_URL}`);
      return response.arrayBuffer();
    });
  }
  return defaultBackBytesPromise;
}

function getPagesByRole(role) {
  return pageInfos.filter((info) => info.role === role);
}

function getPageSizePt() {
  const selected = $("#page-size").value;
  if (selected === "Custom") {
    return [
      mmToPt(parseNum($("#custom-page-w").value, 210)),
      mmToPt(parseNum($("#custom-page-h").value, 297)),
    ];
  }
  const [wMm, hMm] = PAGE_SIZES[selected];
  return [mmToPt(wMm), mmToPt(hMm)];
}

function getCardSizeMm() {
  const manualWidth = parseOptNum($("#card-width").value);
  const manualHeight = parseOptNum($("#card-height").value);

  if ((manualWidth == null) !== (manualHeight == null)) {
    throw new Error("Provide both card width and height, or leave both empty.");
  }

  if (manualWidth != null && manualHeight != null) {
    return {
      widthMm: Math.min(manualWidth, manualHeight),
      heightMm: Math.max(manualWidth, manualHeight),
      source: cardSizeTouched ? "manual portrait-normalized" : "auto",
    };
  }

  const firstActive = getPagesByRole("front")[0] || getPagesByRole("back")[0] || pageInfos[0];
  if (!firstActive) throw new Error("No active pages are available.");
  return {
    ...inferStandardCardSize(firstActive),
    source: "auto",
  };
}

function inferStandardCardSize(pageInfo) {
  return { widthMm: 63, heightMm: 88 };
}

function updateAutoCardSize(force = false) {
  if (cardSizeTouched && !force) return;
  const firstActive = getPagesByRole("front")[0] || getPagesByRole("back")[0] || pageInfos[0];
  if (!firstActive) return;
  const { widthMm, heightMm } = inferStandardCardSize(firstActive);
  $("#card-width").value = String(widthMm);
  $("#card-height").value = String(heightMm);
  $("#card-size-hint").textContent =
    firstActive.widthPt > firstActive.heightPt
      ? "Landscape PDF page detected: pages will be rotated into 63 x 88 mm portrait cards."
      : "Portrait card workflow: using 63 x 88 mm.";
}

function bestLayoutForPage(cardW, cardH, pageW, pageH, marginX, marginY, minScale, orientation) {
  const availW = pageW - 2 * marginX;
  const availH = pageH - 2 * marginY;
  if (availW <= 0 || availH <= 0) return null;

  const maxCols = Math.max(1, Math.floor(availW / (cardW * minScale)));
  const maxRows = Math.max(1, Math.floor(availH / (cardH * minScale)));

  let best = null;
  for (let cols = 1; cols <= maxCols; cols += 1) {
    for (let rows = 1; rows <= maxRows; rows += 1) {
      const scale = Math.min(availW / (cardW * cols), availH / (cardH * rows), 1.0);
      if (scale < minScale) continue;
      const perSheet = cols * rows;
      if (!best || perSheet > best.perSheet || (perSheet === best.perSheet && scale > best.scale)) {
        best = {
          orientation,
          cols,
          rows,
          scale,
          perSheet,
          pageW,
          pageH,
          slotW: cardW * scale,
          slotH: cardH * scale,
        };
      }
    }
  }
  return best;
}

function chooseLayout(cardW, cardH, marginX, marginY, minScale, orientationMode, sheetW, sheetH) {
  const orientations = [];
  if (orientationMode === "auto" || orientationMode === "portrait") {
    orientations.push({ name: "portrait", w: sheetW, h: sheetH });
  }
  if (orientationMode === "auto" || orientationMode === "landscape") {
    orientations.push({ name: "landscape", w: sheetH, h: sheetW });
  }

  const candidates = orientations
    .map(({ name, w, h }) => bestLayoutForPage(cardW, cardH, w, h, marginX, marginY, minScale, name))
    .filter(Boolean);

  if (candidates.length === 0) {
    throw new Error("No available space. Relax margins or min-scale.");
  }

  candidates.sort((a, b) => a.perSheet - b.perSheet || a.scale - b.scale);
  return candidates[candidates.length - 1];
}

function buildFooterLines(font, text, size, maxW) {
  const lines = [];
  const paragraphs = text.replace(/\r\n/g, "\n").split("\n");
  paragraphs.forEach((paragraph) => {
    const words = paragraph.trim() ? paragraph.split(/\s+/) : [];
    if (words.length === 0) {
      lines.push("");
      return;
    }

    let current = "";
    words.forEach((word) => {
      const next = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= maxW) {
        current = next;
      } else {
        if (current) lines.push(current);
        current = word;
      }
    });
    if (current) lines.push(current);
  });
  return lines.length ? lines : [text];
}

function isLandscapePageIndex(pageIndex) {
  const info = pageInfos[pageIndex];
  return !!info && info.widthPt > info.heightPt;
}

function formatPageSize(info) {
  const raw = `${ptToMm(info.widthPt).toFixed(1)} x ${ptToMm(info.heightPt).toFixed(1)} mm`;
  return info.widthPt > info.heightPt ? `${raw} -> rotated portrait` : raw;
}

async function reflowItems(items, options, logFn) {
  const { PDFDocument, rgb, StandardFonts } = PDFLib;
  const { degrees } = PDFLib;
  if (items.length === 0) throw new Error("No cards to place.");

  const srcDoc = await PDFDocument.load(loadedPdfBytes);
  const outDoc = await PDFDocument.create();
  const embeddedPages = await outDoc.embedPdf(
    srcDoc,
    Array.from({ length: srcDoc.getPageCount() }, (_, index) => index)
  );
  let defaultBackImage = null;
  if (items.some((item) => item.type === "defaultBack")) {
    try {
      defaultBackImage = await outDoc.embedPng(await loadDefaultBackBytes());
    } catch (error) {
      logFn(`Warning: ${error.message}. Using generated default back.`);
    }
  }

  const cardW = mmToPt(options.cardWidthMm);
  const cardH = mmToPt(options.cardHeightMm);
  const marginX = mmToPt(options.marginMm);
  const marginY = mmToPt(options.marginMm);
  const cutW = mmToPt(options.cutlineWidthMm);
  const cutLen = mmToPt(5.0);
  const cutGap = mmToPt(1.5);
  const layout = chooseLayout(
    cardW,
    cardH,
    marginX,
    marginY,
    options.minScale,
    options.orientation,
    options.sheetW,
    options.sheetH
  );

  logFn(
    `${options.label}: ${layout.cols} x ${layout.rows}, ${layout.perSheet} cards/sheet, ` +
      `${ptToMm(layout.pageW).toFixed(1)} x ${ptToMm(layout.pageH).toFixed(1)} mm ${layout.orientation}`
  );

  const footerRaw = options.footerText || "";
  const footerSize = Math.max(4, Math.min(24, parseNum(options.footerFontSizePt, 7)));
  const maxFooterW = Math.max(24, layout.pageW - 2 * marginX - 8);
  const footerFont = footerRaw ? await outDoc.embedFont(StandardFonts.Helvetica) : null;
  const footerLines = footerFont ? buildFooterLines(footerFont, footerRaw, footerSize, maxFooterW) : [];
  const lineColor = rgb(0, 0, 0);
  const flipY = (y) => layout.pageH - y;

  function drawCutLines(page) {
    const topPdf = flipY(marginY);
    const bottomPdf = flipY(marginY + layout.rows * layout.slotH);
    const left = marginX;
    const right = marginX + layout.cols * layout.slotW;
    const xs = Array.from({ length: layout.cols + 1 }, (_, c) => marginX + c * layout.slotW);
    const ys = Array.from({ length: layout.rows + 1 }, (_, r) => flipY(marginY + r * layout.slotH));

    if (options.cutlineStyle === "grid") {
      xs.forEach((x) => {
        page.drawLine({ start: { x, y: bottomPdf }, end: { x, y: topPdf }, thickness: cutW, color: lineColor });
      });
      ys.forEach((y) => {
        page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: cutW, color: lineColor });
      });
      return;
    }

    xs.forEach((x) => {
      page.drawLine({ start: { x, y: topPdf + cutGap }, end: { x, y: topPdf + cutGap + cutLen }, thickness: cutW, color: lineColor });
      page.drawLine({ start: { x, y: bottomPdf - cutGap }, end: { x, y: bottomPdf - cutGap - cutLen }, thickness: cutW, color: lineColor });
    });
    ys.forEach((y) => {
      page.drawLine({ start: { x: left - cutGap - cutLen, y }, end: { x: left - cutGap, y }, thickness: cutW, color: lineColor });
      page.drawLine({ start: { x: right + cutGap, y }, end: { x: right + cutGap + cutLen, y }, thickness: cutW, color: lineColor });
    });
  }

  function drawFooter(page) {
    if (!footerFont) return;
    const lh = footerSize * 1.15;
    let baseline = 8 + footerSize * 0.28 + (footerLines.length - 1) * lh;
    footerLines.forEach((line) => {
      const text = line || " ";
      const tw = footerFont.widthOfTextAtSize(text, footerSize);
      page.drawText(text, {
        x: Math.max(marginX + 4, (layout.pageW - Math.min(tw, maxFooterW)) / 2),
        y: baseline,
        size: footerSize,
        font: footerFont,
        color: rgb(0.18, 0.18, 0.18),
      });
      baseline -= lh;
    });
  }

  function drawDefaultBack(page, x, y, width, height) {
    if (defaultBackImage) {
      page.drawRectangle({ x, y, width, height, color: rgb(1, 1, 1) });
      const imageScale = Math.min(width / defaultBackImage.width, height / defaultBackImage.height);
      const imageW = defaultBackImage.width * imageScale;
      const imageH = defaultBackImage.height * imageScale;
      page.drawImage(defaultBackImage, {
        x: x + (width - imageW) / 2,
        y: y + (height - imageH) / 2,
        width: imageW,
        height: imageH,
      });
      return;
    }

    page.drawRectangle({ x, y, width, height, color: rgb(0.93, 0.96, 1) });
    page.drawRectangle({
      x: x + width * 0.06,
      y: y + height * 0.06,
      width: width * 0.88,
      height: height * 0.88,
      borderColor: rgb(0.15, 0.39, 0.92),
      borderWidth: Math.max(1, width * 0.015),
    });
    page.drawText("BACK", {
      x: x + width * 0.28,
      y: y + height * 0.48,
      size: Math.max(10, width * 0.12),
      color: rgb(0.1, 0.25, 0.55),
    });
  }

  let currentPage = null;
  let slot = 0;

  items.forEach((item) => {
    if (currentPage === null || slot >= layout.perSheet) {
      if (currentPage) {
        drawCutLines(currentPage);
        drawFooter(currentPage);
      }
      currentPage = outDoc.addPage([layout.pageW, layout.pageH]);
      slot = 0;
    }

    const col = slot % layout.cols;
    const row = Math.floor(slot / layout.cols);
    const x = marginX + col * layout.slotW;
    const y = flipY(marginY + (row + 1) * layout.slotH);

    if (item.type === "pdf") {
      if (isLandscapePageIndex(item.pageIndex)) {
        currentPage.drawPage(embeddedPages[item.pageIndex], {
          x: x + layout.slotW,
          y,
          width: layout.slotH,
          height: layout.slotW,
          rotate: degrees(90),
        });
      } else {
        currentPage.drawPage(embeddedPages[item.pageIndex], { x, y, width: layout.slotW, height: layout.slotH });
      }
    } else {
      drawDefaultBack(currentPage, x, y, layout.slotW, layout.slotH);
    }
    slot += 1;
  });

  if (currentPage) {
    drawCutLines(currentPage);
    drawFooter(currentPage);
  }

  return outDoc.save();
}

async function renderPdfPageToCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

function rotateCanvasToPortrait(sourceCanvas) {
  if (sourceCanvas.height >= sourceCanvas.width) return sourceCanvas;
  const canvas = document.createElement("canvas");
  canvas.width = sourceCanvas.height;
  canvas.height = sourceCanvas.width;
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(sourceCanvas, 0, 0);
  return canvas;
}

async function renderThumbnail(pageNumber, targetHeight = 88) {
  const page = await sourcePdfjsDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const rotatedHeight = Math.max(viewport.width, viewport.height);
  const canvas = await renderPdfPageToCanvas(page, targetHeight / rotatedHeight);
  return rotateCanvasToPortrait(canvas);
}

async function fillMappingThumb(container, asset) {
  const label = container.querySelector("span")?.textContent || "";
  container.innerHTML = "";
  let canvas;
  if (asset.type === "defaultBack") {
    canvas = await drawDefaultBackCanvas(64, 90);
  } else {
    canvas = await renderThumbnail(asset.pageIndex + 1, 96);
  }
  canvas.className = "mapping-thumb-canvas";
  container.appendChild(canvas);
  if (label) {
    const caption = document.createElement("span");
    caption.textContent = label;
    container.appendChild(caption);
  }
}

function drawFallbackBackCanvas(cardWidthPx, cardHeightPx) {
  const canvas = document.createElement("canvas");
  canvas.width = cardWidthPx;
  canvas.height = cardHeightPx;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, cardWidthPx, cardHeightPx);
  gradient.addColorStop(0, "#2563eb");
  gradient.addColorStop(1, "#0f172a");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, cardWidthPx, cardHeightPx);
  ctx.strokeStyle = "rgba(255,255,255,0.65)";
  ctx.lineWidth = Math.max(4, Math.round(cardWidthPx * 0.03));
  ctx.strokeRect(12, 12, cardWidthPx - 24, cardHeightPx - 24);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${Math.max(28, Math.round(cardWidthPx * 0.14))}px Arial`;
  ctx.fillText("BACK", cardWidthPx / 2, cardHeightPx / 2);
  return canvas;
}

async function drawDefaultBackCanvas(cardWidthPx, cardHeightPx) {
  try {
    const image = await loadDefaultBackImage();
    const canvas = document.createElement("canvas");
    canvas.width = cardWidthPx;
    canvas.height = cardHeightPx;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cardWidthPx, cardHeightPx);

    const scale = Math.min(cardWidthPx / image.naturalWidth, cardHeightPx / image.naturalHeight);
    const drawWidth = Math.round(image.naturalWidth * scale);
    const drawHeight = Math.round(image.naturalHeight * scale);
    const offsetX = Math.floor((cardWidthPx - drawWidth) / 2);
    const offsetY = Math.floor((cardHeightPx - drawHeight) / 2);
    ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
    return canvas;
  } catch {
    return drawFallbackBackCanvas(cardWidthPx, cardHeightPx);
  }
}

async function renderAssetCanvas(asset, cardWidthPx, cardHeightPx) {
  const renderWidthPx = Math.max(1, Math.round(cardWidthPx * CARD_RENDER_SUPERSAMPLE));
  const renderHeightPx = Math.max(1, Math.round(cardHeightPx * CARD_RENDER_SUPERSAMPLE));

  if (asset.type === "defaultBack") {
    return drawDefaultBackCanvas(renderWidthPx, renderHeightPx);
  }

  const page = await sourcePdfjsDoc.getPage(asset.pageIndex + 1);
  const info = pageInfos[asset.pageIndex];
  const portraitWidthPt = Math.min(info.widthPt, info.heightPt);
  const portraitHeightPt = Math.max(info.widthPt, info.heightPt);
  const scale = Math.min(renderWidthPx / portraitWidthPt, renderHeightPx / portraitHeightPt);
  const canvas = await renderPdfPageToCanvas(page, scale);
  return rotateCanvasToPortrait(canvas);
}

async function renderSheetImages(assets, options) {
  const { cols, rows, cardWidthMm, cardHeightMm, prefix, outputList } = options;
  const perSheet = cols * rows;
  const pxPerMm = TTS_SHEET_WIDTH_PX / (cardWidthMm * cols);
  const cardWidthPx = Math.max(1, mmToPx(cardWidthMm, pxPerMm));
  const cardHeightPx = Math.max(1, mmToPx(cardHeightMm, pxPerMm));
  const sheetWidthPx = cardWidthPx * cols;
  const sheetHeightPx = cardHeightPx * rows;
  const results = [];

  for (let start = 0, sheetIndex = 1; start < assets.length; start += perSheet, sheetIndex += 1) {
    const chunk = assets.slice(start, start + perSheet);
    const canvas = document.createElement("canvas");
    canvas.width = sheetWidthPx;
    canvas.height = sheetHeightPx;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < chunk.length; i += 1) {
      const assetCanvas = await renderAssetCanvas(chunk[i], cardWidthPx, cardHeightPx);
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * cardWidthPx;
      const y = row * cardHeightPx;
      const fitScale = Math.min(cardWidthPx / assetCanvas.width, cardHeightPx / assetCanvas.height);
      const drawWidth = Math.round(assetCanvas.width * fitScale);
      const drawHeight = Math.round(assetCanvas.height * fitScale);
      const offsetX = x + Math.floor((cardWidthPx - drawWidth) / 2);
      const offsetY = y + Math.floor((cardHeightPx - drawHeight) / 2);
      ctx.drawImage(assetCanvas, offsetX, offsetY, drawWidth, drawHeight);
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error(`Failed to create ${prefix}_${sheetIndex}.png.`);
    const url = URL.createObjectURL(blob);
    generatedUrls.push(url);
    const result = { filename: `${prefix}_${sheetIndex}.png`, blob, url, count: chunk.length };
    results.push(result);
    outputList.push(result);
  }

  return results;
}

function recalculateFrontMappings() {
  const previousMap = new Map(frontMappings.map((mapping) => [mapping.sourcePageNumber, mapping]));
  const backPages = getPagesByRole("back");
  const validBackRefs = new Set(["default", ...backPages.map((info) => `back:${info.pageNumber}`)]);

  frontMappings = getPagesByRole("front").map((info, index) => {
    const previous = previousMap.get(info.pageNumber);
    const backRef = previous && validBackRefs.has(previous.backRef) ? previous.backRef : "default";
    return {
      frontIndex: index + 1,
      sourcePageNumber: info.pageNumber,
      pageIndex: info.pageNumber - 1,
      backRef,
      copies: previous?.copies ?? 1,
    };
  });
}

function getBackRefLabel(backRef) {
  if (backRef === "default") return "Default Back";
  const pageNumber = Number.parseInt(backRef.replace("back:", ""), 10);
  return `Back Asset Page ${pageNumber}`;
}

function refreshBackAssetControls() {
  const backPages = getPagesByRole("back");
  const singleBackSelect = $("#single-back-select");
  singleBackSelect.innerHTML = "";

  if (backPages.length === 0) {
    const option = document.createElement("option");
    option.value = "default";
    option.textContent = "No Back Asset pages selected";
    singleBackSelect.appendChild(option);
  } else {
    backPages.forEach((info) => {
      const option = document.createElement("option");
      option.value = `back:${info.pageNumber}`;
      option.textContent = `Back Asset Page ${info.pageNumber}`;
      singleBackSelect.appendChild(option);
    });
  }

  const mode = $("#back-assignment-mode").value;
  $("#single-back-row").hidden = mode !== "first-back";
}

function applyBackAssignmentMode() {
  const mode = $("#back-assignment-mode").value;
  const backPages = getPagesByRole("back");

  if (mode === "default") {
    frontMappings.forEach((mapping) => {
      mapping.backRef = "default";
    });
  } else if (mode === "first-back") {
    const backRef = $("#single-back-select").value || (backPages[0] ? `back:${backPages[0].pageNumber}` : "default");
    frontMappings.forEach((mapping) => {
      mapping.backRef = backRef;
    });
  } else if (mode === "next-page") {
    frontMappings.forEach((mapping) => {
      const nextPage = pageInfos[mapping.pageIndex + 1];
      mapping.backRef = nextPage?.role === "back" ? `back:${nextPage.pageNumber}` : "default";
    });
  } else if (mode === "back-order") {
    frontMappings.forEach((mapping, index) => {
      const backPage = backPages[index] || backPages[backPages.length - 1];
      mapping.backRef = backPage ? `back:${backPage.pageNumber}` : "default";
    });
  }

  renderFrontMappingList();
}

async function renderRoleList() {
  const board = $("#role-list");
  board.innerHTML = "";

  const roles = [
    { value: "front", title: "Front", note: "Cards to print and export" },
    { value: "back", title: "Back Asset", note: "Pages used as card backs" },
    { value: "exclude", title: "Exclude", note: "Ignored pages" },
  ];

  roles.forEach((role) => {
    const column = document.createElement("section");
    column.className = "role-column";
    column.dataset.role = role.value;
    column.addEventListener("dragover", (event) => {
      event.preventDefault();
      column.classList.add("drag-over");
    });
    column.addEventListener("dragleave", (event) => {
      if (!column.contains(event.relatedTarget)) column.classList.remove("drag-over");
    });
    column.addEventListener("drop", (event) => {
      event.preventDefault();
      column.classList.remove("drag-over");
      const pageNumber = Number.parseInt(event.dataTransfer.getData("text/plain") || draggedPageNumber, 10);
      movePageToRole(pageNumber, role.value);
    });

    const header = document.createElement("div");
    header.className = "role-column-header";

    const title = document.createElement("h3");
    title.textContent = role.title;

    const count = document.createElement("span");
    count.className = "role-count";
    count.textContent = String(getPagesByRole(role.value).length);

    const note = document.createElement("p");
    note.textContent = role.note;

    header.append(title, count, note);
    column.appendChild(header);

    const list = document.createElement("div");
    list.className = "role-column-list";
    list.dataset.role = role.value;

    column.appendChild(list);
    board.appendChild(column);
  });

  for (const info of pageInfos) {
    const thumbCanvas = await renderThumbnail(info.pageNumber);
    thumbCanvas.className = "copy-thumb";

    const row = document.createElement("div");
    row.className = "role-card";
    row.draggable = true;
    row.dataset.pageNumber = String(info.pageNumber);
    row.addEventListener("dragstart", (event) => {
      draggedPageNumber = info.pageNumber;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(info.pageNumber));
    });
    row.addEventListener("dragend", () => {
      draggedPageNumber = null;
      row.classList.remove("dragging");
      document.querySelectorAll(".role-column").forEach((column) => {
        column.classList.remove("drag-over");
      });
    });

    const meta = document.createElement("div");
    meta.className = "role-meta";

    const title = document.createElement("strong");
    title.textContent = `Page ${info.pageNumber}`;

    const size = document.createElement("span");
    size.textContent = formatPageSize(info);

    meta.append(title, size);
    row.append(thumbCanvas, meta);
    board.querySelector(`.role-column-list[data-role="${info.role}"]`).appendChild(row);
  }
}

function movePageToRole(pageNumber, role) {
  const info = pageInfos.find((item) => item.pageNumber === pageNumber);
  if (!info || info.role === role) return;
  info.role = role;
  recalculateFrontMappings();
  refreshBackAssetControls();
  updateAutoCardSize();
  renderRoleList().then(renderFrontMappingList);
}

function renderFrontMappingList() {
  const list = $("#mapping-list");
  list.innerHTML = "";
  refreshBackAssetControls();

  const backPages = getPagesByRole("back");
  if (frontMappings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "helper-text";
    empty.textContent = "No front pages selected.";
    list.appendChild(empty);
    return;
  }

  frontMappings.forEach((mapping) => {
    const sourceInfo = pageInfos[mapping.pageIndex];
    const row = document.createElement("div");
    row.className = "mapping-row";

    const index = document.createElement("div");
    index.className = "mapping-index";
    index.textContent = `Front #${mapping.frontIndex}`;

    const pair = document.createElement("div");
    pair.className = "mapping-pair";

    const frontPreview = document.createElement("div");
    frontPreview.className = "mapping-thumb";
    const frontCaption = document.createElement("span");
    frontCaption.textContent = `Page ${mapping.sourcePageNumber}`;
    frontPreview.appendChild(frontCaption);

    const arrow = document.createElement("div");
    arrow.className = "mapping-arrow";
    arrow.textContent = "->";

    const backPreview = document.createElement("div");
    backPreview.className = "mapping-thumb";
    const backCaption = document.createElement("span");
    backCaption.textContent = getBackRefLabel(mapping.backRef);
    backPreview.appendChild(backCaption);

    pair.append(frontPreview, arrow, backPreview);
    fillMappingThumb(frontPreview, { type: "pdf", pageIndex: mapping.pageIndex }).catch(() => {});
    fillMappingThumb(
      backPreview,
      mapping.backRef === "default"
        ? { type: "defaultBack" }
        : { type: "pdf", pageIndex: Number.parseInt(mapping.backRef.replace("back:", ""), 10) - 1 }
    ).catch(() => {});

    const meta = document.createElement("div");
    meta.className = "mapping-meta";
    const title = document.createElement("strong");
    title.textContent = `Page ${mapping.sourcePageNumber}`;
    const sub = document.createElement("span");
    sub.textContent = formatPageSize(sourceInfo);
    const backSummary = document.createElement("span");
    backSummary.textContent = `Back: ${getBackRefLabel(mapping.backRef)}`;
    meta.append(title, sub);
    meta.append(backSummary);

    const select = document.createElement("select");
    select.className = "mapping-select";
    const defaultOption = document.createElement("option");
    defaultOption.value = "default";
    defaultOption.textContent = "Default Back";
    select.appendChild(defaultOption);
    backPages.forEach((info) => {
      const option = document.createElement("option");
      option.value = `back:${info.pageNumber}`;
      option.textContent = `Back Asset Page ${info.pageNumber}`;
      select.appendChild(option);
    });
    select.value = mapping.backRef;
    select.addEventListener("change", () => {
      mapping.backRef = select.value;
      renderFrontMappingList();
    });

    const copies = document.createElement("input");
    copies.type = "number";
    copies.min = "0";
    copies.value = String(mapping.copies);
    copies.className = "copy-input";
    copies.addEventListener("change", () => {
      mapping.copies = Math.max(0, parsePositiveInt(copies.value, 0));
      copies.value = String(mapping.copies);
    });

    row.append(index, pair, meta, select, copies);
    list.appendChild(row);
  });
}

function applyAllCopies() {
  const copies = Math.max(0, parsePositiveInt($("#set-all-copies").value, 0));
  frontMappings.forEach((mapping) => {
    mapping.copies = copies;
  });
  renderFrontMappingList();
}

function setRolePreset(mode) {
  pageInfos.forEach((info) => {
    if (mode === "all-front") {
      info.role = "front";
    } else {
      info.role = info.pageNumber % 2 === 0 ? "back" : "front";
    }
  });
  recalculateFrontMappings();
  if (mode === "odd-even") {
    $("#back-assignment-mode").value = "next-page";
    applyBackAssignmentMode();
  }
  refreshBackAssetControls();
  updateAutoCardSize();
  renderRoleList().then(renderFrontMappingList);
}

function buildOutputItems(kind) {
  const items = [];
  frontMappings.forEach((mapping) => {
    const copies = Math.max(0, mapping.copies || 0);
    for (let i = 0; i < copies; i += 1) {
      if (kind === "front") {
        items.push({ type: "pdf", pageIndex: mapping.pageIndex });
      } else if (mapping.backRef === "default") {
        items.push({ type: "defaultBack" });
      } else {
        const pageNumber = Number.parseInt(mapping.backRef.replace("back:", ""), 10);
        items.push({ type: "pdf", pageIndex: pageNumber - 1 });
      }
    }
  });
  return items;
}

function buildPnpItems() {
  const items = [];
  frontMappings.forEach((mapping) => {
    const copies = Math.max(0, mapping.copies || 0);
    for (let i = 0; i < copies; i += 1) {
      items.push({ type: "pdf", pageIndex: mapping.pageIndex });
      if (mapping.backRef !== "default") {
        const pageNumber = Number.parseInt(mapping.backRef.replace("back:", ""), 10);
        items.push({ type: "pdf", pageIndex: pageNumber - 1 });
      }
    }
  });
  return items;
}

async function renderCardInfoImage(cardWidthMm, cardHeightMm) {
  const pairs = frontMappings.filter((mapping) => Math.max(0, mapping.copies || 0) > 0);
  if (pairs.length === 0) throw new Error("No card info to render.");

  const cols = Math.min(3, pairs.length);
  const thumbW = CARD_INFO_THUMB_WIDTH_PX;
  const thumbH = Math.round(thumbW * (cardHeightMm / cardWidthMm));
  const pairW = thumbW * 2 + 64;
  const pairH = thumbH + 70;
  const pad = 20;
  const gap = 16;
  const headerH = 48;
  const rows = Math.ceil(pairs.length / cols);
  const canvas = document.createElement("canvas");
  canvas.width = pad * 2 + cols * pairW + (cols - 1) * gap;
  canvas.height = pad * 2 + headerH + rows * pairH + (rows - 1) * gap;

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#111827";
  ctx.font = "700 18px Arial";
  ctx.fillText("Card Info", pad, pad + 18);
  ctx.font = "11px Arial";
  ctx.fillStyle = "#64748b";
  ctx.fillText("Front and back pairing reference for PnP output", pad, pad + 36);

  for (let index = 0; index < pairs.length; index += 1) {
    const mapping = pairs[index];
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = pad + col * (pairW + gap);
    const y = pad + headerH + row * (pairH + gap);

    ctx.fillStyle = "#f8fafc";
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, pairW, pairH);
    ctx.strokeRect(x, y, pairW, pairH);

    ctx.fillStyle = "#2563eb";
    ctx.font = "700 12px Arial";
    ctx.fillText(`Card #${mapping.frontIndex}`, x + 10, y + 18);
    ctx.fillStyle = "#475569";
    ctx.font = "10px Arial";
    ctx.fillText(`Copies: ${mapping.copies}`, x + 10, y + 34);

    const frontCanvas = await renderAssetCanvas({ type: "pdf", pageIndex: mapping.pageIndex }, thumbW, thumbH);
    const backAsset =
      mapping.backRef === "default"
        ? { type: "defaultBack" }
        : { type: "pdf", pageIndex: Number.parseInt(mapping.backRef.replace("back:", ""), 10) - 1 };
    const backCanvas = await renderAssetCanvas(backAsset, thumbW, thumbH);

    const frontX = x + 10;
    const backX = x + 10 + thumbW + 44;
    const thumbY = y + 42;
    drawCanvasFit(ctx, frontCanvas, frontX, thumbY, thumbW, thumbH);
    drawCanvasFit(ctx, backCanvas, backX, thumbY, thumbW, thumbH);

    ctx.fillStyle = "#111827";
    ctx.font = "700 10px Arial";
    ctx.fillText("Front", frontX, thumbY + thumbH + 14);
    ctx.fillText(mapping.backRef === "default" ? "Default Back" : "Back", backX, thumbY + thumbH + 14);
    ctx.fillStyle = "#64748b";
    ctx.font = "9px Arial";
    ctx.fillText(`Page ${mapping.sourcePageNumber}`, frontX, thumbY + thumbH + 27);
    ctx.fillText(getBackRefLabel(mapping.backRef), backX, thumbY + thumbH + 27);
    ctx.fillStyle = "#64748b";
    ctx.font = "700 14px Arial";
    ctx.fillText("->", x + 10 + thumbW + 14, thumbY + Math.round(thumbH / 2));
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Failed to create card info image.");
  return blob;
}

function drawCanvasFit(ctx, sourceCanvas, x, y, width, height) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = "#cbd5e1";
  ctx.strokeRect(x, y, width, height);
  const scale = Math.min(width / sourceCanvas.width, height / sourceCanvas.height);
  const drawW = Math.round(sourceCanvas.width * scale);
  const drawH = Math.round(sourceCanvas.height * scale);
  ctx.drawImage(
    sourceCanvas,
    x + Math.floor((width - drawW) / 2),
    y + Math.floor((height - drawH) / 2),
    drawW,
    drawH
  );
}

function renderGuide(values) {
  const guide = $("#tts-guide-values");
  guide.innerHTML = "";
  [
    ["Width", String(values.width)],
    ["Height", String(values.height)],
    ["Number", String(values.number)],
    ["Unique Backs", "true"],
    ["Back is Hidden", "false"],
    ["Default Back Used", values.defaultBackUsed ? "true" : "false"],
  ].forEach(([key, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    guide.append(dt, dd);
  });
}

function renderTtsResults(results) {
  const list = $("#tts-result-list");
  list.innerHTML = "";
  results.forEach((result) => {
    const card = document.createElement("article");
    card.className = "sheet-card";

    const title = document.createElement("h4");
    title.textContent = `${result.filename} (${result.count})`;

    const previewWrap = document.createElement("div");
    previewWrap.className = "sheet-preview-wrap";

    const image = document.createElement("img");
    image.src = result.url;
    image.alt = result.filename;

    const link = document.createElement("a");
    link.className = "btn-download";
    link.href = result.url;
    link.download = result.filename;
    link.textContent = `Download ${result.filename}`;

    previewWrap.appendChild(image);
    card.append(title, previewWrap, link);
    list.appendChild(card);
  });
}

async function showPreview(pdfBytes) {
  previewPdfDoc = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
  previewCurrentPage = 1;
  $("#preview-section").hidden = false;
  await renderPreviewPage(1);
}

async function renderPreviewPage(num) {
  if (!previewPdfDoc || num < 1 || num > previewPdfDoc.numPages) return;
  previewCurrentPage = num;
  const page = await previewPdfDoc.getPage(num);
  const canvas = $("#preview-canvas");
  const wrapper = canvas.parentElement;
  const containerWidth = wrapper.clientWidth || 660;
  const unscaledVp = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: containerWidth / unscaledVp.width });

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

  $("#page-indicator").textContent = `${num} / ${previewPdfDoc.numPages}`;
  $("#prev-page").disabled = num <= 1;
  $("#next-page").disabled = num >= previewPdfDoc.numPages;
}

async function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  clearLog();
  clearGeneratedUrls();
  $("#download-area").hidden = true;
  $("#tts-results").classList.add("hidden");
  $("#preview-section").hidden = true;
  $("#file-name").textContent = file.name;
  $("#output-prefix").value = file.name.replace(/\.pdf$/i, "") || "cards";
  cardSizeTouched = false;

  try {
    const buffer = await file.arrayBuffer();
    loadedPdfBytes = new Uint8Array(buffer);
    sourcePdfDoc = await PDFLib.PDFDocument.load(loadedPdfBytes);
    sourcePdfjsDoc = await pdfjsLib.getDocument({ data: loadedPdfBytes.slice(0) }).promise;

    pageInfos = sourcePdfDoc.getPages().map((page, index) => ({
      pageNumber: index + 1,
      widthPt: page.getWidth(),
      heightPt: page.getHeight(),
      role: "front",
    }));

    updateAutoCardSize(true);
    await renderRoleList();
    recalculateFrontMappings();
    refreshBackAssetControls();
    renderFrontMappingList();

    $("#page-role-section").hidden = false;
    $("#front-mapping-section").hidden = false;
    $("#export-settings").hidden = false;
    $("#generate-btn").disabled = false;

    log(`Loaded: ${file.name}`);
    log(`Pages: ${pageInfos.length}`);
  } catch (error) {
    loadedPdfBytes = null;
    sourcePdfDoc = null;
    sourcePdfjsDoc = null;
    pageInfos = [];
    frontMappings = [];
    $("#generate-btn").disabled = true;
    log(`Error loading PDF: ${error.message}`);
  }
}

async function handleGenerate() {
  if (isFileProtocol()) {
    log("Error: Open this app through a local web server, not by double-clicking index.html. Canvas PNG export is blocked under file://.");
    return;
  }

  if (!loadedPdfBytes || frontMappings.length === 0) {
    log("Error: load a PDF and select at least one front page.");
    return;
  }

  const button = $("#generate-btn");
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>Generating...';
  clearLog();
  clearGeneratedUrls();
  $("#download-area").hidden = true;
  $("#tts-results").classList.add("hidden");
  $("#preview-section").hidden = true;

  try {
    const { widthMm, heightMm, source } = getCardSizeMm();
    const [sheetW, sheetH] = getPageSizePt();
    const frontItems = buildOutputItems("front");
    const backItems = buildOutputItems("back");
    const pnpItems = buildPnpItems();
    const totalCards = frontItems.length;
    if (totalCards === 0) throw new Error("All copy counts are 0.");

    const commonPdfOptions = {
      cardWidthMm: widthMm,
      cardHeightMm: heightMm,
      marginMm: parseNum($("#margin").value, 5.0),
      minScale: parseNum($("#min-scale").value, 1.0),
      orientation: $("#orientation").value,
      sheetW,
      sheetH,
      cutlineStyle: $("#cutline-style").value,
      cutlineWidthMm: parseNum($("#cutline-width").value, 0.2),
      footerText: $("#footer-text").value.trim(),
      footerFontSizePt: parseNum($("#footer-font-size").value, 7),
    };

    log(`Card size (${source}): ${widthMm.toFixed(1)} x ${heightMm.toFixed(1)} mm`);
    log(`Cards: ${totalCards}`);

    const pnpPdfBytes = await reflowItems(pnpItems, { ...commonPdfOptions, label: "PnP" }, log);
    const cardInfoBlob = await renderCardInfoImage(widthMm, heightMm);

    const prefix = $("#output-prefix").value.trim() || "cards";
    generatedFiles = [
      { blob: new Blob([pnpPdfBytes], { type: "application/pdf" }), filename: `${prefix}_pnp.pdf` },
      { blob: cardInfoBlob, filename: `${prefix}_card_info.png` },
    ];
    [
      { id: "#pnp-pdf-link", file: generatedFiles[0] },
      { id: "#card-info-link", file: generatedFiles[1] },
    ].forEach(({ id, file }) => {
      const url = URL.createObjectURL(file.blob);
      generatedUrls.push(url);
      const link = $(id);
      link.href = url;
      link.download = file.filename;
      link.textContent = `Download ${file.filename}`;
    });

    const cols = parsePositiveInt($("#grid-cols").value, 10);
    const rows = parsePositiveInt($("#grid-rows").value, 7);
    const ttsResults = [];
    await renderSheetImages(frontItems, { cols, rows, cardWidthMm: widthMm, cardHeightMm: heightMm, prefix: "front_sheet", outputList: ttsResults });
    await renderSheetImages(backItems, { cols, rows, cardWidthMm: widthMm, cardHeightMm: heightMm, prefix: "back_sheet", outputList: ttsResults });
    generatedFiles.push(...ttsResults.map(({ filename, blob }) => ({ filename, blob })));

    const zipBlob = await createZipBlob(generatedFiles);
    const zipUrl = URL.createObjectURL(zipBlob);
    generatedUrls.push(zipUrl);
    const saveAllLink = $("#save-all-link");
    saveAllLink.href = zipUrl;
    saveAllLink.download = `${prefix}_all.zip`;
    saveAllLink.textContent = `Save all: ${prefix}_all.zip`;
    $("#download-area").hidden = false;

    renderGuide({
      width: cols,
      height: rows,
      number: totalCards,
      defaultBackUsed: frontMappings.some((mapping) => mapping.backRef === "default"),
    });
    renderTtsResults(ttsResults);
    $("#tts-results").classList.remove("hidden");

    await showPreview(pnpPdfBytes);
    log(`Generated TTS sheets: ${ttsResults.length}`);
    log("Done.");
  } catch (error) {
    log(`Error: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Generate PnP PDFs and TTS Sheets";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  showEnvironmentWarning();
  $("#input-pdf").addEventListener("change", handleFileSelect);
  $("#generate-btn").addEventListener("click", handleGenerate);
  $("#apply-all-copies").addEventListener("click", applyAllCopies);
  $("#mark-all-front").addEventListener("click", () => setRolePreset("all-front"));
  $("#mark-even-back").addEventListener("click", () => setRolePreset("odd-even"));
  $("#apply-back-assignment").addEventListener("click", applyBackAssignmentMode);
  $("#back-assignment-mode").addEventListener("change", refreshBackAssetControls);
  $("#card-width").addEventListener("input", () => {
    cardSizeTouched = true;
  });
  $("#card-height").addEventListener("input", () => {
    cardSizeTouched = true;
  });
  $("#page-size").addEventListener("change", () => {
    $("#custom-size-row").hidden = $("#page-size").value !== "Custom";
  });
  $("#prev-page").addEventListener("click", () => {
    if (previewCurrentPage > 1) renderPreviewPage(previewCurrentPage - 1);
  });
  $("#next-page").addEventListener("click", () => {
    if (previewPdfDoc && previewCurrentPage < previewPdfDoc.numPages) {
      renderPreviewPage(previewCurrentPage + 1);
    }
  });
});
