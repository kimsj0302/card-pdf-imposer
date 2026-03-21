/* Card PDF Imposer — browser edition */

// ─── pdf.js worker setup ─────────────────────────────────────────────────────

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ─── Constants & unit helpers ────────────────────────────────────────────────

const MM_TO_PT = 72.0 / 25.4;

const PAGE_SIZES = {
  A4:     [210, 297],
  A3:     [297, 420],
  B4:     [250, 353],
  B5:     [176, 250],
  Letter: [215.9, 279.4],
  Legal:  [215.9, 355.6],
};

function mmToPt(mm) {
  return mm * MM_TO_PT;
}

function ptToMm(pt) {
  return pt / MM_TO_PT;
}

// ─── Layout calculation (ported from layout_cards.py) ────────────────────────

function bestLayoutForPage(
  cardW, cardH, pageW, pageH, marginX, marginY, minScale, orientation
) {
  const availW = pageW - 2 * marginX;
  const availH = pageH - 2 * marginY;
  if (availW <= 0 || availH <= 0) return null;

  const maxCols = Math.max(1, Math.floor(availW / (cardW * minScale)));
  const maxRows = Math.max(1, Math.floor(availH / (cardH * minScale)));

  let best = null;
  for (let cols = 1; cols <= maxCols; cols++) {
    for (let rows = 1; rows <= maxRows; rows++) {
      const scale = Math.min(
        availW / (cardW * cols),
        availH / (cardH * rows),
        1.0
      );
      if (scale < minScale) continue;
      const perSheet = cols * rows;
      if (
        !best ||
        perSheet > best.perSheet ||
        (perSheet === best.perSheet && scale > best.scale)
      ) {
        best = {
          orientation, cols, rows, scale, perSheet,
          pageW, pageH,
          slotW: cardW * scale,
          slotH: cardH * scale,
        };
      }
    }
  }
  return best;
}

function normalizePageOrder(order, pageCount) {
  const seen = new Set();
  const out = [];
  if (Array.isArray(order)) {
    for (const i of order) {
      if (typeof i !== "number" || i < 0 || i >= pageCount || seen.has(i)) continue;
      seen.add(i);
      out.push(i);
    }
  }
  for (let i = 0; i < pageCount; i++) {
    if (!seen.has(i)) out.push(i);
  }
  return out;
}

