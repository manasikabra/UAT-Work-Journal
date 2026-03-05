import React, { useState, useEffect, useRef } from 'react';
import { CheckCircle2, FileText, Loader2, Sparkles, AlertCircle, Download, User } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged } from 'firebase/auth';

// --- Configuration & Globals ---
const apiKey = ""; // CRITICAL: Leave this exactly as an empty string (""). Do NOT paste your real API key here.
const GOOGLE_DOC_OUTLINE_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbzS9ksH7RjV_ubXZpVFkFkqpC36rnojp8KuIcql5mRwMEOoDznP3PPIl1rYYGIFLXuK/exec";

const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
    apiKey: "placeholder",
    authDomain: "placeholder",
    projectId: "placeholder"
};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-uat-app';
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const SYSTEM_PROMPT = `You are an AI acting as an experienced UAT Team Lead guiding a user to explain their testing work, documenting it as structured notes. This is a progressive document, not a chat.
--- CORE PURPOSE ---
Guide the user to explain their UAT testing approach thoughtfully, detect mindless/shallow responses, and produce a structured summary. You must remember the user is a TESTER, not a developer. Do not ask how the code is built.
--- DOCUMENT MODEL & LOOP ---
Format: Q: <question> A: <answer>. Previous answers are permanent. Read all history.
Loop: Ask 1 question -> Wait for answer -> Record -> Analyze -> Determine missing info -> Ask next. NEVER ask multiple questions at once.
--- STARTING QUESTION ---
"What are you working on? If you are already working on something, what is it and what is the progress?"
--- TASK CLASSIFICATION & DYNAMIC SCOPING (CRITICAL) ---
Immediately after the user answers the first question, classify the task to determine what to ask next:
1. SIMPLE/COSMETIC/UI TASKS (e.g., logo changes, text edits, color updates):
   - Pivot immediately to UAT UI verification: cross-browser testing, mobile responsiveness, caching issues, visual regressions, or localization.
2. COMPLEX/FUNCTIONAL TASKS (e.g., payment flows, data syncs, API integrations):
   - Ask about step-by-step testing flows, error states, external dependencies, and business impact.
--- REASONING OBJECTIVES ---
Adapt based on the task classification. Generally understand: 1. Feature being tested 2. Relevant testing approach 3. Problem/Impact if it fails 4. UAT real-world scenarios 5. Blockers.
--- UAT SCENARIOS & DEV QA ---
Ask what happens if unresolved in production. Guide towards real-world UAT scenarios. Challenge Dev QA answers (e.g., field validation) with: "That sounds like Dev QA. What real-world situation affects this in production?"
--- MINDFULNESS & DEPTH ---
Detect mindless/short answers. Prompt reflection: "Let's slow down. Walk me through the testing steps." Never accept shallow explanations.
--- HANDLING "I DON'T KNOW" & BLOCKERS ---
Use 2-stage prompt: 1. Real-life scenario 2. System scenario. Never give the answer. If blockers exist, acknowledge, clarify, document.
--- ENDING CONDITION ---
Stop when you clearly understand the feature, the relevant testing approach based on its complexity, the UAT scenarios, and any blockers.
If you see "*** SYSTEM COMMAND ***", you MUST immediately set action to "generate_summary" regardless of completeness.
--- MANDATORY RULES ---
Never: ask about development implementation, rewrite history, ask >1 question at once, accept shallow responses, repeat questions, ask >15 words per question, use Markdown in questions.
Always: adapt to task complexity (UI vs Workflow), ask 1 question at a time, provide a specific tailored placeholder hint for EVERY question.
--- OUTPUT FORMAT ---
Respond with a valid JSON object matching this schema:
{
  "action": "ask_question" | "generate_summary",
  "next_question": "string (Plain text, no markdown. Max 15 words. Required if ask_question)",
  "placeholder_hint": "string (MANDATORY if ask_question. Specific example tailored to 'next_question'. Bullet points '\\n- ' if needed. Max 20 words.)",
  "metrics": { "mindfulness": 0-100, "dev_qa_coverage": 0-100, "uat_coverage": 0-100, "understanding": 0-100 },
  "summary": { "feature": "string", "functionality": "string (or 'Cosmetic/UI update')", "problem": "string", "impact": "string", "how_work_will_start": "string", "scenarios": ["string"], "blockers": "string (or 'None')", "notes": "string" }
}`;

