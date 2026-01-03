import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { SYSTEM_INSTRUCTION, BOOK_CONTEXT } from './constants';
import { decode, decodeAudioData, createBlob } from './services/audio-helper';
import { Message, SessionState } from './types';
import { AudioVisualizer } from './components/AudioVisualizer';
import { 
  Mic, MicOff, Brain, Activity, History, Settings, 
  HelpCircle, ChevronRight, Book, AlertCircle, 
  RefreshCw, Terminal, Share2, Upload, FileText, X, CheckCircle2
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';

// Initialize PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://esm.sh/pdfjs-dist@4.10.38/build/pdf.worker.mjs`;

interface UploadedFile {
  id: string;
  name: string;
  text: string;
  pageCount: number;
}

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [session, setSession] = useState<SessionState>({
    isActive: false,
    isConnecting: false,
    error: null,
  });
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexingProgress, setIndexingProgress] = useState(0);

  // Use refs for transcriptions to avoid stale closures in persistent Live API callbacks
  const userTranscriptRef = useRef('');
  const aiTranscriptRef = useRef('');
  
  const [displayTranscript, setDisplayTranscript] = useState({ user: '', ai: '' });
  const [conceptsMastered] = useState<string[]>(['QCS Framework', 'Data Operating Model', '5D Process', 'Hindi Translation']);

  const sessionRef = useRef<any>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => cleanup();
  }, []);

  const cleanup = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      try { inputAudioCtxRef.current.close(); } catch (e) {}
      inputAudioCtxRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      try { outputAudioCtxRef.current.close(); } catch (e) {}
      outputAudioCtxRef.current = null;
    }
    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();
    setSession(prev => ({ ...prev, isActive: false, isConnecting: false }));
    setIsSpeaking(false);
    nextStartTimeRef.current = 0;
  }, []);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || file.type !== 'application/pdf') return;

    setIsIndexing(true);
    setIndexingProgress(0);
    
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let fullText = '';
      
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item: any) => item.str).join(' ');
        fullText += `--- Page ${i} ---\n${pageText}\n\n`;
        setIndexingProgress(Math.round((i / pdf.numPages) * 100));
      }

      const newFile: UploadedFile = {
        id: Math.random().toString(36).substr(2, 9),
        name: file.name,
        text: fullText,
        pageCount: pdf.numPages
      };

      setUploadedFiles(prev => [...prev, newFile]);
    } catch (err) {
      console.error('Indexing error:', err);
      alert('Failed to process PDF. Please try a different file.');
    } finally {
      setIsIndexing(false);
      setIndexingProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const removeFile = (id: string) => {
    setUploadedFiles(prev => prev.filter(f => f.id !== id));
  };

  const startSession = async () => {
    if (session.isConnecting) return;

    setSession({ isActive: false, isConnecting: true, error: null });

    try {
      if (window.aistudio && !(await window.aistudio.hasSelectedApiKey())) {
        await window.aistudio.openSelectKey();
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      const inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioCtxRef.current = inputAudioContext;
      outputAudioCtxRef.current = outputAudioContext;

      const outputNode = outputAudioContext.createGain();
      outputNode.connect(outputAudioContext.destination);

      const dynamicContext = uploadedFiles.map(f => `FILE: ${f.name}\nCONTENT:\n${f.text}`).join('\n\n');
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            setSession({ isActive: true, isConnecting: false, error: null });
            
            const source = inputAudioContext.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContext.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then((s) => {
                s.sendRealtimeInput({ media: pcmBlob });
              }).catch(() => {});
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContext.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64EncodedAudioString = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64EncodedAudioString) {
              setIsSpeaking(true);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContext.currentTime);
              const audioBuffer = await decodeAudioData(
                decode(base64EncodedAudioString),
                outputAudioContext,
                24000,
                1,
              );
              const source = outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputNode);
              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setIsSpeaking(false);
              });

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }

            if (message.serverContent?.outputTranscription) {
              aiTranscriptRef.current += message.serverContent.outputTranscription.text;
              setDisplayTranscript(prev => ({ ...prev, ai: aiTranscriptRef.current }));
            }
            if (message.serverContent?.inputTranscription) {
              userTranscriptRef.current += message.serverContent.inputTranscription.text;
              setDisplayTranscript(prev => ({ ...prev, user: userTranscriptRef.current }));
            }

            if (message.serverContent?.turnComplete) {
              const userText = userTranscriptRef.current;
              const aiText = aiTranscriptRef.current;
              if (userText || aiText) {
                setMessages(prev => [
                  ...prev,
                  ...(userText ? [{ id: `${Date.now()}-u`, role: 'user' as const, text: userText, timestamp: new Date() }] : []),
                  ...(aiText ? [{ id: `${Date.now()}-m`, role: 'model' as const, text: aiText, timestamp: new Date() }] : [])
                ]);
              }
              userTranscriptRef.current = '';
              aiTranscriptRef.current = '';
              setDisplayTranscript({ user: '', ai: '' });
            }
          },
          onerror: (e) => {
            console.error('Session error:', e);
            setSession(prev => ({ ...prev, error: 'Connection lost. Restarting may help.', isActive: false, isConnecting: false }));
          },
          onclose: () => {
            setSession(prev => ({ ...prev, isActive: false, isConnecting: false }));
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION + 
            "\n\nDATABASE CONTEXT:\n" + BOOK_CONTEXT + 
            "\n\nADDITIONAL UPLOADED MATERIALS:\n" + (dynamicContext || "No additional files uploaded."),
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
          }
        },
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error(err);
      setSession({
        isActive: false,
        isConnecting: false,
        error: err.message || 'Failed to initialize session.',
      });
    }
  };

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 font-sans overflow-hidden">
      {/* Sidebar Navigation */}
      <div className={`${showSidebar ? 'w-80' : 'w-0'} transition-all duration-300 border-r border-slate-800 bg-slate-900/50 backdrop-blur-xl flex flex-col relative`}>
        <div className="p-6 border-b border-slate-800 flex items-center gap-3">
          <div className="p-2 bg-indigo-600 rounded-lg">
            <Brain className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-lg leading-tight">Pillar AI</h1>
            <p className="text-xs text-slate-400">Executive Tutor</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <section>
            <div className="flex items-center justify-between mb-3 px-2">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">E-Book Library</h2>
              <button 
                onClick={() => fileInputRef.current?.click()}
                className="p-1.5 hover:bg-slate-800 rounded-md text-indigo-400 transition-colors"
                title="Upload PDF E-book"
              >
                <Upload className="w-4 h-4" />
              </button>
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileUpload} 
                accept=".pdf" 
                className="hidden" 
              />
            </div>
            
            <div className="space-y-2">
              <div className="p-3 bg-indigo-600/10 border border-indigo-500/30 rounded-xl">
                <div className="flex items-center gap-3 mb-1">
                  <FileText className="w-4 h-4 text-indigo-400" />
                  <span className="text-sm font-medium text-slate-200">Data as Fourth Pillar</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-indigo-400 font-bold uppercase tracking-widest">Pre-Installed</span>
                  <CheckCircle2 className="w-3 h-3 text-indigo-400" />
                </div>
              </div>

              {uploadedFiles.map((file) => (
                <div key={file.id} className="p-3 bg-slate-800/50 border border-slate-700/50 rounded-xl group">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-3 overflow-hidden">
                      <FileText className="w-4 h-4 text-slate-400" />
                      <span className="text-sm font-medium text-slate-300 truncate">{file.name}</span>
                    </div>
                    <button 
                      onClick={() => removeFile(file.id)}
                      className="p-1 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <span className="text-[10px] text-slate-500">{file.pageCount} Pages Indexed</span>
                </div>
              ))}

              {isIndexing && (
                <div className="p-3 bg-slate-900 border border-indigo-500/50 border-dashed rounded-xl animate-pulse">
                  <div className="flex items-center gap-3 mb-2">
                    <RefreshCw className="w-4 h-4 text-indigo-500 animate-spin" />
                    <span className="text-xs font-medium text-indigo-300">Indexing Content...</span>
                  </div>
                  <div className="w-full bg-slate-800 h-1 rounded-full overflow-hidden">
                    <div className="bg-indigo-500 h-full transition-all duration-300" style={{ width: `${indexingProgress}%` }}></div>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section>
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 px-2">Mastery Index</h2>
            <div className="space-y-2">
              {conceptsMastered.map((concept, i) => (
                <div key={i} className="flex items-center gap-3 p-2 rounded-md hover:bg-slate-800/50 transition-colors cursor-default">
                  <div className="w-2 h-2 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]" />
                  <span className="text-sm text-slate-300">{concept}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="p-4 border-t border-slate-800 space-y-2">
          <button className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-slate-800 text-sm text-slate-400 transition-colors">
            <div className="flex items-center gap-3"><Settings className="w-4 h-4" /> Preferences</div>
            <ChevronRight className="w-4 h-4" />
          </button>
          <button className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-slate-800 text-sm text-slate-400 transition-colors">
            <div className="flex items-center gap-3"><HelpCircle className="w-4 h-4" /> Help Center</div>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Interaction Area */}
      <div className="flex-1 flex flex-col relative">
        <header className="h-16 border-b border-slate-800 flex items-center justify-between px-8 bg-slate-950/80 backdrop-blur-md z-10">
          <div className="flex items-center gap-4">
            <button onClick={() => setShowSidebar(!showSidebar)} className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 transition-colors">
              <Activity className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${session.isActive ? 'bg-indigo-500 animate-pulse' : 'bg-slate-600'}`} />
              <span className="text-sm font-medium">{session.isActive ? 'Neural Link Established' : 'System Standby'}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="p-2 hover:bg-slate-800 rounded-lg text-slate-400"><History className="w-5 h-5" /></button>
            <button className="p-2 hover:bg-slate-800 rounded-lg text-slate-400"><Share2 className="w-5 h-5" /></button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8 space-y-6 scroll-smooth">
          {messages.length === 0 && !session.isActive && !session.isConnecting && (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-2xl mx-auto space-y-6">
              <div className="w-20 h-20 bg-indigo-600/20 rounded-3xl flex items-center justify-center mb-4 relative">
                <Brain className="w-10 h-10 text-indigo-500 relative z-10" />
                <div className="absolute inset-0 bg-indigo-500/20 blur-xl rounded-full"></div>
              </div>
              <h2 className="text-4xl font-bold text-white tracking-tight">Your Digital Mentor</h2>
              <p className="text-slate-400 text-lg leading-relaxed font-light">
                Ask me questions in English or <span className="text-indigo-400 font-semibold">Hindi</span>. I can teach you from the core e-book or any PDF you upload to the library.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
                <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl text-left hover:border-indigo-500/50 transition-all group">
                  <div className="flex items-center gap-3 mb-3">
                    <Book className="w-5 h-5 text-indigo-500" />
                    <h3 className="font-semibold text-white">RAG Indexing</h3>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed">Advanced Retrieval-Augmented Generation across your entire library.</p>
                </div>
                <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl text-left hover:border-indigo-500/50 transition-all group">
                  <div className="flex items-center gap-3 mb-3">
                    <Terminal className="w-5 h-5 text-indigo-500" />
                    <h3 className="font-semibold text-white">Hindi Fluency</h3>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed">Deep semantic understanding and explanations in Hindi for all concepts.</p>
                </div>
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl p-5 shadow-xl ${
                m.role === 'user' 
                  ? 'bg-indigo-600 text-white shadow-indigo-950/20' 
                  : 'bg-slate-900 border border-slate-800 text-slate-200'
              }`}>
                <p className="text-sm leading-relaxed">{m.text}</p>
                <div className="flex items-center justify-between mt-3 opacity-40">
                  <span className="text-[10px] uppercase font-bold tracking-widest">{m.role}</span>
                  <span className="text-[10px]">{m.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </div>
            </div>
          ))}

          {(displayTranscript.user || displayTranscript.ai) && (
            <div className="space-y-4 pt-4 border-t border-slate-800/50">
              {displayTranscript.user && (
                <div className="flex justify-end opacity-60">
                  <div className="max-w-[70%] bg-indigo-600/30 rounded-2xl p-3 border border-indigo-500/20">
                    <p className="text-sm italic">{displayTranscript.user}...</p>
                  </div>
                </div>
              )}
              {displayTranscript.ai && (
                <div className="flex justify-start">
                  <div className="max-w-[70%] bg-slate-800/80 rounded-2xl p-4 border border-slate-700 animate-in fade-in slide-in-from-left-4">
                    <div className="flex items-center gap-2 mb-2">
                       <Activity className="w-3 h-3 text-indigo-400 animate-pulse" />
                       <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">Reasoning</span>
                    </div>
                    <p className="text-sm italic text-slate-400">{displayTranscript.ai}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="p-8 bg-gradient-to-t from-slate-950 via-slate-950 to-transparent">
          <div className="max-w-3xl mx-auto">
            {session.error && (
              <div className="mb-6 p-4 bg-red-900/20 border border-red-500/50 rounded-2xl flex items-center gap-3 text-red-400 text-sm animate-in zoom-in">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <span className="flex-1">{session.error}</span>
                <button onClick={startSession} className="p-2 hover:bg-red-500/20 rounded-lg transition-colors"><RefreshCw className="w-4 h-4" /></button>
              </div>
            )}

            <div className="bg-slate-900/40 border border-slate-800/50 p-8 rounded-[40px] backdrop-blur-2xl shadow-2xl relative overflow-hidden">
              <div className="absolute inset-0 opacity-10 pointer-events-none">
                 <AudioVisualizer isActive={session.isActive} isSpeaking={isSpeaking} />
              </div>
              
              <div className="flex flex-col items-center gap-8 relative z-10">
                <div className="flex items-center gap-8">
                  <button 
                    disabled={session.isConnecting || isIndexing}
                    onClick={session.isActive ? cleanup : startSession}
                    className={`group relative p-10 rounded-full transition-all duration-700 transform active:scale-90 ${
                      session.isActive 
                        ? 'bg-red-500/10 hover:bg-red-500/20 border border-red-500/50' 
                        : 'bg-indigo-600 hover:bg-indigo-500 border border-indigo-400 shadow-[0_0_40px_rgba(79,70,229,0.5)]'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {session.isConnecting ? (
                      <RefreshCw className="w-12 h-12 animate-spin text-white" />
                    ) : session.isActive ? (
                      <MicOff className="w-12 h-12 text-red-500" />
                    ) : (
                      <Mic className="w-12 h-12 text-white" />
                    )}
                    {session.isActive && (
                      <div className="absolute inset-0 rounded-full border border-red-500 animate-ping opacity-20" />
                    )}
                  </button>
                </div>

                <div className="flex flex-col items-center gap-2 text-center">
                  <p className="text-base font-bold tracking-[0.2em] text-slate-200 uppercase">
                    {session.isConnecting ? 'Synthesizing Neural Link...' : 
                     isIndexing ? 'Indexing Chapters...' :
                     session.isActive ? (isSpeaking ? 'Teaching Model Active' : 'Waiting for Query...') : 
                     'Initialize Executive Mentor'}
                  </p>
                  <p className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.3em]">
                    Enhanced with Mind & Multi-Book Memory
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;