function buildFooterLines(font, text, size, maxW) {
  const lines = [];
  const paras = text.replace(/\r\n/g, "\n").split("\n");
  for (const para of paras) {
    const words = para.trim() ? para.split(/\s+/) : [];
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let cur = "";
    for (const word of words) {
      const test = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) <= maxW) cur = test;
      else {
        if (cur) lines.push(cur);
        cur = word;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines.length ? lines : [text];
}

function chooseLayout(
  cardW, cardH, marginX, marginY, minScale, orientationMode, sheetW, sheetH
) {
  const orientations = [];
  if (orientationMode === "auto" || orientationMode === "portrait") {
    orientations.push({ name: "portrait", w: sheetW, h: sheetH });
  }
  if (orientationMode === "auto" || orientationMode === "landscape") {
    orientations.push({ name: "landscape", w: sheetH, h: sheetW });
  }

  const candidates = [];
  for (const { name, w, h } of orientations) {
    const layout = bestLayoutForPage(
      cardW, cardH, w, h, marginX, marginY, minScale, name
    );
    if (layout) candidates.push(layout);
  }

  if (candidates.length === 0) {
    throw new Error(
      "배치할 공간이 없습니다. 여백이나 최소 스케일을 조정해주세요.\n" +
      "No available space. Relax margins or min-scale."
    );
  }

  candidates.sort((a, b) => a.perSheet - b.perSheet || a.scale - b.scale);
  return candidates[candidates.length - 1];
}

// ─── PDF processing ──────────────────────────────────────────────────────────

async function reflowPdf(pdfBytes, options, logFn) {
  const { PDFDocument, rgb, StandardFonts } = PDFLib;

  const srcDoc = await PDFDocument.load(pdfBytes);
  const srcPages = srcDoc.getPages();
  if (srcPages.length === 0) throw new Error("Input PDF has no pages.");

  let cardW, cardH, sizeSource;
  if (options.cardWidthMm != null && options.cardHeightMm != null) {
    cardW = mmToPt(options.cardWidthMm);
    cardH = mmToPt(options.cardHeightMm);
    sizeSource = "manual / 수동";
  } else {
    cardW = srcPages[0].getWidth();
    cardH = srcPages[0].getHeight();
    sizeSource = "PDF auto / 자동";
  }

  const marginX = mmToPt(options.marginX);
  const marginY = mmToPt(options.marginY);
  const cutW = mmToPt(options.cutlineWidthMm);
  const cutLen = mmToPt(options.cutlineLengthMm);
  const cutGap = mmToPt(options.cutlineGapMm);

  const layout = chooseLayout(
    cardW, cardH, marginX, marginY, options.minScale, options.orientation,
    options.sheetW, options.sheetH
  );

  logFn(
    `Card (${sizeSource}): ${cardW.toFixed(1)}×${cardH.toFixed(1)} pt ` +
    `(${ptToMm(cardW).toFixed(1)}×${ptToMm(cardH).toFixed(1)} mm)`
  );
  logFn(
    `Sheet: ${ptToMm(layout.pageW).toFixed(1)}×${ptToMm(layout.pageH).toFixed(1)} mm ` +
    `(${layout.orientation})`
  );
  logFn(
    `Layout: ${layout.cols}×${layout.rows} ` +
    `/ per-sheet ${layout.perSheet} / scale ${layout.scale.toFixed(3)}`
  );

  const pageOrder = normalizePageOrder(options.pageOrder, srcPages.length);
  logFn(
    `Page order (1-based): ${pageOrder.map((i) => i + 1).join(", ")}`
  );

  const seq = [];
  for (const srcIdx of pageOrder) {
    const n = options.pageCopies?.[srcIdx] ?? 1;
    for (let c = 0; c < n; c++) seq.push(srcIdx);
  }
  logFn(`Total cards: ${seq.length} (${srcPages.length} unique pages)`);
  if (seq.length === 0) throw new Error("No cards to place (all copies are 0).");

  const outDoc = await PDFDocument.create();

  const allIndices = Array.from({ length: srcPages.length }, (_, i) => i);
  const embedded = await outDoc.embedPdf(srcDoc, allIndices);

  const footerRaw = (options.footerText ?? "").trim();
  const footerSize = Math.max(
    4,
    Math.min(24, parseNum(String(options.footerFontSizePt ?? 7), 7))
  );
  const maxFooterW = Math.max(24, layout.pageW - 2 * marginX - 8);
  let footerFont = null;
  let footerLines = [];
  if (footerRaw) {
    footerFont = await outDoc.embedFont(StandardFonts.Helvetica);
    footerLines = buildFooterLines(footerFont, footerRaw, footerSize, maxFooterW);
    const bottomGap =
      layout.pageH - marginY - layout.rows * layout.slotH;
    const lh = footerSize * 1.15;
    const blockH = footerLines.length * lh + 14;
    logFn(`Footer: ${footerLines.length} line(s) at sheet bottom (max width ~${maxFooterW.toFixed(0)} pt)`);
    if (blockH > bottomGap - 4) {
      logFn(
        "Footer: 하단 여백이 좁습니다. 상하 여백을 늘리거나 문구를 줄이세요.\n" +
        "Footer may overlap cards — increase vertical margin or shorten text."
      );
    }
  }

  const lineColor = rgb(0, 0, 0);
  const flipY = (y) => layout.pageH - y;

  function drawSheetFooter(page) {
    if (!footerRaw || !footerFont) return;
    const pageW = layout.pageW;
    const maxW = maxFooterW;
    const lh = footerSize * 1.15;
    const padBottom = 8;
    const textColor = rgb(0.18, 0.18, 0.18);
    let baseline =
      padBottom + footerSize * 0.28 + (footerLines.length - 1) * lh;
    for (const ln of footerLines) {
      const line = ln || " ";
      const tw = footerFont.widthOfTextAtSize(line, footerSize);
      let tx = (pageW - Math.min(tw, maxW)) / 2;
      const minX = marginX + 4;
      if (tx < minX) tx = minX;
      page.drawText(line, {
        x: tx,
        y: baseline,
        size: footerSize,
        font: footerFont,
        color: textColor,
      });
      baseline -= lh;
    }
  }

  function drawCutLines(page) {
    const topPdf = flipY(marginY);
    const bottomPdf = flipY(marginY + layout.rows * layout.slotH);
    const left = marginX;
    const right = marginX + layout.cols * layout.slotW;

    const xs = [];
    for (let c = 0; c <= layout.cols; c++) xs.push(marginX + c * layout.slotW);
    const ysPdf = [];
    for (let r = 0; r <= layout.rows; r++) ysPdf.push(flipY(marginY + r * layout.slotH));

    if (options.cutlineStyle === "grid") {
      for (const x of xs) {
        page.drawLine({
          start: { x, y: bottomPdf }, end: { x, y: topPdf },
          thickness: cutW, color: lineColor,
        });
      }
      for (const y of ysPdf) {
        page.drawLine({
          start: { x: left, y }, end: { x: right, y },
          thickness: cutW, color: lineColor,
        });
      }
    } else {
      for (const x of xs) {
        page.drawLine({
          start: { x, y: topPdf + cutGap },
          end: { x, y: topPdf + cutGap + cutLen },
          thickness: cutW, color: lineColor,
        });
        page.drawLine({
          start: { x, y: bottomPdf - cutGap },
          end: { x, y: bottomPdf - cutGap - cutLen },
          thickness: cutW, color: lineColor,
        });
      }
      for (const y of ysPdf) {
        page.drawLine({
          start: { x: left - cutGap - cutLen, y },
          end: { x: left - cutGap, y },
          thickness: cutW, color: lineColor,
        });
        page.drawLine({
          start: { x: right + cutGap, y },
          end: { x: right + cutGap + cutLen, y },
          thickness: cutW, color: lineColor,
        });
      }
    }
  }

  let curPage = null;
  let slot = 0;

  for (const srcIdx of seq) {
    if (curPage === null || slot >= layout.perSheet) {
      if (curPage) {
        drawCutLines(curPage);
        drawSheetFooter(curPage);
      }
      curPage = outDoc.addPage([layout.pageW, layout.pageH]);
      slot = 0;
    }

    const col = slot % layout.cols;
    const row = Math.floor(slot / layout.cols);
    const x = marginX + col * layout.slotW;
    const y = flipY(marginY + (row + 1) * layout.slotH);

    curPage.drawPage(embedded[srcIdx], {
      x,
      y,
      width: layout.slotW,
      height: layout.slotH,
    });

    slot++;
  }

  if (curPage) {
    drawCutLines(curPage);
    drawSheetFooter(curPage);
  }

  const outBytes = await outDoc.save();
  logFn(`Done — ${outDoc.getPageCount()} output page(s)`);
  return outBytes;
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
let loadedPdfBytes = null;
let srcPdfjsDoc = null;
let dragSourceCopyRow = null;

function log(msg) {
  const area = $("#log-area");
  area.textContent += msg + "\n";
  area.scrollTop = area.scrollHeight;
}

function clearLog() {
  $("#log-area").textContent = "";
}

function parseNum(val, fallback) {
  const v = parseFloat(val);
  return Number.isNaN(v) ? fallback : v;
}

function parseOptNum(val) {
  if (val === "" || val == null) return null;
  const v = parseFloat(val);
  return Number.isNaN(v) ? null : v;
}

function getPageSizePt() {
  const sel = $("#page-size").value;
  if (sel === "Custom") {
    const w = parseNum($("#custom-page-w").value, 210);
    const h = parseNum($("#custom-page-h").value, 297);
    return [mmToPt(w), mmToPt(h)];
  }
  const [wMm, hMm] = PAGE_SIZES[sel];
  return [mmToPt(wMm), mmToPt(hMm)];
}

// ─── Thumbnail rendering (pdf.js) ───────────────────────────────────────────

async function renderThumbnail(pdfjsDocObj, pageNum, canvas) {
  const page = await pdfjsDocObj.getPage(pageNum);
  const unscaledVp = page.getViewport({ scale: 1 });
  const targetHeight = 80;
  const scale = targetHeight / unscaledVp.height;
  const viewport = page.getViewport({ scale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
}

// ─── File load & copies list ─────────────────────────────────────────────────

async function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;

  $("#file-name").textContent = file.name;
  const baseName = file.name.replace(/\.pdf$/i, "");
  $("#output-name").value = baseName + "_imposed.pdf";

  const buf = await file.arrayBuffer();
  loadedPdfBytes = new Uint8Array(buf);

  try {
    const doc = await PDFLib.PDFDocument.load(loadedPdfBytes);
    const pages = doc.getPages();

    // Load with pdf.js for thumbnail rendering
    const loadingTask = pdfjsLib.getDocument({ data: loadedPdfBytes.slice() });
    srcPdfjsDoc = await loadingTask.promise;

    buildCopiesList(pages, srcPdfjsDoc);
    $("#copies-section").hidden = false;
    $("#generate-btn").disabled = false;
    clearLog();
    log(`Loaded: ${file.name} (${pages.length} page(s))`);
    pages.forEach((p, i) => {
      log(
        `  Page ${i + 1}: ` +
        `${p.getWidth().toFixed(1)}×${p.getHeight().toFixed(1)} pt ` +
        `(${ptToMm(p.getWidth()).toFixed(1)}×${ptToMm(p.getHeight()).toFixed(1)} mm)`
      );
    });
  } catch (err) {
    log(`Error loading PDF: ${err.message}`);
    loadedPdfBytes = null;
    srcPdfjsDoc = null;
    $("#generate-btn").disabled = true;
  }
}

function wireCopyListDrag(listEl) {
  listEl.querySelectorAll(".copy-row").forEach((row) => {
    const handle = row.querySelector(".copy-drag-handle");
    if (!handle) return;

    handle.addEventListener("dragstart", (e) => {
      dragSourceCopyRow = row;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.dataset.srcIdx || "");
    });
    handle.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      listEl.querySelectorAll(".copy-row").forEach((r) => r.classList.remove("drag-over"));
      dragSourceCopyRow = null;
    });

    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("dragenter", (e) => {
      e.preventDefault();
      if (dragSourceCopyRow && dragSourceCopyRow !== row) row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", (e) => {
      if (!row.contains(e.relatedTarget)) row.classList.remove("drag-over");
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const src = dragSourceCopyRow;
      if (!src || src === row) return;
      const rect = row.getBoundingClientRect();
      const afterMid = (e.clientY - rect.top) > rect.height / 2;
      if (afterMid) listEl.insertBefore(src, row.nextSibling);
      else listEl.insertBefore(src, row);
    });
  });
}