export default function App() {
    const [userName, setUserName] = useState('');
    const [tempName, setTempName] = useState('Alex Tester');
    const [isAuthLoading, setIsAuthLoading] = useState(true);
    const [blocks, setBlocks] = useState([{
        id: '1', type: 'qa', status: 'draft',
        answer: "I am working on testing the new payment gateway integration, specifically the retry logic when a card is declined. Progress: I have set up the sandbox environment and drafted the initial test cases.",
        question: "What are you working on? If you are already working on something, what is it and what is the progress?",
        placeholder: "e.g., Payment retry feature.\nCompleted:\n- Set up sandbox\n- Drafted initial test cases",
    }]);
    const [metrics, setMetrics] = useState({ mindfulness: 0, devQa: 0, uat: 0, understanding: 0 });
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [error, setError] = useState(null);
    const endOfDocRef = useRef(null);

    useEffect(() => {
        endOfDocRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [blocks, isAnalyzing]);

    useEffect(() => {
        const initAuth = async () => {
            try {
                if (initialAuthToken) {
                    await signInWithCustomToken(auth, initialAuthToken);
                } else {
                    await signInAnonymously(auth);
                }
            } catch (e) {
                console.error("Auth failed:", e);
            } finally {
                setIsAuthLoading(false);
            }
        };
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            if (user?.displayName) setUserName(user.displayName);
            setIsAuthLoading(false);
        });
        initAuth();
        return () => unsubscribe();
    }, []);

    const callGemini = async (conversationHistory) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
        const payload = {
            contents: [{ parts: [{ text: conversationHistory }] }],
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            generationConfig: {
                responseMimeType: "application/json"
            }
        };

        // Exponential Backoff Implementation
        const delays = [1000, 2000, 4000, 8000, 16000];
        for (let i = 0; i < delays.length; i++) {
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!res.ok) {
                    if (res.status >= 500 || res.status === 429) {
                        await new Promise(r => setTimeout(r, delays[i]));
                        continue;
                    }
                    const errorText = await res.text();
                    throw new Error(`API error: ${res.status} - ${errorText}`);
                }

                const data = await res.json();
                const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!jsonText) throw new Error("Empty response from AI");
                return JSON.parse(jsonText);
            } catch (err) {
                if (i === delays.length - 1) throw err;
                await new Promise(r => setTimeout(r, delays[i]));
            }
        }
    };

    const handleAnswerSubmit = async (blockId, answerText, forceSummary = false) => {
        if (!answerText.trim() && !forceSummary) return;
        setError(null);
        setIsAnalyzing(true);

        const updatedBlocks = blocks.map(b =>
            b.id === blockId
                ? { ...b, answer: answerText, status: forceSummary && !answerText.trim() ? 'discarded' : 'locked' }
                : b
        ).filter(b => b.status !== 'discarded');

        setBlocks(updatedBlocks);

        try {
            const transcriptStr = updatedBlocks
                .filter(b => b.status === 'locked' && b.type === 'qa')
                .map((b, i) => `Q${i + 1}: ${b.question}\nA${i + 1}: ${b.answer}`)
                .join('\n\n');

            const promptCommand = forceSummary ? `\n\n*** SYSTEM COMMAND ***: The user has manually triggered the summary generation. You MUST set action to "generate_summary" right now.` : '';

            const result = await callGemini(`Tester Name: ${userName}\nHistory:\n${transcriptStr}${promptCommand}`);

            let finalMetrics = metrics;
            if (result && result.metrics) {
                finalMetrics = {
                    mindfulness: result.metrics.mindfulness || 0,
                    devQa: result.metrics.dev_qa_coverage || 0,
                    uat: result.metrics.uat_coverage || 0,
                    understanding: result.metrics.understanding || 0
                };
                setMetrics(finalMetrics);
            }

            if (result && result.action === 'ask_question' && !forceSummary) {
                setBlocks(prev => [...prev, {
                    id: Date.now().toString(),
                    type: 'qa',
                    question: result.next_question,
                    placeholder: result.placeholder_hint || "Type your explanation here...",
                    answer: "",
                    status: 'draft'
                }]);
            } else {
                const summary = (result && result.summary) || {};
                const payload = {
                    testerName: userName,
                    timestamp: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
                    feature: summary.feature || "Not provided",
                    functionality: summary.functionality || "Not provided",
                    problem: summary.problem || "Not provided",
                    impact: summary.impact || "Not provided",
                    approach: summary.how_work_will_start || "Not provided",
                    scenarios: summary.scenarios || [],
                    blockers: summary.blockers || "None",
                    notes: summary.notes || "",
                    metrics: finalMetrics,
                    transcript: updatedBlocks
                        .filter(b => b.status === 'locked' && b.type === 'qa')
                        .map(b => ({ q: b.question, a: b.answer }))
                };

                setBlocks(prev => [...prev, { id: Date.now().toString(), type: 'summary', data: payload, status: 'locked' }]);

                if (GOOGLE_DOC_OUTLINE_WEBHOOK_URL) {
                    fetch(GOOGLE_DOC_OUTLINE_WEBHOOK_URL, {
                        method: 'POST',
                        mode: 'no-cors',
                        headers: { 'Content-Type': 'text/plain' },
                        body: JSON.stringify(payload)
                    }).catch(err => console.error("Docs sync failed:", err));
                }
            }
        } catch (err) {
            console.error(err);
            setError(`The AI encountered an error: ${err.message}. Please try submitting again.`);
            // Rollback last lock if failed
            setBlocks(blocks);
        } finally {
            setIsAnalyzing(false);
        }
    };

    if (isAuthLoading) return <div className="min-h-screen flex items-center justify-center bg-[#fafafa]"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;

    if (!userName) {
        return (
            <div className="min-h-screen bg-[#fafafa] flex items-center justify-center p-6">
                <div className="bg-white p-8 rounded-2xl shadow-sm border border-gray-200 max-w-md w-full animate-in zoom-in duration-300">
                    <div className="flex items-center space-x-3 mb-6">
                        <div className="bg-blue-600 p-2.5 rounded-xl shadow-lg shadow-blue-200"><FileText className="w-6 h-6 text-white" /></div>
                        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">UAT Work Journal</h1>
                    </div>
                    <p className="text-gray-500 mb-8 leading-relaxed">Please enter your name to start the testing log.</p>
                    <form onSubmit={(e) => { e.preventDefault(); if (tempName.trim()) setUserName(tempName.trim()); }}>
                        <div className="relative mb-6">
                            <User className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                            <input type="text" value={tempName} onChange={(e) => setTempName(e.target.value)} placeholder="Full Name" className="w-full pl-11 pr-4 py-3.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-4 focus:ring-blue-50 outline-none transition-all font-medium" autoFocus />
                        </div>
                        <button type="submit" disabled={!tempName.trim()} className="w-full py-4 bg-gray-900 text-white rounded-xl font-bold hover:bg-gray-800 disabled:opacity-50 transition-all active:scale-[0.98]">Start Journal</button>
                    </form>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#fafafa] text-gray-800 font-sans selection:bg-blue-100">
            <header className="sticky top-0 z-20 bg-[#fafafa]/90 backdrop-blur-md border-b border-gray-200 shadow-sm">
                <div className="max-w-3xl mx-auto px-6 py-3 flex items-center justify-between">
                    <div className="flex flex-col">
                        <div className="flex items-center space-x-2">
                            <div className="bg-blue-600 p-1 rounded-md"><FileText className="w-4 h-4 text-white" /></div>
                            <h1 className="font-semibold text-sm tracking-tight">UAT Work Journal</h1>
                        </div>
                        <div className="flex items-center text-[10px] text-gray-500 font-bold mt-1 ml-7 space-x-2 uppercase tracking-wider">
                            <span>{new Date().toLocaleDateString()}</span><span>•</span><span className="truncate max-w-[100px] text-blue-600">{userName}</span>
                        </div>
                    </div>
                    <div className="flex items-center space-x-3 md:space-x-5">
                        <MetricRing label="Mindful" value={metrics.mindfulness} colorClass="text-purple-500" />
                        <MetricRing label="Dev QA" value={metrics.devQa} colorClass="text-orange-500" />
                        <MetricRing label="UAT" value={metrics.uat} colorClass="text-green-500" />
                        <MetricRing label="Clarity" value={metrics.understanding} colorClass="text-blue-500" />
                    </div>
                </div>
            </header>

            <main className="max-w-3xl mx-auto px-6 py-12 pb-32">
                <div className="mb-12 border-b border-gray-200 pb-8 animate-in fade-in slide-in-from-top-4 duration-500">
                    <h2 className="text-4xl font-extrabold mb-4 tracking-tight text-gray-900 text-center sm:text-left">Testing Journal</h2>
                    <p className="text-gray-500 text-lg leading-relaxed text-center sm:text-left italic underline decoration-blue-200 underline-offset-8">Tester: {userName}</p>
                </div>

                <div className="space-y-12">
                    {blocks.map((block, index) => {
                        if (block.type === 'qa') return (
                            <QABlock
                                key={block.id}
                                block={block}
                                index={index + 1}
                                onSubmit={(answer, force) => handleAnswerSubmit(block.id, answer, force)}
                                disabled={isAnalyzing || block.status === 'locked'}
                                understandingScore={metrics.understanding}
                            />
                        );
                        if (block.type === 'summary') return <SummaryBlock key={block.id} summary={block.data} />;
                        return null;
                    })}
                </div>

                {isAnalyzing && (
                    <div className="mt-12 flex items-start space-x-4 animate-pulse opacity-60">
                        <Sparkles className="w-4 h-4 text-blue-600 mt-1" />
                        <div className="space-y-3 flex-1">
                            <div className="h-4 bg-gray-200 rounded w-1/4"></div>
                            <div className="h-4 bg-gray-200 rounded w-3/4"></div>
                        </div>
                    </div>
                )}

                {error && (
                    <div className="mt-8 p-4 bg-red-50 text-red-700 rounded-lg border border-red-100 flex items-start space-x-3">
                        <AlertCircle className="w-5 h-5 flex-shrink-0" />
                        <p className="text-sm font-medium">{error}</p>
                    </div>
                )}
                <div ref={endOfDocRef} />
            </main>
        </div>
    );
}

