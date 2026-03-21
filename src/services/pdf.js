import * as pdfjs from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.js',
  import.meta.url
).toString();

export async function extractText(pdfBuffer, maxPages = 10) {
  try {
    const loadingTask = pdfjs.getDocument({ data: pdfBuffer });
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
