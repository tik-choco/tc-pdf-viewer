import { useState, useRef, useEffect } from 'preact/hooks';
import { Send, Trash2, User, Bot, Loader2 } from 'lucide-preact';
import { chatAi } from '../services/ai';
import { Marked } from 'marked';

const marked = new Marked();

export default function Chat({ lastExplainedText, currentPdfName, pdfContent, onResizerMouseDown, isResizing }) {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const scrollRef = useRef(null);

    useEffect(() => {
        if (currentPdfName) {
            const saved = localStorage.getItem(`mist_chat_${currentPdfName}`);
            setMessages(saved ? JSON.parse(saved) : []);
        } else {
            setMessages([]);
        }
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
        if (currentPdfName) localStorage.setItem(`mist_chat_${currentPdfName}`, JSON.stringify(newMessages));
        setInput('');
        setIsLoading(true);

        try {
            const contextMsg = lastExplainedText ?
                `Context: Current term being explained: "${lastExplainedText}"\n\n` : '';

            const pdfDocContext = pdfContent ?
                `PDF Content Digest (first 10 pages):\n${pdfContent.substring(0, 6000)}\n\n` : '';

            const systemPrompt = {
                role: 'system',
                content: `You are a professional PDF analysis assistant. You are discussing a document named "${currentPdfName}".\n${pdfDocContext}${contextMsg}Using the provided PDF content digest and term context, provide highly accurate, professional, and concise answers based on the actual document contents. If the user asks about something not in the provided text, state what you can see while offering general knowledge based on the topic.`
            };

            const response = await chatAi([systemPrompt, ...newMessages], 'chat');
            const finalMessages = [...newMessages, { role: 'assistant', content: response }];
            setMessages(finalMessages);
            if (currentPdfName) localStorage.setItem(`mist_chat_${currentPdfName}`, JSON.stringify(finalMessages));
        } catch (err) {
            const errMessages = [...newMessages, { role: 'assistant', content: 'エラー: ' + err.message }];
            setMessages(errMessages);
            if (currentPdfName) localStorage.setItem(`mist_chat_${currentPdfName}`, JSON.stringify(errMessages));
        } finally {
            setIsLoading(false);
        }
    };

    const clearChat = () => {
        if (confirm('チャットの履歴を消去しますか？')) {
            setMessages([]);
            if (currentPdfName) localStorage.removeItem(`mist_chat_${currentPdfName}`);
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
                        <p>ドキュメントについて質問してください。<br />ホバー中のテキストについても深掘りできます。</p>
                    </div>
                )}
                {messages.map((m, idx) => (
                    <div key={idx} className={`chat-message ${m.role}`}>
                        <div className="msg-icon">
                            {m.role === 'user' ? <User size={14} /> : <Bot size={14} />}
                        </div>
                        <div
                            className="msg-bubble markdown-body"
                            dangerouslySetInnerHTML={{ __html: marked.parse(m.content) }}
                        />
                    </div>
                ))}
                {isLoading && (
                    <div className="chat-message assistant loading">
                        <div className="msg-icon"><Loader2 className="spinning" size={14} /></div>
                        <div className="msg-bubble">思考中...</div>
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
