import { useState } from 'preact/hooks';
import {
    Sparkles,
    FileText,
    Check,
    ArrowLeft,
    ArrowRight,
    X,
    Plus,
    Columns2,
    MessageCircle,
    Languages,
    RefreshCw,
    Sun,
} from 'lucide-preact';
import { SettingsPanel } from './sidebar/SettingsPanel';

const STEP_COUNT = 4;

const USAGE_FEATURES = [
    {
        icon: Plus,
        title: 'PDFを開く',
        description: 'サイドバーの「＋」ボタンからPDFをアップロード',
    },
    {
        icon: Columns2,
        title: '表示切替',
        description: '上部ボタンで PDF / Markdown / 分割表示を切り替え',
    },
    {
        icon: MessageCircle,
        title: 'AIチャット',
        description: '右上のチャットボタンで、開いているPDFについて質問',
    },
];

const READY_FEATURES = [
    {
        icon: FileText,
        title: 'OCR / Markdown',
        description: 'PDFをMarkdown化して読みやすく表示',
    },
    {
        icon: Languages,
        title: '翻訳',
        description: 'Markdownを他言語に翻訳して並べて読める',
    },
    {
        icon: RefreshCw,
        title: 'デバイス同期',
        description: 'サイドバーの同期ボタンで他のデバイスとライブラリを共有',
    },
    {
        icon: Sun,
        title: 'テーマ',
        description: 'サイドバーのボタンでライト/ダーク切替',
    },
];

function FeatureList({ features }) {
    return (
        <ul className="ob-feature-list">
            {features.map(({ icon: Icon, title, description }) => (
                <li key={title}>
                    <Icon size={18} />
                    <div>
                        <strong>{title}</strong>
                        <span>{description}</span>
                    </div>
                </li>
            ))}
        </ul>
    );
}

function OnboardingDots({ step }) {
    return (
        <div className="ob-dots">
            {Array.from({ length: STEP_COUNT }, (_, i) => (
                <span key={i} className={`ob-dot ${i === step ? 'is-active' : ''}`} />
            ))}
        </div>
    );
}

export function Onboarding({ onClose }) {
    const [step, setStep] = useState(0);
    const goNext = () => setStep((s) => Math.min(s + 1, STEP_COUNT - 1));
    const goBack = () => setStep((s) => Math.max(s - 1, 0));

    return (
        <div className="ob-overlay">
            <div className="ob-card" role="dialog" aria-modal="true" aria-label="はじめてのセットアップ">
                <button type="button" className="ob-close" aria-label="閉じる" onClick={onClose}>
                    <X size={18} />
                </button>

                {step === 0 && (
                    <div className="ob-hero">
                        <Sparkles size={36} />
                        <h2 className="ob-title">TC PDF Viewer へようこそ！</h2>
                        <p>
                            PDFを読み込んで、OCRでMarkdown化、翻訳、AIチャットでの質問までできるビューアです。
                        </p>
                        <p>
                            まずはAIの接続設定だけ準備しましょう。あとから設定画面でいつでも変更できます。
                        </p>
                    </div>
                )}

                {step === 1 && <div className="ob-body"><SettingsPanel showGuide={false} /></div>}

                {step === 2 && (
                    <>
                        <div className="ob-step-head">
                            <FileText size={24} />
                            <h2 className="ob-title">基本の使い方</h2>
                        </div>
                        <div className="ob-body">
                            <FeatureList features={USAGE_FEATURES} />
                        </div>
                    </>
                )}

                {step === 3 && (
                    <>
                        <div className="ob-step-head">
                            <Check size={24} />
                            <h2 className="ob-title">準備完了です！</h2>
                        </div>
                        <div className="ob-body">
                            <FeatureList features={READY_FEATURES} />
                            <p>それでは、快適なPDFライフを！</p>
                        </div>
                    </>
                )}

                <div className="ob-footer">
                    <OnboardingDots step={step} />
                    <div className="ob-footer-actions">
                        {step > 0 && step < 3 && (
                            <button type="button" className="ob-btn" onClick={goBack}>
                                <ArrowLeft size={16} />
                                戻る
                            </button>
                        )}
                        {step === 0 && (
                            <button type="button" className="ob-btn ob-btn-accent" onClick={goNext}>
                                はじめる
                                <ArrowRight size={16} />
                            </button>
                        )}
                        {step === 1 && (
                            <button type="button" className="ob-btn ob-btn-accent" onClick={goNext}>
                                保存して次へ
                                <ArrowRight size={16} />
                            </button>
                        )}
                        {step === 2 && (
                            <button type="button" className="ob-btn ob-btn-accent" onClick={goNext}>
                                次へ
                                <ArrowRight size={16} />
                            </button>
                        )}
                        {step === 3 && (
                            <button type="button" className="ob-btn ob-btn-accent" onClick={onClose}>
                                完了
                                <Check size={16} />
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