function QABlock({ block, index, onSubmit, disabled, understandingScore }) {
    const [localAnswer, setLocalAnswer] = useState(block.answer || '');
    const textareaRef = useRef(null);
    const canSummarize = understandingScore >= 80;

    useEffect(() => {
        if (textareaRef.current && block.status === 'draft') {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
        }
    }, [localAnswer, block.status]);

    if (block.status === 'locked') return (
        <div className="group transition-all">
            <h3 className="text-xl font-bold mb-3 text-gray-900 leading-snug">{block.question}</h3>
            <div className="text-lg text-gray-700 pl-5 border-l-4 border-gray-100 whitespace-pre-wrap leading-relaxed">{block.answer}</div>
        </div>
    );

    return (
        <div className="bg-white p-7 rounded-2xl border border-gray-200 shadow-sm focus-within:ring-4 focus-within:ring-blue-50 focus-within:border-blue-200 transition-all animate-in slide-in-from-bottom-4">
            <div className="flex items-start space-x-3 mb-5">
                <div className="bg-blue-600 text-white rounded-lg w-7 h-7 flex items-center justify-center flex-shrink-0 text-xs font-black mt-0.5 shadow-md shadow-blue-100">{index}</div>
                <h3 className="text-xl font-bold text-gray-900 leading-snug">{block.question}</h3>
            </div>
            <div className="pl-10">
                <textarea
                    ref={textareaRef}
                    value={localAnswer}
                    onChange={(e) => setLocalAnswer(e.target.value)}
                    disabled={disabled}
                    placeholder={block.placeholder}
                    className="w-full text-lg text-gray-700 bg-transparent border-none outline-none resize-none placeholder-gray-400 p-0 focus:ring-0 min-h-[80px] leading-relaxed"
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit(localAnswer, false); }}
                />
                <div className="mt-6 border-t border-gray-50 pt-5 flex flex-col sm:flex-row items-center justify-between gap-4">
                    <span className="text-[11px] font-bold text-gray-400 order-2 sm:order-1 uppercase tracking-widest">Cmd + Enter to Lock</span>
                    <div className="flex space-x-3 order-1 sm:order-2">
                        {canSummarize && (
                            <button
                                onClick={() => onSubmit(localAnswer, true)}
                                disabled={disabled}
                                className="flex items-center space-x-2 px-6 py-3 bg-green-600 text-white rounded-xl font-bold hover:bg-green-700 shadow-lg active:scale-95 transition-all"
                            >
                                <Sparkles className="w-4 h-4" />
                                <span>Finish Journal</span>
                            </button>
                        )}
                        <button
                            onClick={() => onSubmit(localAnswer, false)}
                            disabled={disabled || (!localAnswer.trim() && !canSummarize)}
                            className="flex items-center space-x-2 px-6 py-3 bg-gray-900 text-white rounded-xl font-bold active:scale-95 transition-all shadow-lg shadow-gray-200"
                        >
                            {disabled ? <Loader2 className="animate-spin w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                            <span>{canSummarize ? "Add Detail" : "Lock Answer"}</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function SummaryBlock({ summary }) {
    const handleDownloadCSV = () => {
        const headers = ['Date', 'Tester', 'Feature', 'Functionality', 'Problem', 'Impact', 'Approach', 'Scenarios', 'Blockers', 'Notes', 'Mindfulness', 'Dev QA', 'UAT', 'Clarity'];
        const row = [
            summary.timestamp,
            summary.testerName,
            summary.feature,
            summary.functionality,
            summary.problem,
            summary.impact,
            summary.approach,
            summary.scenarios?.join('; '),
            summary.blockers,
            summary.notes,
            summary.metrics?.mindfulness,
            summary.metrics?.devQa,
            summary.metrics?.uat,
            summary.metrics?.understanding
        ].map(v => `"${(v || '').toString().replace(/"/g, '""')}"`);

        const blob = new Blob([headers.join(',') + "\n" + row.join(',')], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `UAT_${summary.testerName.replace(/\s+/g, '_')}.csv`;
        link.click();
    };

    return (
        <div className="mt-16 bg-white rounded-3xl border border-gray-200 shadow-2xl relative p-10 overflow-hidden animate-in fade-in zoom-in-95 duration-1000">
            <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600"></div>
            <div className="flex justify-between items-start mb-10 border-b border-gray-50 pb-8">
                <div className="flex items-center space-x-4">
                    <div className="bg-green-100 p-3 rounded-2xl"><CheckCircle2 className="w-8 h-8 text-green-700" /></div>
                    <div>
                        <h2 className="text-3xl font-black text-gray-900 tracking-tight">Final Work Summary</h2>
                        <p className="text-gray-500 font-medium italic underline decoration-green-200 underline-offset-4">Testing Log Complete</p>
                    </div>
                </div>
                <button onClick={handleDownloadCSV} className="px-5 py-2.5 bg-blue-50 text-blue-700 rounded-xl text-sm font-bold hover:bg-blue-100 transition-colors flex items-center space-x-2">
                    <Download className="w-4 h-4" /><span>Export CSV</span>
                </button>
            </div>
            <div className="space-y-10">
                <SummarySection title="Feature / Task" content={summary.feature} />
                <SummarySection title="Step-by-Step Functionality" content={summary.functionality} />
                <div className="grid md:grid-cols-2 gap-10">
                    <SummarySection title="Problem Solved" content={summary.problem} />
                    <SummarySection title="Business Impact" content={summary.impact} />
                </div>
                <SummarySection title="Approach" content={summary.approach} />
                <div>
                    <h4 className="text-[11px] font-black text-gray-400 uppercase tracking-[0.2em] mb-4">UAT Scenarios</h4>
                    <ul className="grid md:grid-cols-2 gap-4">
                        {summary.scenarios?.map((s, i) => (
                            <li key={i} className="flex items-start space-x-3 p-4 bg-gray-50 rounded-2xl text-gray-700 border border-gray-100 font-medium">
                                <div className="w-2 h-2 rounded-full bg-blue-500 mt-2 flex-shrink-0"></div>
                                <span>{s}</span>
                            </li>
                        ))}
                    </ul>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-12 pt-10 border-t border-gray-50">
                    {['Mindful', 'Dev QA', 'UAT', 'Clarity'].map((l, i) => (
                        <div key={l} className="bg-white p-4 rounded-2xl border border-gray-100 flex flex-col items-center shadow-sm">
                            <span className="text-[10px] text-gray-400 font-black uppercase tracking-widest mb-1">{l}</span>
                            <span className="text-2xl font-black text-gray-900">{(Object.values(summary.metrics || {})[i])}%</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function SummarySection({ title, content }) {
    if (!content || content === 'Not provided') return null;
    return (
        <div>
            <h4 className="text-[11px] font-black text-gray-400 uppercase tracking-[0.2em] mb-2">{title}</h4>
            <p className="text-xl text-gray-800 leading-relaxed font-medium">{content}</p>
        </div>
    );
}

function MetricRing({ label, value, colorClass }) {
    const radius = 14, circumference = 2 * Math.PI * radius, v = Math.min(Math.max(value, 0), 100);
    return (
        <div className="flex flex-col items-center group cursor-help">
            <div className="relative flex items-center justify-center">
                <svg className="w-9 h-9 -rotate-90">
                    <circle cx="18" cy="18" r={radius} stroke="currentColor" strokeWidth="3" fill="transparent" className="text-gray-100" />
                    <circle
                        cx="18"
                        cy="18"
                        r={radius}
                        stroke="currentColor"
                        strokeWidth="3"
                        fill="transparent"
                        strokeDasharray={circumference}
                        strokeDashoffset={circumference - (v / 100) * circumference}
                        className={`transition-all duration-1000 ${colorClass}`}
                        strokeLinecap="round"
                    />
                </svg>
                <span className="absolute text-[10px] font-black text-gray-700">{v}%</span>
            </div>
            <span className="text-[9px] font-black text-gray-400 uppercase mt-1 tracking-tighter">{label}</span>
        </div>
    );
}