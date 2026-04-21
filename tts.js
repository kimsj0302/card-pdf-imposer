pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const MM_TO_PT = 72.0 / 25.4;
const TTS_SHEET_WIDTH_PX = 4096;
const DEFAULT_BACK_IMAGE_URL = "back_default.png";

const $ = (selector) => document.querySelector(selector);

let sourcePdfDoc = null;
let pageInfos = [];
let frontMappings = [];
let latestResults = [];
let defaultBackImagePromise = null;

function ptToMm(pt) {
  return pt / MM_TO_PT;
}

function mmToPx(mm, pxPerMm) {
  return Math.round(mm * pxPerMm);
}

function log(message) {
  const area = $("#tts-log-area");
  area.textContent += message + "\n";
  area.scrollTop = area.scrollHeight;
}

function clearLog() {
  $("#tts-log-area").textContent = "";
}

function parseOptionalNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadDefaultBackImage() {
  if (defaultBackImagePromise) {
    return defaultBackImagePromise;
  }

  defaultBackImagePromise = new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load ${DEFAULT_BACK_IMAGE_URL}`));
    image.src = DEFAULT_BACK_IMAGE_URL;
  });

  return defaultBackImagePromise;
}

function drawFallbackBackCanvas(cardWidthPx, cardHeightPx) {
  const canvas = document.createElement("canvas");
  canvas.width = cardWidthPx;
  canvas.height = cardHeightPx;
  const ctx = canvas.getContext("2d");

  const gradient = ctx.createLinearGradient(0, 0, cardWidthPx, cardHeightPx);
  gradient.addColorStop(0, "#1d4ed8");
  gradient.addColorStop(1, "#0f172a");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, cardWidthPx, cardHeightPx);

  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = Math.max(4, Math.round(cardWidthPx * 0.03));
  ctx.strokeRect(12, 12, cardWidthPx - 24, cardHeightPx - 24);

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${Math.max(28, Math.round(cardWidthPx * 0.14))}px Arial`;
  ctx.fillText("BACK", cardWidthPx / 2, cardHeightPx / 2);

  return canvas;
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

async function renderThumbnail(page, targetHeight = 88) {
  const viewport = page.getViewport({ scale: 1 });
  const scale = targetHeight / viewport.height;
  return renderPdfPageToCanvas(page, scale);
}

function getPagesByRole(role) {
  return pageInfos.filter((info) => info.role === role);
}

function recalculateFrontMappings() {
  const previousMap = new Map(frontMappings.map((mapping) => [mapping.sourcePageNumber, mapping.backRef]));
  const backPages = getPagesByRole("back");
  const validBackRefs = new Set(["default", ...backPages.map((info) => `back:${info.pageNumber}`)]);

  frontMappings = getPagesByRole("front").map((info, index) => {
    const previousBackRef = previousMap.get(info.pageNumber);
    const backRef = validBackRefs.has(previousBackRef) ? previousBackRef : "default";
    return {
      frontIndex: index + 1,
      sourcePageNumber: info.pageNumber,
      backRef,
    };
  });
}

async function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  $("#tts-file-name").textContent = file.name;
  clearLog();
  $("#tts-results").classList.add("hidden");

  try {
    const sourcePdfBytes = await file.arrayBuffer();
    sourcePdfDoc = await pdfjsLib.getDocument({ data: sourcePdfBytes.slice(0) }).promise;

    pageInfos = [];
    for (let pageNumber = 1; pageNumber <= sourcePdfDoc.numPages; pageNumber += 1) {
      const page = await sourcePdfDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      pageInfos.push({
        pageNumber,
        widthPt: viewport.width,
        heightPt: viewport.height,
        role: "front",
      });
    }

    await renderRoleList();
    recalculateFrontMappings();
    renderFrontMappingList();

    $("#page-role-section").hidden = false;
    $("#front-mapping-section").hidden = false;
    $("#generate-tts-btn").disabled = false;

    log(`Loaded: ${file.name}`);
    log(`Pages: ${pageInfos.length}`);
    pageInfos.forEach((info) => {
      log(
        `  Page ${info.pageNumber}: ${ptToMm(info.widthPt).toFixed(1)} x ${ptToMm(info.heightPt).toFixed(1)} mm`
      );
    });
  } catch (error) {
    sourcePdfDoc = null;
    pageInfos = [];
    frontMappings = [];
    $("#generate-tts-btn").disabled = true;
    $("#page-role-section").hidden = true;
    $("#front-mapping-section").hidden = true;
    log(`Error loading PDF: ${error.message}`);
  }
}

