import fs from "fs";
import OpenAI from "openai";
import dotenv from "dotenv";
import { tempFile, safeUnlink } from "../utils/temp";
import ffmpegStatic from "ffmpeg-static";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { progressMap, outputMap } from "../utils/progress";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const execFileAsync = promisify(execFile);

/* ---------- VOICE POOLS ---------- */
const maleVoices = ["onyx", "nova", "shimmer", "ballad"];
const femaleVoices = ["alloy", "verse", "fable", "coral"];


if (!ffmpegStatic) {
  throw new Error("FFmpeg binary not found");
}

const FFMPEG_PATH = ffmpegStatic;


/* ---------- helpers ---------- */
async function extractAudio(input: string, output: string) {
  await execFileAsync(FFMPEG_PATH, [
    "-i",
    input,
    "-map",
    "a",
    "-q:a",
    "0",
    output,
  ]);
}

async function createSilence(seconds: number, output: string) {
  if (seconds <= 0) return;
  await execFileAsync(FFMPEG_PATH, [
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=mono",
    "-t",
    seconds.toFixed(2),
    output,
  ]);
}

async function translate(text: string): Promise<string> {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: `
Translate Chinese to natural spoken English. Preserve timing, emotion, and pauses.
STRICT RULES:
- Translate ONLY spoken content
- NO explanations
- NO commentary
- NO AI meta language
`,
      },
      { role: "user", content: text },
    ],
  });
  return res.choices[0].message.content!.trim();
}

export async function detectGender(
  audioFile: string
): Promise<"male" | "female"> {
  try {
    // Use FFmpeg astats via node-av path
    const { stderr } = await execFileAsync(FFMPEG_PATH, [
      "-i",
      audioFile,
      "-af",
      "astats=metadata=1:reset=1",
      "-f",
      "null",
      "-",
    ]);

    const rmsMatches = stderr.match(/RMS level dB: (-?\d+\.?\d+)/g);
    if (rmsMatches && rmsMatches.length > 0) {
      const rmsValues = rmsMatches.map((v) =>
        parseFloat(v.split(":")[1].trim())
      );
      const avgRms = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;

      // updated threshold
      return avgRms < -12.5 ? "female" : "male";
    }

    return "male";
  } catch (err) {
    console.error("Gender detection failed, defaulting to male:", err);
    return "female";
  }
}

function assignVoice(gender: "male" | "female", index: number) {
  console.log("jkhjkhk", gender);
  if (gender === "male") {
    return maleVoices[index % maleVoices.length];
  } else {
    return femaleVoices[index % femaleVoices.length];
  }
}

async function speak(
  text: string,
  voice: string,
  output: string,
  emotion: "soft" | "firm" | "neutral" | "energetic" = "neutral"
) {
  const tonePrompt: Record<string, string> = {
    soft: "Speak softly and gently.",
    firm: "Speak clearly with confidence.",
    energetic: "Speak with lively energy.",
    neutral: "Speak naturally.",
  };

  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice,
    input: `${text}`,
  });

  fs.writeFileSync(output, Buffer.from(await speech.arrayBuffer()));
}

async function concatAudio(files: string[], output: string) {
  const list = tempFile(".txt");
  fs.writeFileSync(list, files.map((f) => `file '${f}'`).join("\n"));

  await execFileAsync(FFMPEG_PATH, [
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-c",
    "copy",
    output,
  ]);

  safeUnlink(list);
}

