require("dotenv").config();
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { TwelveLabs } from "twelvelabs-js";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const upload = multer({ dest: "/tmp/" });
const port = process.env.PORT || 3000;

// Setup clients
if (!process.env.TWELVE_LABS_API_KEY) {
  console.error("❌ CRITICAL: TWELVE_LABS API KEY MISSING");
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error("❌ CRITICAL: GEMINI API KEY MISSING");
  process.exit(1);
}

const tlClient = new TwelveLabs({ apiKey: process.env.TWELVE_LABS_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

app.use(cors());
app.use(express.json());

let GLOBAL_INDEX_ID = null;
const GLOBAL_INDEX_NAME = "Hybrid_VidScore_Index";

async function getOrCreateIndex() {
  const indexes = await tlClient.indexes.list();
  const list = Array.isArray(indexes) ? indexes : indexes?.data || [];
  const existing = list.find((i) => i.indexName === GLOBAL_INDEX_NAME);

  if (existing) {
    GLOBAL_INDEX_ID = existing.id;
    console.log("✅ Using existing index:", GLOBAL_INDEX_ID);
  } else {
    console.log("🔧 Creating new index (TwelveLabs)...");
    const newIndex = await tlClient.indexes.create({
      indexName: GLOBAL_INDEX_NAME,
      models: [
        { modelName: "marengo3.0", modelOptions: ["visual", "audio"] },
        { modelName: "pegasus1.2", modelOptions: ["visual", "audio"] },
      ],
      addons: ["thumbnail"],
    });
    GLOBAL_INDEX_ID = newIndex.id;
    console.log("✅ Created index:", GLOBAL_INDEX_ID);
  }
}

getOrCreateIndex().catch((e) => {
  console.error("Index init error", e);
  process.exit(1);
});

app.post("/analyze-video", upload.single("video"), async (req, res) => {
  if (!req.file || !GLOBAL_INDEX_ID) {
    return res.status(400).json({ error: "Bad request or index not ready" });
  }

  const filePath = req.file.path;
  const { audience, platform } = req.body;

  try {
    // 1) Upload to TwelveLabs
    const task = await tlClient.tasks.create({
      indexId: GLOBAL_INDEX_ID,
      videoFile: fs.createReadStream(filePath),
    });

    // Poll until ready
    let attempts = 0,
      videoId = null;
    while (attempts < 60) {
      const status = await tlClient.tasks.retrieve(task.id);
      if (status.status === "ready") {
        videoId = status.videoId;
        break;
      }
      if (status.status === "failed") {
        throw new Error("TwelveLabs processing failed");
      }
      await new Promise((r) => setTimeout(r, 2000));
      attempts++;
    }
    if (!videoId) throw new Error("TwelveLabs processing timeout");

    // 2) Search/extract clip-level/perceptual data (visual/aud/audio/transcription)
    const searchResults = await tlClient.search.query({
      indexId: GLOBAL_INDEX_ID,
      queryText:
        "hook, main content, transitions, audio quality, dialogue, visual elements",
      searchOptions: ["visual", "audio", "transcription"],
    });

    const clips = [];
    for await (const clip of searchResults) {
      clips.push({
        start: clip.start,
        end: clip.end,
        score: clip.score,
        transcription: clip.transcription || "",
      });
    }

    // 3) Build a simplified summary payload for Gemini
    const summary = {
      videoId,
      clips,
      metadata: {
        audience,
        platform,
        totalClips: clips.length,
      },
    };

    // 4) Craft prompt for Gemini — use your detailed ANALYSIS_PROMPT + embed the summary
    const prompt = `
You are an elite viral content strategist specializing in ${platform} with expertise in audience: ${audience}.
Below is the perceptual summary of a video extracted via a vision/audio/transcription tool:

${JSON.stringify(summary, null, 2)}

Using this data, produce ONLY valid JSON (no markdown, no code blocks) with the following structure:

{
  "overallScore": (0-100, harsh realistic),
  "viralityScore": (0-10),
  "hookScore": (0-10),
  "retentionScore": (0-10),
  "engagementScore": (0-10),
  "audioScore": (0-10),
  "dialogueScore": (0-10) or null,
  "predictedMetrics": { ... },
  "hookAnalysis": { ... },
  "retentionKillers": [ ... ],
  "strengths": [ ... ],
  "criticalIssues": [ ... ],
  "actionableFixes": [ ... ],
  "audioAnalysis": { ... },
  "dialogueAnalysis": { ... } or null,
  "audienceAlignment": { ... },
  "algorithmOptimization": { ... },
  "competitorComparison": { ... },
  "captionSuggestion": "...",
  "hashtagStrategy": [ ... ],
  "postingStrategy": { ... },
  "viralPotential": "Low"|"Medium"|"High"|"Viral-Ready",
  "confidenceLevel": (0-100)
}
`;

    const geminiResp = await geminiModel.generateContent({
      prompt: prompt,
      temperature: 0.1,
      maxOutputTokens: 1024,
    });

    const aiText = geminiResp.response.text();
    let analysisData;
    try {
      analysisData = JSON.parse(aiText);
    } catch (e) {
      console.error("❌ Gemini JSON parse error:", e, aiText);
      return res
        .status(500)
        .json({ error: "Gemini JSON parse error", raw: aiText });
    }

    // 5) Clean up uploaded file
    fs.unlink(filePath, () => {});

    // 6) Return result
    return res.json({ tlSummary: summary, analysis: analysisData });
  } catch (error) {
    console.error("❌ Error in /analyze-video:", error);
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    return res.status(500).json({ error: error.message });
  }
});

app.listen(port, () =>
  console.log(`🚀 Hybrid Video Analyzer running on port ${port}`)
);
