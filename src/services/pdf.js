import * as pdfjs from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.js',
  import.meta.url
).toString();

export async function extractText(pdfBuffer, maxPages = 10) {
  try {
    const loadingTask = pdfjs.getDocument({ data: clonePdfData(pdfBuffer) });
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

export async function renderPdfPagesToImages(
  pdfBuffer,
  {
    maxPages = Number.POSITIVE_INFINITY,
    scale = 2,
    mimeType = 'image/jpeg',
    quality = 0.88,
    onProgress,
  } = {}
) {
  const loadingTask = pdfjs.getDocument({ data: clonePdfData(pdfBuffer) });
  const pdf = await loadingTask.promise;
  const pageCount = Math.min(pdf.numPages, maxPages);
  const images = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: context,
      viewport,
    }).promise;

    images.push({
      pageNumber: i,
      dataUrl: canvas.toDataURL(mimeType, quality),
    });

    onProgress?.({ done: i, total: pageCount });
  }

  return images;
}
