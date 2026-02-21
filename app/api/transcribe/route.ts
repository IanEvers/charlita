import { NextRequest, NextResponse } from "next/server";

export interface DiarizedWord {
  word: string;
  speaker: number;
  start: number;
  end: number;
}

export interface SpeakerTurn {
  speaker: number;
  text: string;
  start: number;
  end: number;
}

export interface TranscriptResult {
  turns: SpeakerTurn[];
  speakerCount: number;
  durationSeconds: number;
}

function buildTurns(words: DiarizedWord[]): SpeakerTurn[] {
  if (!words.length) return [];

  const turns: SpeakerTurn[] = [];
  let current: SpeakerTurn = {
    speaker: words[0].speaker,
    text: words[0].word,
    start: words[0].start,
    end: words[0].end,
  };

  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.speaker === current.speaker) {
      current.text += " " + w.word;
      current.end = w.end;
    } else {
      turns.push(current);
      current = { speaker: w.speaker, text: w.word, start: w.start, end: w.end };
    }
  }
  turns.push(current);
  return turns;
}

export async function POST(req: NextRequest) {
  const language = req.headers.get("x-language") ?? "en";
  const dgUrl = `https://api.deepgram.com/v1/listen?diarize=true&punctuate=true&model=nova-2&language=${language}&smart_format=true`;

  let dgRes: Response;
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const { url } = await req.json() as { url: string };
    dgRes = await fetch(dgUrl, {
      method: "POST",
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
    });
  } else {
    const audioBuffer = await req.arrayBuffer();
    const audioType = req.headers.get("x-audio-type") ?? "audio/webm";
    dgRes = await fetch(dgUrl, {
      method: "POST",
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": audioType,
      },
      body: audioBuffer,
    });
  }

  if (!dgRes.ok) {
    const err = await dgRes.text();
    return NextResponse.json({ error: err }, { status: 500 });
  }

  const dgData = await dgRes.json();
  const channel = dgData?.results?.channels?.[0];
  const alternative = channel?.alternatives?.[0];

  if (!alternative) {
    return NextResponse.json({ error: "No transcription result" }, { status: 500 });
  }

  const rawWords: unknown[] = alternative.words ?? [];
  if (!rawWords.length) {
    const transcript = alternative.transcript ?? "";
    if (!transcript.trim()) {
      return NextResponse.json({ error: "Deepgram no detectó ninguna palabra. Verificá el idioma seleccionado o que el audio tenga voz clara." }, { status: 422 });
    }
  }

  const words: DiarizedWord[] = rawWords.map(
    (w) => {
      const word = w as { punctuated_word?: string; word: string; speaker?: number; start: number; end: number };
      return {
        word: word.punctuated_word ?? word.word,
        speaker: word.speaker ?? 0,
        start: word.start,
        end: word.end,
      };
    }
  );

  const turns = buildTurns(words);
  const speakerSet = new Set(words.map((w) => w.speaker));
  const durationSeconds = words.length ? words[words.length - 1].end : 0;

  const result: TranscriptResult = {
    turns,
    speakerCount: speakerSet.size,
    durationSeconds,
  };

  return NextResponse.json(result);
}
