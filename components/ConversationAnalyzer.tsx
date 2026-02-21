"use client";

import { useState, useRef } from "react";
import { ConversationAnalysis, NotablePhrase, InterruptionEvent, SpeakerTopic } from "@/app/api/conversation/route";
import { TranscriptResult } from "@/app/api/transcribe/route";

const SPEAKER_COLORS = ["#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6"];
const SPEAKER_BG = ["#eef2ff", "#fdf2f8", "#fffbeb", "#f0fdf4", "#eff6ff", "#f5f3ff"];

type Phase = "idle" | "recording" | "transcribing" | "analyzing" | "done" | "error";

const DEMOS = [
  { file: "/marriage-story.mp3", label: "Marriage Story", lang: "en" },
  { file: "/dario-amodei-dwarkesh.mp3", label: "Dario Amodei — Dwarkesh", lang: "en" },
  { file: "/Alejandro-Dolina.mp3", label: "Alejandro Dolina", lang: "es" },
  { file: "/Coscu-caja-negra.mp3", label: "Coscu — Caja Negra", lang: "es" },
];

const BIG_FIVE_LABELS: [keyof import("@/app/api/conversation/route").BigFive, string][] = [
  ["extraversion", "Extraversión"],
  ["openness", "Apertura"],
  ["agreeableness", "Amabilidad"],
  ["conscientiousness", "Responsabilidad"],
  ["neuroticism", "Neuroticismo"],
];

function cacheKey(type: "transcript" | "analysis", filename: string) {
  return `conv_${type}_${filename}`;
}
function loadFromCache<T>(type: "transcript" | "analysis", filename: string): T | null {
  try {
    const raw = localStorage.getItem(cacheKey(type, filename));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}
function saveToCache(type: "transcript" | "analysis", filename: string, data: unknown) {
  try { localStorage.setItem(cacheKey(type, filename), JSON.stringify(data)); } catch { }
}


const FILLER_WORDS = /\b(mmm+|ehh*|umm*|uhh*|hmm+|este|eeeh|ahhh*)\b/gi;
const REPEATED_WORDS = /\b(\w{2,})(\s+\1)+\b/gi;

type AnnotationRange = {
  start: number; end: number;
  kind: "strong" | "weak" | "stutter";
  title?: string;
};

function getDisfluencyRanges(text: string): AnnotationRange[] {
  const ranges: AnnotationRange[] = [];

  // Consecutive repeated words: "el el", "si si que si"
  let m: RegExpExecArray | null;
  const repeated = new RegExp(REPEATED_WORDS.source, "gi");
  while ((m = repeated.exec(text)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length, kind: "stutter", title: "Repetición" });
  }

  // Filler sounds
  const fillers = new RegExp(FILLER_WORDS.source, "gi");
  while ((m = fillers.exec(text)) !== null) {
    // skip if already covered by a repeat range
    if (!ranges.some(r => m!.index >= r.start && m!.index < r.end)) {
      ranges.push({ start: m.index, end: m.index + m[0].length, kind: "stutter", title: "Muletilla" });
    }
  }

  return ranges;
}

function renderAnnotated(text: string, phrases: NotablePhrase[], speakerId: number) {
  const ranges: AnnotationRange[] = [];

  for (const h of phrases.filter((p) => p.speakerId === speakerId)) {
    const idx = text.toLowerCase().indexOf(h.phrase.toLowerCase());
    if (idx !== -1) ranges.push({ start: idx, end: idx + h.phrase.length, kind: h.type, title: h.note });
  }

  for (const r of getDisfluencyRanges(text)) ranges.push(r);

  ranges.sort((a, b) => a.start - b.start);

  const nodes: React.ReactNode[] = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.start < pos) continue;
    if (r.start > pos) nodes.push(text.slice(pos, r.start));
    const content = text.slice(r.start, r.end);
    if (r.kind === "strong")
      nodes.push(<span key={r.start} title={r.title} className="rounded px-0.5 cursor-help border-b-2 bg-emerald-100 text-emerald-800 border-emerald-400">{content}</span>);
    else if (r.kind === "weak")
      nodes.push(<span key={r.start} title={r.title} className="rounded px-0.5 cursor-help border-b-2 bg-red-100 text-red-700 border-red-400">{content}</span>);
    else
      nodes.push(<span key={r.start} title={r.title} className="rounded px-0.5 cursor-help border-b-2 border-dashed bg-amber-50 text-amber-700 border-amber-400">{content}</span>);
    pos = r.end;
  }
  if (pos < text.length) nodes.push(text.slice(pos));
  return <span>{nodes}</span>;
}

function BigFiveBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-28 flex-shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="text-xs font-semibold text-gray-600 w-6 text-right">{value}</span>
    </div>
  );
}

function ScorePill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div
        className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm"
        style={{ background: color }}
      >
        {value}
      </div>
      <span className="text-xs text-gray-400">{label}</span>
    </div>
  );
}

export default function ConversationAnalyzer() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [transcript, setTranscript] = useState<TranscriptResult | null>(null);
  const [analysis, setAnalysis] = useState<ConversationAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [cacheHit, setCacheHit] = useState<"transcript" | "analysis" | "both" | null>(null);
  const [language, setLanguage] = useState<"en" | "es">("es");
  const [bigFiveOpen, setBigFiveOpen] = useState(false);
  const [interruptionCursor, setInterruptionCursor] = useState<Record<string, number>>({});
  const [topicCursor, setTopicCursor] = useState<Record<string, number>>({});
  const [activeTopic, setActiveTopic] = useState<{ speakerId: number; topicName: string } | null>(null);
  const turnRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/ogg";
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.start(250);
      mediaRecorderRef.current = recorder;
      setPhase("recording");
      setRecordingSeconds(0);
      timerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
    } catch {
      setError("Acceso al micrófono denegado.");
      setPhase("error");
    }
  };

  const analyzeBlob = async (blob: Blob, filename: string) => {
    const mimeType = blob.type || "audio/mp3";
    setCacheHit(null);
    const filenameWithLang = `${filename}_${language}`;

    try {
      let transcriptData = loadFromCache<TranscriptResult>("transcript", filenameWithLang);
      if (transcriptData) {
        setCacheHit("transcript");
      } else {
        setPhase("transcribing");
        const res = await fetch("/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": mimeType, "x-audio-type": mimeType, "x-language": language },
          body: blob,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "Error al transcribir el audio.");
        }
        transcriptData = await res.json();
        saveToCache("transcript", filenameWithLang, transcriptData);
      }
      setTranscript(transcriptData);

      let analysisData = loadFromCache<ConversationAnalysis>("analysis", filenameWithLang);
      if (analysisData) {
        setCacheHit((prev) => prev === "transcript" ? "both" : "analysis");
      } else {
        setPhase("analyzing");
        const res = await fetch("/api/conversation", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-language": language },
          body: JSON.stringify(transcriptData),
        });
        if (!res.ok) throw new Error(await res.text());
        analysisData = await res.json();
        saveToCache("analysis", filenameWithLang, analysisData);
      }
      setAnalysis(analysisData);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Algo salió mal.");
      setPhase("error");
    }
  };

  const stopAndAnalyze = async () => {
    if (!mediaRecorderRef.current) return;
    if (timerRef.current) clearInterval(timerRef.current);
    await new Promise<void>((resolve) => {
      mediaRecorderRef.current!.onstop = () => resolve();
      mediaRecorderRef.current!.stop();
      mediaRecorderRef.current!.stream.getTracks().forEach((t) => t.stop());
    });
    const mimeType = chunksRef.current[0]?.type ?? "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    if (blob.size < 5000) {
      setError("La grabación es muy corta o no se capturó audio. Intentá hablar por al menos 5 segundos.");
      setPhase("error");
      return;
    }
    const name = `recording_${Date.now()}.webm`;
    setUploadedFileName(name);
    await analyzeBlob(blob, name);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadedFileName(file.name);
    await analyzeBlob(file, file.name);
  };

  const handleDemo = async (demo: typeof DEMOS[0]) => {
    setUploadedFileName(demo.label);
    setLanguage(demo.lang as "en" | "es");
    const filenameWithLang = `${demo.label}_${demo.lang}`;
    setCacheHit(null);

    try {
      let transcriptData = loadFromCache<TranscriptResult>("transcript", filenameWithLang);
      if (transcriptData) {
        setCacheHit("transcript");
      } else {
        setPhase("transcribing");
        const absoluteUrl = `${window.location.origin}${demo.file}`;
        const res = await fetch("/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-language": demo.lang },
          body: JSON.stringify({ url: absoluteUrl }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "Error al transcribir el audio.");
        }
        transcriptData = await res.json();
        saveToCache("transcript", filenameWithLang, transcriptData);
      }
      setTranscript(transcriptData);

      let analysisData = loadFromCache<ConversationAnalysis>("analysis", filenameWithLang);
      if (analysisData) {
        setCacheHit((prev) => prev === "transcript" ? "both" : "analysis");
      } else {
        setPhase("analyzing");
        const res = await fetch("/api/conversation", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-language": demo.lang },
          body: JSON.stringify(transcriptData),
        });
        if (!res.ok) throw new Error(await res.text());
        analysisData = await res.json();
        saveToCache("analysis", filenameWithLang, analysisData);
      }
      setAnalysis(analysisData);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el archivo demo.");
      setPhase("error");
    }
  };

  const clearCacheAndReset = () => {
    if (uploadedFileName) {
      const key = `${uploadedFileName}_${language}`;
      localStorage.removeItem(cacheKey("transcript", key));
      localStorage.removeItem(cacheKey("analysis", key));
    }
    reset();
  };

  const reset = () => {
    setPhase("idle");
    setTranscript(null);
    setAnalysis(null);
    setError(null);
    setRecordingSeconds(0);
    setUploadedFileName(null);
    setCacheHit(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const formatTime = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const scrollToInterruption = (speakerId: number, role: "giver" | "receiver") => {
    const events = (analysis?.interruptionTurns ?? []).filter((it: InterruptionEvent) =>
      role === "giver" ? it.giver === speakerId : it.receiver === speakerId
    );
    if (!events.length) return;
    const key = `${speakerId}-${role}`;
    const cursor = interruptionCursor[key] ?? 0;
    const target = events[cursor % events.length];
    const el = turnRefs.current[target.turnIndex];
    const container = transcriptRef.current;
    if (el && container) {
      container.scrollTo({ top: el.offsetTop - container.offsetTop - 12, behavior: "smooth" });
    }
    setInterruptionCursor((prev) => ({ ...prev, [key]: (cursor + 1) % events.length }));
  };

  const scrollToTopic = (speakerId: number, topic: SpeakerTopic) => {
    // Toggle off if same topic clicked again
    if (activeTopic?.speakerId === speakerId && activeTopic?.topicName === topic.name) {
      setActiveTopic(null);
      return;
    }
    setActiveTopic({ speakerId, topicName: topic.name });

    if (!topic.turnIndices?.length) return;
    const key = `topic-${speakerId}-${topic.name}`;
    const cursor = topicCursor[key] ?? 0;
    const turnIndex = topic.turnIndices[cursor % topic.turnIndices.length];
    const el = turnRefs.current[turnIndex];
    const container = transcriptRef.current;
    if (el && container) {
      container.scrollTo({ top: el.offsetTop - container.offsetTop - 12, behavior: "smooth" });
    }
    setTopicCursor((prev) => ({ ...prev, [key]: (cursor + 1) % topic.turnIndices.length }));
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-gray-50">

      {/* IDLE */}
      {phase === "idle" && (
        <div className="flex flex-col items-center justify-center h-full gap-6 p-8 text-center">
          <span className="text-6xl">🎙</span>
          <div>
            <p className="text-xl font-semibold text-gray-700">Analizá una conversación</p>
            <p className="text-gray-400 text-sm mt-2 max-w-sm">
              Subí un audio o grabá en vivo. La IA identifica participantes y analiza personalidades, lenguaje y dinámica.
            </p>
          </div>

          <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-xl p-1 shadow-sm">
            <button onClick={() => setLanguage("en")} className={`px-5 py-2 rounded-lg text-sm font-semibold transition-colors ${language === "en" ? "bg-indigo-600 text-white shadow" : "text-gray-400 hover:text-gray-600"}`}>
              🇺🇸 Inglés
            </button>
            <button onClick={() => setLanguage("es")} className={`px-5 py-2 rounded-lg text-sm font-semibold transition-colors ${language === "es" ? "bg-indigo-600 text-white shadow" : "text-gray-400 hover:text-gray-600"}`}>
              🇦🇷 Español
            </button>
          </div>

          <div className="flex flex-col gap-3 w-full max-w-xs">
            {DEMOS.filter((d) => d.lang === language).map((demo) => (
              <button key={demo.file} onClick={() => handleDemo(demo)} className="w-full px-6 py-4 rounded-2xl bg-violet-600 text-white font-bold text-sm hover:bg-violet-700 transition-colors shadow-lg text-left">
                ✨ Demo: {demo.label}
              </button>
            ))}
            <label className="w-full px-6 py-4 rounded-2xl border-2 border-dashed border-indigo-300 bg-white text-indigo-700 font-semibold text-sm cursor-pointer hover:bg-indigo-50 transition-colors flex flex-col items-center gap-1">
              <span className="text-xl">📂</span>
              Subir archivo de audio
              <span className="text-xs font-normal text-indigo-400">MP3, M4A, WAV, WebM, OGG</span>
              <input ref={fileInputRef} type="file" accept="audio/*" className="hidden" onChange={handleFileUpload} />
            </label>
            <button onClick={startRecording} className="w-full px-6 py-4 rounded-2xl bg-gray-800 text-white font-bold text-sm hover:bg-gray-900 transition-colors flex items-center justify-center gap-2">
              🔴 Grabar en vivo
            </button>
          </div>
        </div>
      )}

      {/* RECORDING */}
      {phase === "recording" && (
        <div className="flex flex-col items-center justify-center h-full gap-6 p-8 text-center">
          <div className="relative">
            <div className="w-24 h-24 rounded-full bg-red-100 flex items-center justify-center">
              <div className="w-16 h-16 rounded-full bg-red-500 animate-pulse flex items-center justify-center">
                <span className="text-white text-2xl">🎙</span>
              </div>
            </div>
            <div className="absolute -inset-2 rounded-full border-2 border-red-300 animate-ping" />
          </div>
          <p className="text-3xl font-mono font-bold text-gray-800">{formatTime(recordingSeconds)}</p>
          <button onClick={stopAndAnalyze} className="px-8 py-4 rounded-2xl bg-gray-800 text-white font-bold text-lg hover:bg-gray-900 transition-colors shadow-lg">
            Detener y analizar
          </button>
        </div>
      )}

      {/* PROCESSING */}
      {(phase === "transcribing" || phase === "analyzing") && (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
          <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-700 font-semibold text-lg">
            {phase === "transcribing" ? "Transcribiendo audio..." : "Analizando conversación..."}
          </p>
          <p className="text-gray-400 text-sm">
            {phase === "transcribing" ? "Identificando participantes y transcribiendo el audio" : "Evaluando personalidades y calidad de lenguaje"}
          </p>
          {uploadedFileName && <p className="text-xs text-gray-400 mt-1">📂 {uploadedFileName}</p>}
        </div>
      )}

      {/* ERROR */}
      {phase === "error" && (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
          <span className="text-4xl">⚠️</span>
          <p className="text-red-600 font-semibold">{error}</p>
          <button onClick={reset} className="px-6 py-2 rounded-xl bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200">Intentar de nuevo</button>
        </div>
      )}

      {/* RESULTS */}
      {phase === "done" && analysis && transcript && (
        <div className="flex flex-col gap-5 p-5 max-w-4xl mx-auto w-full">

          {/* Top bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {cacheHit && (
                <span className="flex items-center gap-1.5 px-3 py-1 bg-emerald-50 border border-emerald-200 rounded-full text-emerald-700 text-xs font-semibold">
                  ⚡ Desde caché
                  <button onClick={clearCacheAndReset} className="ml-1 text-emerald-500 hover:text-emerald-700 font-bold">✕ rehacer</button>
                </span>
              )}
              <span className="text-sm text-gray-400">
                {transcript.speakerCount} participantes · {Math.round(transcript.durationSeconds / 60)}m{Math.round(transcript.durationSeconds % 60)}s
                {uploadedFileName && ` · ${uploadedFileName}`}
              </span>
            </div>
            <button onClick={reset} className="text-xs text-gray-400 hover:text-gray-600 underline">← Nuevo análisis</button>
          </div>

          {/* Speaker grid */}
          <div className={`grid gap-4 ${analysis.speakers.length >= 3 ? "grid-cols-3" : "grid-cols-2"}`}>
            {analysis.speakers.map((spk) => {
              const color = SPEAKER_COLORS[spk.id % SPEAKER_COLORS.length];
              const bg = SPEAKER_BG[spk.id % SPEAKER_BG.length];
              return (
                <div key={spk.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                  {/* Header */}
                  <div className="px-4 pt-4 pb-3" style={{ background: bg }}>
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-base flex-shrink-0" style={{ background: color }}>
                        {spk.label.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-bold text-gray-800 text-sm">{spk.label}</p>
                        <p className="text-xs text-gray-500">{spk.wordCount} palabras</p>
                      </div>
                    </div>
                    {/* Talk time bar */}
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 bg-white/60 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${spk.talkTimePercent}%`, background: color }} />
                      </div>
                      <span className="text-xs font-bold" style={{ color }}>{spk.talkTimePercent}%</span>
                    </div>
                    {/* Interruptions */}
                    <div className="flex gap-3 mt-2">
                      <button
                        onClick={() => scrollToInterruption(spk.id, "giver")}
                        disabled={spk.interruptionsGiven === 0}
                        className="text-xs text-gray-500 hover:text-indigo-600 disabled:cursor-default disabled:hover:text-gray-500 transition-colors"
                      >
                        ↗ {spk.interruptionsGiven} interrupciones dadas
                      </button>
                      <button
                        onClick={() => scrollToInterruption(spk.id, "receiver")}
                        disabled={spk.interruptionsReceived === 0}
                        className="text-xs text-gray-500 hover:text-indigo-600 disabled:cursor-default disabled:hover:text-gray-500 transition-colors"
                      >
                        ↙ {spk.interruptionsReceived} recibidas
                      </button>
                    </div>
                  </div>

                  {/* Big Five — collapsible (global toggle) */}
                  <div className="border-t border-gray-100">
                    <button
                      onClick={() => setBigFiveOpen((o) => !o)}
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
                    >
                      <p className="text-xs font-bold uppercase tracking-wide text-gray-400">Personalidad</p>
                      <span className="text-gray-400 text-xs">{bigFiveOpen ? "▲" : "▼"}</span>
                    </button>
                    {bigFiveOpen && (
                      <div className="px-4 pb-3 flex flex-col gap-1.5">
                        {BIG_FIVE_LABELS.map(([key, label]) => (
                          <BigFiveBar key={key} label={label} value={spk.bigFive?.[key] ?? 0} color={color} />
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Language + Fluency scores */}
                  <div className="px-4 py-3 border-t border-gray-100">
                    <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-3">Lenguaje</p>
                    <div className="flex justify-around">
                      <ScorePill label="General" value={spk.language.overallScore} color={color} />
                      <ScorePill label="Vocabulario" value={spk.language.vocabularyScore} color={color} />
                      <ScorePill label="Gramática" value={spk.language.grammarScore} color={color} />
                      <ScorePill label="Fluidez" value={spk.fluencyScore ?? 0} color={color} />
                    </div>
                  </div>

                  {/* Topics */}
                  {spk.topics?.length > 0 && (
                    <div className="px-4 py-3 border-t border-gray-100">
                      <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">Temas</p>
                      {/* Stacked bar */}
                      <div className="flex h-2 rounded-full overflow-hidden mb-3">
                        {spk.topics.map((topic, ti) => (
                          <button
                            key={topic.name}
                            onClick={() => scrollToTopic(spk.id, topic)}
                            title={`${topic.name} — ${topic.percent}%`}
                            className="h-full transition-opacity hover:opacity-75"
                            style={{ width: `${topic.percent}%`, background: color, opacity: 1 - ti * 0.2 }}
                          />
                        ))}
                      </div>
                      {/* Legend */}
                      <div className="flex flex-col gap-1">
                        {spk.topics.map((topic, ti) => {
                          const isActive = activeTopic?.speakerId === spk.id && activeTopic?.topicName === topic.name;
                          return (
                            <button
                              key={topic.name}
                              onClick={() => scrollToTopic(spk.id, topic)}
                              className={`flex items-center gap-2 text-left rounded-lg px-1 py-0.5 transition-colors ${isActive ? "bg-indigo-50" : "hover:bg-gray-50"}`}
                            >
                              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color, opacity: 1 - ti * 0.2 }} />
                              <span className={`text-xs flex-1 transition-colors ${isActive ? "text-indigo-600 font-semibold" : "text-gray-600"}`}>{topic.name}</span>
                              <span className="text-xs font-semibold text-gray-400">{topic.percent}%</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Self / Other reference */}
                  <div className="px-4 py-3 border-t border-gray-100">
                    <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">Referencias</p>
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500 w-10 flex-shrink-0">Yo</span>
                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${spk.selfReferencePercent ?? 50}%`, background: color }} />
                        </div>
                        <span className="text-xs font-semibold text-gray-600 w-8 text-right">{spk.selfReferencePercent ?? 50}%</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500 w-10 flex-shrink-0">Otros</span>
                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full bg-gray-400" style={{ width: `${spk.otherReferencePercent ?? 50}%` }} />
                        </div>
                        <span className="text-xs font-semibold text-gray-600 w-8 text-right">{spk.otherReferencePercent ?? 50}%</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Annotated transcript */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-bold uppercase tracking-wide text-gray-400">Transcripción</p>
              <div className="flex items-center gap-3 text-xs text-gray-600 flex-wrap">
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-emerald-100 border-b-2 border-emerald-400 inline-block flex-shrink-0" /> lenguaje destacado</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-red-100 border-b-2 border-red-400 inline-block flex-shrink-0" /> error gramatical</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-amber-50 border-b-2 border-dashed border-amber-400 inline-block flex-shrink-0" /> balbuceo / muletilla</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm border-l-2 border-purple-400 inline-block flex-shrink-0" /> auto-referencial</span>
              </div>
            </div>
            {activeTopic && (
              <p className="text-xs text-indigo-500 mb-2">
                Mostrando: <span className="font-semibold">{activeTopic.topicName}</span>
                <button onClick={() => setActiveTopic(null)} className="ml-2 text-gray-400 hover:text-gray-600">✕</button>
              </p>
            )}
            <div ref={transcriptRef} className="flex flex-col gap-1.5 max-h-80 overflow-y-auto pr-1">
              {transcript.turns.map((turn, i) => {
                const spk = analysis.speakers[turn.speaker];
                const color = SPEAKER_COLORS[turn.speaker % SPEAKER_COLORS.length];
                const bg = SPEAKER_BG[turn.speaker % SPEAKER_BG.length];
                const interruption = (analysis.interruptionTurns ?? []).find(
                  (it: InterruptionEvent) => it.turnIndex === i
                );
                const topicMatch = activeTopic
                  ? analysis.speakers[activeTopic.speakerId]?.topics
                      ?.find((t: SpeakerTopic) => t.name === activeTopic.topicName)
                      ?.turnIndices?.includes(i) ?? false
                  : null;
                // background: interruption > topic > speaker tint > none
                const selfRef = analysis.speakers.some((s) => s.selfTurnIndices?.includes(i) && s.id === turn.speaker);
                const bgStyle = interruption
                  ? { background: "#fffbeb", border: "1px solid #fcd34d" }
                  : topicMatch === true
                  ? { background: bg, borderLeft: selfRef ? "3px solid #c084fc" : undefined }
                  : selfRef
                  ? { borderLeft: "3px solid #c084fc" }
                  : {};
                const opacity = activeTopic && topicMatch === false ? 0.25 : 1;

                return (
                  <div
                    key={i}
                    ref={(el) => { turnRefs.current[i] = el; }}
                    className="flex gap-3 text-sm rounded-lg px-2 py-1 -mx-2 transition-all"
                    style={{ ...bgStyle, opacity, transitionDuration: "200ms" }}
                  >
                    <span className="font-bold flex-shrink-0 w-20 pt-0.5 text-xs" style={{ color }}>
                      {spk?.label ?? `Hablante ${turn.speaker}`}
                      {interruption && (
                        <span className="block text-amber-500 font-normal" title="Interrumpió">↗ corte</span>
                      )}
                    </span>
                    <span className="text-gray-600 leading-relaxed">
                      {renderAnnotated(turn.text, analysis.notablePhrases, turn.speaker)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
