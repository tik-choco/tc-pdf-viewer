export const AI_MESSAGES = {
    en: {
        explain: 'Explain', translate: 'Translate', chat: 'Chat', ocr: 'OCR',
        explainTip: 'Model used to explain selected or hovered text.',
        translateTip: 'Model used to translate terms and Markdown.',
        chatTip: 'Model used for PDF chat and summaries.',
        ocrTip: 'Vision model used to extract text from page images.',
        settingsTitle: 'AI settings', language: 'Language', guide: 'Open setup guide',
        noModel: 'No usable AI model is configured. Choose a model in AI settings.',
    },
    ja: {
        explain: '説明', translate: '翻訳', chat: 'チャット', ocr: 'OCR',
        explainTip: 'ホバー・選択したテキストの解説に使うモデルです。',
        translateTip: '用語やMarkdownの翻訳に使うモデルです。',
        chatTip: 'PDFのチャットと要約に使うモデルです。',
        ocrTip: 'ページ画像からのテキスト抽出に使うVisionモデルです。',
        settingsTitle: 'AI設定', language: '言語', guide: 'セットアップガイドを開く',
        noModel: '利用できるAIモデルが設定されていません。AI設定でモデルを選択してください。',
    },
    'zh-CN': {
        explain: '解释', translate: '翻译', chat: '聊天', ocr: 'OCR',
        explainTip: '用于解释所选或悬停文本的模型。',
        translateTip: '用于翻译术语和Markdown的模型。',
        chatTip: '用于PDF聊天和摘要的模型。',
        ocrTip: '用于从页面图像提取文本的视觉模型。',
        settingsTitle: 'AI设置', language: '语言', guide: '打开设置指南',
        noModel: '尚未配置可用的AI模型。请在AI设置中选择模型。',
    },
    'zh-TW': {
        explain: '解釋', translate: '翻譯', chat: '聊天', ocr: 'OCR',
        explainTip: '用於解釋所選或懸停文字的模型。',
        translateTip: '用於翻譯術語和Markdown的模型。',
        chatTip: '用於PDF聊天和摘要的模型。',
        ocrTip: '用於從頁面影像擷取文字的視覺模型。',
        settingsTitle: 'AI設定', language: '語言', guide: '開啟設定指南',
        noModel: '尚未設定可用的AI模型。請在AI設定中選擇模型。',
    },
};

export function aiMessages(locale) {
    return AI_MESSAGES[locale] ?? AI_MESSAGES.ja;
}