function buildCopiesList(pages, pdfjsDocObj) {
  const el = $("#copies-list");
  el.innerHTML = "";

  pages.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "copy-row";
    row.dataset.srcIdx = String(i);

    const handle = document.createElement("span");
    handle.className = "copy-drag-handle";
    handle.textContent = "⠿";
    handle.draggable = true;
    handle.title = "드래그하여 순서 변경 · Drag to reorder";

    const canvas = document.createElement("canvas");
    canvas.className = "copy-thumb";

    const textWrap = document.createElement("div");
    textWrap.className = "copy-info";

    const lbl = document.createElement("span");
    lbl.className = "copy-label";
    lbl.textContent = `Page ${i + 1}`;

    const info = document.createElement("span");
    info.className = "copy-size";
    info.textContent =
      `${ptToMm(p.getWidth()).toFixed(1)} × ${ptToMm(p.getHeight()).toFixed(1)} mm`;

    textWrap.append(lbl, info);

    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = "0";
    inp.value = "1";
    inp.dataset.idx = i;
    inp.className = "copy-input";

    row.append(handle, canvas, textWrap, inp);
    el.appendChild(row);

    if (pdfjsDocObj) {
      renderThumbnail(pdfjsDocObj, i + 1, canvas).catch(() => {});
    }
  });

  wireCopyListDrag(el);
}