/* ---------- main ---------- */
export async function dubVideo(inputPath: string, jobId: string) {
  // if (!isFfmpegAvailable()) throw new Error("FFmpeg not available");

  const extractedAudio = tempFile(".wav");
  const dubbedAudio = tempFile(".wav");
  const outputVideo = tempFile(".mp4");

  progressMap.set(jobId, 5);
  await extractAudio(inputPath, extractedAudio);

  progressMap.set(jobId, 15);
  const transcription: any = await openai.audio.transcriptions.create({
    file: fs.createReadStream(extractedAudio),
    model: "whisper-1",
    language: "zh",
    response_format: "verbose_json",
  });

  const timeline: string[] = [];
  let lastEnd = 0;

  // Keep track of speakers and their genders
  const speakerGender: Record<string, "male" | "female"> = {};
  const speakerIndex: Record<string, number> = {};

  for (let i = 0; i < transcription.segments.length; i++) {
    const seg = transcription.segments[i];

    // preserve silence
    const gap = seg.start - lastEnd;
    if (gap > 0) {
      const silence = tempFile(".wav");
      await createSilence(gap, silence);
      timeline.push(silence);
    }

    const translated = await translate(seg.text);

    // Determine gender
    let gender: "male" | "female" = "male";
    const speakerKey = seg.speaker || `segment_${i}`;

    if (!speakerGender[speakerKey]) {
      // extract audio for segment only
      const segmentAudio = tempFile(".wav");
      await execFileAsync(FFMPEG_PATH, [
        "-i",
        extractedAudio,
        "-ss",
        seg.start.toString(),
        "-to",
        seg.end.toString(),
        "-c",
        "copy",
        segmentAudio,
      ]);

      gender = await detectGender(segmentAudio);
      speakerGender[speakerKey] = gender;
      safeUnlink(segmentAudio);
    } else {
      gender = speakerGender[speakerKey];
    }

    // Voice variation per speaker
    if (!speakerIndex[speakerKey]) speakerIndex[speakerKey] = 0;
    const voice = assignVoice(gender, speakerIndex[speakerKey]++);

    // Emotion heuristic
    let emotion: "soft" | "firm" | "neutral" | "energetic" = "neutral";
    if (seg.text.includes("!")) emotion = "energetic";
    else if (seg.text.includes("?")) emotion = "firm";

    const spoken = tempFile(".mp3");
    await speak(translated, voice, spoken, emotion);
    timeline.push(spoken);

    lastEnd = seg.end;
    progressMap.set(
      jobId,
      15 + Math.floor((i / transcription.segments.length) * 55)
    );
  }

  progressMap.set(jobId, 75);
  await concatAudio(timeline, dubbedAudio);

  // BACKGROUND AUDIO PRESERVED
  progressMap.set(jobId, 90);
  await execFileAsync(FFMPEG_PATH, [
    "-i",
    inputPath,
    "-i",
    dubbedAudio,
    "-filter_complex",
    "[0:a]volume=0.15[a0];[1:a]volume=1.0[a1];[a0][a1]amix=inputs=2:dropout_transition=0[aout]",
    "-map",
    "0:v:0",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-shortest",
    outputVideo,
  ]);

  progressMap.set(jobId, 100);
  outputMap.set(jobId, outputVideo);

  safeUnlink(extractedAudio);
  safeUnlink(dubbedAudio);
  timeline.forEach(safeUnlink);
}

// import fs from "fs";
// import OpenAI from "openai";
// import dotenv from "dotenv";
// import { tempFile, safeUnlink } from "../utils/temp";
// import { ffmpegPath, isFfmpegAvailable } from "node-av";
// import { execFile } from "node:child_process";
// import { promisify } from "node:util";
// import { progressMap, outputMap } from "../utils/progress";

// dotenv.config();

// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
// const execFileAsync = promisify(execFile);

// /* ---------- VOICE POOLS ---------- */
// const maleVoices = ["onyx", "nova", "shimmer", "ballad"];
// const femaleVoices = ["alloy", "verse", "fable", "coral"];

// /* ---------- helpers ---------- */
// async function extractAudio(input: string, output: string) {
//   await execFileAsync(ffmpegPath(), [
//     "-i",
//     input,
//     "-map",
//     "a",
//     "-q:a",
//     "0",
//     output,
//   ]);
// }

// async function createSilence(seconds: number, output: string) {
//   if (seconds <= 0) return;
//   await execFileAsync(ffmpegPath(), [
//     "-f",
//     "lavfi",
//     "-i",
//     "anullsrc=r=44100:cl=mono",
//     "-t",
//     seconds.toFixed(2),
//     output,
//   ]);
// }

// async function translate(text: string): Promise<string> {
//   const res = await openai.chat.completions.create({
//     model: "gpt-4o-mini",
//     temperature: 0.2,
//     messages: [
//       {
//         role: "system",
//         content: `
// Translate Chinese to natural spoken English. Preserve timing, emotion, and pauses.
// STRICT RULES:
// - Translate ONLY spoken content
// - NO explanations
// - NO commentary
// - NO AI meta language
// `,
//       },
//       { role: "user", content: text },
//     ],
//   });
//   return res.choices[0].message.content!.trim();
// }

// export async function detectGender(
//   audioFile: string
// ): Promise<"male" | "female"> {
//   try {
//     // Use FFmpeg astats via node-av path
//     const { stderr } = await execFileAsync(ffmpegPath(), [
//       "-i",
//       audioFile,
//       "-af",
//       "astats=metadata=1:reset=1",
//       "-f",
//       "null",
//       "-",
//     ]);

//     const rmsMatches = stderr.match(/RMS level dB: (-?\d+\.?\d+)/g);
//     if (rmsMatches && rmsMatches.length > 0) {
//       const rmsValues = rmsMatches.map((v) =>
//         parseFloat(v.split(":")[1].trim())
//       );
//       const avgRms = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;

//       // updated threshold
//       return avgRms < -12.5 ? "female" : "male";
//     }

//     return "male";
//   } catch (err) {
//     console.error("Gender detection failed, defaulting to male:", err);
//     return "female";
//   }
// }

// function assignVoice(gender: "male" | "female", index: number) {
//   console.log("jkhjkhk", gender);
//   if (gender === "male") {
//     return maleVoices[index % maleVoices.length];
//   } else {
//     return femaleVoices[index % femaleVoices.length];
//   }
// }