async function renderRoleList() {
  const roleList = $("#role-list");
  roleList.innerHTML = "";

  for (const info of pageInfos) {
    const page = await sourcePdfDoc.getPage(info.pageNumber);
    const thumbCanvas = await renderThumbnail(page);
    thumbCanvas.className = "copy-thumb";

    const row = document.createElement("div");
    row.className = "role-row";

    const meta = document.createElement("div");
    meta.className = "role-meta";

    const title = document.createElement("strong");
    title.textContent = `Page ${info.pageNumber}`;

    const size = document.createElement("span");
    size.textContent = `${ptToMm(info.widthPt).toFixed(1)} x ${ptToMm(info.heightPt).toFixed(1)} mm`;

    const select = document.createElement("select");
    select.className = "role-select";
    select.innerHTML = `
      <option value="front"${info.role === "front" ? " selected" : ""}>Front</option>
      <option value="back"${info.role === "back" ? " selected" : ""}>Back Asset</option>
      <option value="exclude"${info.role === "exclude" ? " selected" : ""}>Exclude</option>
    `;
    select.addEventListener("change", () => {
      info.role = select.value;
      recalculateFrontMappings();
      renderFrontMappingList();
    });

    meta.append(title, size);
    row.append(thumbCanvas, meta, select);
    roleList.appendChild(row);
  }
}

function renderFrontMappingList() {
  const list = $("#mapping-list");
  list.innerHTML = "";

  const backPages = getPagesByRole("back");

  if (frontMappings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "helper-text";
    empty.textContent = "Front로 지정된 페이지가 없습니다.";
    list.appendChild(empty);
    return;
  }

  frontMappings.forEach((mapping) => {
    const sourceInfo = pageInfos.find((info) => info.pageNumber === mapping.sourcePageNumber);
    const row = document.createElement("div");
    row.className = "mapping-row";

    const index = document.createElement("div");
    index.className = "mapping-index";
    index.textContent = `Front #${mapping.frontIndex}`;

    const meta = document.createElement("div");
    meta.className = "mapping-meta";

    const title = document.createElement("strong");
    title.textContent = `Page ${mapping.sourcePageNumber}`;

    const sub = document.createElement("span");
    sub.textContent =
      `${ptToMm(sourceInfo.widthPt).toFixed(1)} x ${ptToMm(sourceInfo.heightPt).toFixed(1)} mm`;

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
    });

    meta.append(title, sub);
    row.append(index, meta, select);
    list.appendChild(row);
  });
}

function getCardSizeMm() {
  const manualWidth = parseOptionalNumber($("#tts-card-width").value);
  const manualHeight = parseOptionalNumber($("#tts-card-height").value);

  if ((manualWidth == null) !== (manualHeight == null)) {
    throw new Error("카드 너비와 높이를 모두 입력하거나 비워두세요.");
  }

  if (manualWidth != null && manualHeight != null) {
    return { widthMm: manualWidth, heightMm: manualHeight, source: "manual" };
  }

  const firstActive = getPagesByRole("front")[0] || getPagesByRole("back")[0] || pageInfos[0];
  if (!firstActive) {
    throw new Error("활성화된 페이지가 없습니다.");
  }

  return {
    widthMm: ptToMm(firstActive.widthPt),
    heightMm: ptToMm(firstActive.heightPt),
    source: "pdf",
  };
}