function applyAllCopies() {
  const v = $("#set-all-copies").value;
  document.querySelectorAll(".copy-input").forEach((inp) => {
    inp.value = v;
  });
}

function getPageCopies() {
  const copies = [];
  document.querySelectorAll(".copy-input").forEach((inp) => {
    copies[parseInt(inp.dataset.idx, 10)] = parseInt(inp.value, 10) || 0;
  });
  return copies;
}

function getPageOrder() {
  const order = [];
  document.querySelectorAll("#copies-list .copy-row").forEach((row) => {
    order.push(parseInt(row.dataset.srcIdx, 10));
  });
  return order;
}

function resetPageOrder() {
  const list = $("#copies-list");
  const rows = [...list.querySelectorAll(".copy-row")];
  rows.sort((a, b) => parseInt(a.dataset.srcIdx, 10) - parseInt(b.dataset.srcIdx, 10));
  rows.forEach((r) => list.appendChild(r));
}

// ─── Output preview (pdf.js) ────────────────────────────────────────────────

let previewPdfDoc = null;
let previewCurrentPage = 1;

async function showPreview(pdfBytes) {
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
  previewPdfDoc = await loadingTask.promise;
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
  const scale = containerWidth / unscaledVp.width;
  const viewport = page.getViewport({ scale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  $("#page-indicator").textContent =
    `${num} / ${previewPdfDoc.numPages}`;
  $("#prev-page").disabled = num <= 1;
  $("#next-page").disabled = num >= previewPdfDoc.numPages;
}

// ─── Generate handler ────────────────────────────────────────────────────────

async function handleGenerate() {
  if (!loadedPdfBytes) {
    log("Error: No PDF loaded.");
    return;
  }

  clearLog();
  const btn = $("#generate-btn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>처리 중 Processing…';
  $("#download-area").hidden = true;
  $("#preview-section").hidden = true;

  try {
    const margin = parseNum($("#margin").value, 5.0);
    const cardW = parseOptNum($("#card-width").value);
    const cardH = parseOptNum($("#card-height").value);

    if ((cardW == null) !== (cardH == null)) {
      throw new Error(
        "카드 너비와 높이를 모두 입력하거나, 모두 비워주세요.\n" +
        "Provide both card width and height, or leave both empty."
      );
    }

    const [sheetW, sheetH] = getPageSizePt();

    const opts = {
      cardWidthMm: cardW,
      cardHeightMm: cardH,
      marginX: parseNum($("#margin-x").value, margin),
      marginY: parseNum($("#margin-y").value, margin),
      minScale: parseNum($("#min-scale").value, 1.0),
      orientation: $("#orientation").value,
      cutlineWidthMm: parseNum($("#cutline-width").value, 0.2),
      cutlineStyle: $("#cutline-style").value,
      cutlineLengthMm: parseNum($("#cutline-length").value, 5.0),
      cutlineGapMm: parseNum($("#cutline-gap").value, 1.5),
      pageCopies: getPageCopies(),
      pageOrder: getPageOrder(),
      footerText: $("#footer-text").value,
      footerFontSizePt: parseNum($("#footer-font-size").value, 7),
      sheetW,
      sheetH,
    };

    const outBytes = await reflowPdf(loadedPdfBytes, opts, log);

    const blob = new Blob([outBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const link = $("#download-link");
    link.href = url;
    link.download = $("#output-name").value || "output_imposed.pdf";
    link.textContent = `다운로드 Download: ${link.download}`;
    $("#download-area").hidden = false;

    await showPreview(outBytes);
  } catch (err) {
    log(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "생성 Generate";
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  $("#input-pdf").addEventListener("change", handleFileSelect);
  $("#generate-btn").addEventListener("click", handleGenerate);
  $("#apply-all-copies").addEventListener("click", applyAllCopies);
  $("#reset-page-order").addEventListener("click", resetPageOrder);

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