// async function speak(
//   text: string,
//   voice: string,
//   output: string,
//   emotion: "soft" | "firm" | "neutral" | "energetic" = "neutral"
// ) {
//   const tonePrompt: Record<string, string> = {
//     soft: "Speak softly and gently.",
//     firm: "Speak clearly with confidence.",
//     energetic: "Speak with lively energy.",
//     neutral: "Speak naturally.",
//   };

//   const speech = await openai.audio.speech.create({
//     model: "gpt-4o-mini-tts",
//     voice,
//     input: `${text}`,
//   });

//   fs.writeFileSync(output, Buffer.from(await speech.arrayBuffer()));
// }

// async function concatAudio(files: string[], output: string) {
//   const list = tempFile(".txt");
//   fs.writeFileSync(list, files.map((f) => `file '${f}'`).join("\n"));

//   await execFileAsync(ffmpegPath(), [
//     "-f",
//     "concat",
//     "-safe",
//     "0",
//     "-i",
//     list,
//     "-c",
//     "copy",
//     output,
//   ]);

//   safeUnlink(list);
// }

// /* ---------- main ---------- */
// export async function dubVideo(inputPath: string, jobId: string) {
//   if (!isFfmpegAvailable()) throw new Error("FFmpeg not available");

//   const extractedAudio = tempFile(".wav");
//   const dubbedAudio = tempFile(".wav");
//   const outputVideo = tempFile(".mp4");

//   progressMap.set(jobId, 5);
//   await extractAudio(inputPath, extractedAudio);

//   progressMap.set(jobId, 15);
//   const transcription: any = await openai.audio.transcriptions.create({
//     file: fs.createReadStream(extractedAudio),
//     model: "whisper-1",
//     language: "zh",
//     response_format: "verbose_json",
//   });

//   const timeline: string[] = [];
//   let lastEnd = 0;

//   // Keep track of speakers and their genders
//   const speakerGender: Record<string, "male" | "female"> = {};
//   const speakerIndex: Record<string, number> = {};

//   for (let i = 0; i < transcription.segments.length; i++) {
//     const seg = transcription.segments[i];

//     // preserve silence
//     const gap = seg.start - lastEnd;
//     if (gap > 0) {
//       const silence = tempFile(".wav");
//       await createSilence(gap, silence);
//       timeline.push(silence);
//     }

//     const translated = await translate(seg.text);

//     // Determine gender
//     let gender: "male" | "female" = "male";
//     const speakerKey = seg.speaker || `segment_${i}`;

//     if (!speakerGender[speakerKey]) {
//       // extract audio for segment only
//       const segmentAudio = tempFile(".wav");
//       await execFileAsync(ffmpegPath(), [
//         "-i",
//         extractedAudio,
//         "-ss",
//         seg.start.toString(),
//         "-to",
//         seg.end.toString(),
//         "-c",
//         "copy",
//         segmentAudio,
//       ]);

//       gender = await detectGender(segmentAudio);
//       speakerGender[speakerKey] = gender;
//       safeUnlink(segmentAudio);
//     } else {
//       gender = speakerGender[speakerKey];
//     }

//     // Voice variation per speaker
//     if (!speakerIndex[speakerKey]) speakerIndex[speakerKey] = 0;
//     const voice = assignVoice(gender, speakerIndex[speakerKey]++);

//     // Emotion heuristic
//     let emotion: "soft" | "firm" | "neutral" | "energetic" = "neutral";
//     if (seg.text.includes("!")) emotion = "energetic";
//     else if (seg.text.includes("?")) emotion = "firm";

//     const spoken = tempFile(".mp3");
//     await speak(translated, voice, spoken, emotion);
//     timeline.push(spoken);

//     lastEnd = seg.end;
//     progressMap.set(
//       jobId,
//       15 + Math.floor((i / transcription.segments.length) * 55)
//     );
//   }

//   progressMap.set(jobId, 75);
//   await concatAudio(timeline, dubbedAudio);

//   // BACKGROUND AUDIO PRESERVED
//   progressMap.set(jobId, 90);
//   await execFileAsync(ffmpegPath(), [
//     "-i",
//     inputPath,
//     "-i",
//     dubbedAudio,
//     "-filter_complex",
//     "[0:a]volume=0.15[a0];[1:a]volume=1.0[a1];[a0][a1]amix=inputs=2:dropout_transition=0[aout]",
//     "-map",
//     "0:v:0",
//     "-map",
//     "[aout]",
//     "-c:v",
//     "copy",
//     "-shortest",
//     outputVideo,
//   ]);

//   progressMap.set(jobId, 100);
//   outputMap.set(jobId, outputVideo);

//   safeUnlink(extractedAudio);
//   safeUnlink(dubbedAudio);
//   timeline.forEach(safeUnlink);
// }