async function renderAssetCanvas(asset, cardWidthPx, cardHeightPx) {
  if (asset.type === "default") {
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
    } catch (error) {
      log(`Warning: ${error.message}. Falling back to generated default back.`);
      return drawFallbackBackCanvas(cardWidthPx, cardHeightPx);
    }
  }

  const info = asset.info;
  const page = await sourcePdfDoc.getPage(info.pageNumber);
  const tileScale = Math.min(cardWidthPx / info.widthPt, cardHeightPx / info.heightPt);
  return renderPdfPageToCanvas(page, tileScale);
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
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < chunk.length; i += 1) {
      const assetCanvas = await renderAssetCanvas(chunk[i], cardWidthPx, cardHeightPx);
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * cardWidthPx;
      const y = row * cardHeightPx;
      const offsetX = x + Math.floor((cardWidthPx - assetCanvas.width) / 2);
      const offsetY = y + Math.floor((cardHeightPx - assetCanvas.height) / 2);
      ctx.drawImage(assetCanvas, offsetX, offsetY);
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const url = URL.createObjectURL(blob);
    const filename = `${prefix}_${sheetIndex}.png`;
    const result = { filename, url, kind: prefix, count: chunk.length };
    results.push(result);
    outputList.push(result);
  }

  return { results, perSheet };
}

function buildFrontAssets() {
  return frontMappings.map((mapping) => {
    const info = pageInfos.find((item) => item.pageNumber === mapping.sourcePageNumber);
    return { type: "pdf", info };
  });
}

function buildBackAssets() {
  return frontMappings.map((mapping) => {
    if (mapping.backRef === "default") {
      return { type: "default" };
    }
    const pageNumber = Number.parseInt(mapping.backRef.replace("back:", ""), 10);
    const info = pageInfos.find((item) => item.pageNumber === pageNumber);
    return { type: "pdf", info };
  });
}

function renderGuide(values) {
  const guide = $("#tts-guide-values");
  guide.innerHTML = "";

  const entries = [
    ["Width", String(values.width)],
    ["Height", String(values.height)],
    ["Number", String(values.number)],
    ["Unique Backs", "true"],
    ["Back is Hidden", "false"],
    ["Default Back Used", values.defaultBackUsed ? "true" : "false"],
  ];

  for (const [key, value] of entries) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    guide.append(dt, dd);
  }
}

function renderResults(results) {
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

async function handleGenerate() {
  if (!sourcePdfDoc || pageInfos.length === 0) {
    log("Error: No PDF loaded.");
    return;
  }

  clearLog();
  const button = $("#generate-tts-btn");
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>생성 중 Generating...';
  $("#tts-results").classList.add("hidden");

  try {
    recalculateFrontMappings();

    const cols = parsePositiveInt($("#grid-cols").value, 10);
    const rows = parsePositiveInt($("#grid-rows").value, 7);
    const { widthMm: cardWidthMm, heightMm: cardHeightMm, source } = getCardSizeMm();
    const frontPages = getPagesByRole("front");
    const backPages = getPagesByRole("back");

    if (frontPages.length === 0) {
      throw new Error("Front로 지정된 페이지가 없습니다.");
    }

    latestResults.forEach((item) => URL.revokeObjectURL(item.url));
    latestResults = [];

    log(`Grid: ${cols} x ${rows}`);
    log(`Card size (${source}): ${cardWidthMm.toFixed(1)} x ${cardHeightMm.toFixed(1)} mm`);
    log(`Front pages: ${frontPages.length}`);
    log(`Back asset pages: ${backPages.length}`);

    const results = [];
    const frontAssets = buildFrontAssets();
    const backAssets = buildBackAssets();

    const frontSheets = await renderSheetImages(frontAssets, {
      cols,
      rows,
      cardWidthMm,
      cardHeightMm,
      prefix: "front_sheet",
      outputList: results,
    });

    const backSheets = await renderSheetImages(backAssets, {
      cols,
      rows,
      cardWidthMm,
      cardHeightMm,
      prefix: "back_sheet",
      outputList: results,
    });

    latestResults = results;

    renderGuide({
      width: cols,
      height: rows,
      number: frontPages.length,
      defaultBackUsed: frontMappings.some((mapping) => mapping.backRef === "default"),
    });
    renderResults(results);
    $("#tts-results").classList.remove("hidden");

    log(`Generated front sheets: ${frontSheets.results.length}`);
    log(`Generated back sheets: ${backSheets.results.length}`);
    log(`Unique Backs: true`);
  } catch (error) {
    log(`Error: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "TTS 시트 생성 Generate TTS Sheets";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("#tts-input-pdf").addEventListener("change", handleFileSelect);
  $("#generate-tts-btn").addEventListener("click", handleGenerate);
});
