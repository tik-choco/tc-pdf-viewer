import { pdfjs } from 'react-pdf';
import { pdfJsAssetUrls } from './pdfAssets';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export async function extractText(pdfBuffer, maxPages = 10) {
  try {
    const loadingTask = pdfjs.getDocument(getPdfDocumentParams(pdfBuffer));
    const pdf = await loadingTask.promise;
    let fullText = '';
    
    const pageCount = Math.min(pdf.numPages, maxPages);
    for (let i = 1; i <= pageCount; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');
        fullText += `\n--- Page ${i} ---\n${pageText}\n`;
    }
    
    return fullText.trim();
  } catch (err) {
    console.error('Text extraction failed:', err);
    return '';
  }
}

function clonePdfData(pdfBuffer) {
  if (pdfBuffer instanceof Uint8Array) return pdfBuffer.slice();
  if (pdfBuffer instanceof ArrayBuffer) return pdfBuffer.slice(0);
  return pdfBuffer;
}

export async function getPdfPageCount(pdfBuffer, { signal } = {}) {
  throwIfAborted(signal);
  const loadingTask = pdfjs.getDocument(getPdfDocumentParams(pdfBuffer));
  const abortLoading = () => loadingTask.destroy();
  signal?.addEventListener('abort', abortLoading, { once: true });
  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (err) {
    throwIfAborted(signal);
    throw err;
  } finally {
    signal?.removeEventListener('abort', abortLoading);
  }
  return pdf.numPages;
}

export async function renderPdfPagesToImages(
  pdfBuffer,
  {
    maxPages = Number.POSITIVE_INFINITY,
    scale = 2,
    mimeType = 'image/jpeg',
    quality = 0.88,
    onProgress,
    signal,
    pageNumbers,
  } = {}
) {
  throwIfAborted(signal);
  const loadingTask = pdfjs.getDocument(getPdfDocumentParams(pdfBuffer));
  const abortLoading = () => loadingTask.destroy();
  signal?.addEventListener('abort', abortLoading, { once: true });
  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (err) {
    throwIfAborted(signal);
    throw err;
  } finally {
    signal?.removeEventListener('abort', abortLoading);
  }
  const targetPageNumbers = Array.isArray(pageNumbers) && pageNumbers.length
    ? pageNumbers
    : Array.from({ length: Math.min(pdf.numPages, maxPages) }, (_, i) => i + 1);
  const images = [];

  for (let idx = 0; idx < targetPageNumbers.length; idx++) {
    throwIfAborted(signal);
    const pageNumber = targetPageNumbers[idx];
    const page = await pdf.getPage(pageNumber);
    throwIfAborted(signal);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    const renderTask = page.render({
      canvasContext: context,
      viewport,
    });
    const cancelRender = () => renderTask.cancel();
    signal?.addEventListener('abort', cancelRender, { once: true });
    try {
      await renderTask.promise;
    } catch (err) {
      throwIfAborted(signal);
      throw err;
    } finally {
      signal?.removeEventListener('abort', cancelRender);
    }

    throwIfAborted(signal);

    images.push({
      pageNumber,
      dataUrl: canvas.toDataURL(mimeType, quality),
    });

    onProgress?.({ done: idx + 1, total: targetPageNumbers.length });
  }

  return images;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Request cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

function getPdfDocumentParams(pdfBuffer) {
  return {
    data: clonePdfData(pdfBuffer),
    cMapUrl: pdfJsAssetUrls.cMapUrl,
    cMapPacked: true,
  };
}
