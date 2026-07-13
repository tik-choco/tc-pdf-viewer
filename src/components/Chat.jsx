import { useState, useRef, useEffect } from 'preact/hooks';
import { Send, Trash2, User, Bot, Loader2, Copy, Check } from 'lucide-preact';
import { chatAi } from '../services/ai';
import { renderMarkdown } from '../utils/markdown';
import { loadChatMessages, saveChatMessages, clearChatMessages } from '../services/storage';

const MessageItem = ({ m }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(m.content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className={`chat-message ${m.role}`}>
            {m.role === 'assistant' && (
                <div className="msg-icon">
                    <Bot size={14} />
                </div>
            )}
            <div className="msg-bubble-wrapper">
                {m.role === 'assistant' && (
                    <div className="msg-copy-container">
                        <button
                            className="msg-copy-btn"
                            onClick={handleCopy}
                            title="コピー"
                        >
                            {copied ? <Check size={12} color="#10b981" /> : <Copy size={12} />}
                        </button>
                    </div>
                )}
                <div
                    className="msg-bubble markdown-body"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                />
            </div>
        </div>
    );
};

export default function Chat({ lastExplainedText, currentPdfName, pdfContent, ocrMarkdown, onResizerMouseDown, isResizing }) {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const scrollRef = useRef(null);

    useEffect(() => {
        let cancelled = false;
        if (currentPdfName) {
            loadChatMessages(currentPdfName).then((saved) => {
                if (!cancelled) setMessages(saved);
            });
        } else {
            setMessages([]);
        }
        return () => {
            cancelled = true;
        };
    }, [currentPdfName]);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages, isLoading]);

    const handleSend = async (e) => {
        e?.preventDefault();
        if (!input.trim() || isLoading) return;

        const userMsg = { role: 'user', content: input };
        const newMessages = [...messages, userMsg];
        setMessages(newMessages);
        if (currentPdfName) saveChatMessages(currentPdfName, newMessages).catch((err) => console.warn('failed to save chat message', err));
        setInput('');
        setIsLoading(true);

        try {
            const contextMsg = lastExplainedText ?
                `Context: Current term being explained: "${lastExplainedText}"\n\n` : '';

            const documentContext = ocrMarkdown?.trim()
                ? `OCR Markdown (full document):\n${ocrMarkdown}\n\n`
                : (pdfContent ? `PDF Content Digest (first 10 pages):\n${pdfContent.substring(0, 6000)}\n\n` : '');

            const systemPrompt = {
                role: 'system',
                content: `You are a professional PDF analysis assistant. You are discussing a document named "${currentPdfName}".\n${documentContext}${contextMsg}Using the provided document context and term context, provide highly accurate, professional, and concise answers based on the actual document contents. If the user asks about something not in the provided text, state what you can see while offering general knowledge based on the topic.`
            };

            const assistantIndex = newMessages.length;
            setMessages([...newMessages, { role: 'assistant', content: '' }]);

            const response = await chatAi([systemPrompt, ...newMessages], 'chat', {
                stream: true,
                timeoutMs: 120000,
                onDelta: (_delta, content) => {
                    setMessages(current => {
                        const next = [...current];
                        next[assistantIndex] = { role: 'assistant', content };
                        return next;
                    });
                }
            });
            const finalMessages = [...newMessages, { role: 'assistant', content: response }];
            setMessages(finalMessages);
            if (currentPdfName) saveChatMessages(currentPdfName, finalMessages).catch((err) => console.warn('failed to save chat message', err));
        } catch (err) {
            const errMessages = [...newMessages, { role: 'assistant', content: 'エラー: ' + err.message }];
            setMessages(errMessages);
            if (currentPdfName) saveChatMessages(currentPdfName, errMessages).catch((err2) => console.warn('failed to save chat message', err2));
        } finally {
            setIsLoading(false);
        }
    };

    const clearChat = () => {
        if (confirm('チャットの履歴を消去しますか？')) {
            setMessages([]);
            if (currentPdfName) clearChatMessages(currentPdfName).catch((err) => console.warn('failed to clear chat history', err));
        }
    };

    return (
        <div className={`chat-panel ${isResizing ? 'is-resizing' : ''}`}>
            <div
                className={`resizer-handle chat-resizer ${isResizing ? 'is-resizing' : ''}`}
                onMouseDown={onResizerMouseDown}
            />
            <div className="chat-header">
                <h3> </h3>
                <button className="clear-chat-btn" onClick={clearChat} title="履歴を削除">
                    <Trash2 size={16} />
                </button>
            </div>

            <div className="chat-messages" ref={scrollRef}>
                {messages.length === 0 && (
                    <div className="chat-welcome">
                        <Bot size={32} />
                        <p>ドキュメントについて質問できます！</p>
                    </div>
                )}
                {messages.map((m, idx) => (
                    <div key={idx} className={`chat-message ${m.role}`}>
                        {m.role === 'assistant' && (
                            <div className="msg-icon">
                                <Bot size={14} />
                            </div>
                        )}
                        <div className="msg-bubble-wrapper">
                            {m.role === 'assistant' && (
                                <div className="msg-copy-container">
                                    <button
                                        className="msg-copy-btn"
                                        onClick={() => {
                                            navigator.clipboard.writeText(m.content);
                                        }}
                                        title="コピー"
                                    >
                                        <Copy size={12} />
                                    </button>
                                </div>
                            )}
                            <div
                                className="msg-bubble markdown-body"
                                dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                            />
                        </div>
                    </div>
                ))}
                {isLoading && (
                    <div className="chat-message assistant loading">
                        <div className="msg-icon"><Loader2 className="spinning" size={14} /></div>
                        <div className="msg-bubble-wrapper">
                            <div className="msg-bubble">思考中...</div>
                        </div>
                    </div>
                )}
            </div>

            <form className="chat-input-area" onSubmit={handleSend}>
                <textarea
                    value={input}
                    onInput={e => setInput(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                        }
                    }}
                    placeholder="質問を入力..."
                    rows={1}
                    autoComplete="off"
                />
                <button type="submit" disabled={!input.trim() || isLoading}>
                    <Send size={18} />
                </button>
            </form>
        </div>
    );
}
