import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { TwelveLabs } from "twelvelabs-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";

const app = express();
const upload = multer({ dest: "/tmp/" });
const port = process.env.PORT || 3000;

if (!process.env.TWELVE_LABS_API_KEY) {
  console.error("❌ CRITICAL: TWELVE_LABS_API_KEY missing");
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error("❌ CRITICAL: GEMINI_API_KEY missing");
  process.exit(1);
}

const client = new TwelveLabs({ apiKey: process.env.TWELVE_LABS_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const gemini = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

app.use(cors());
app.use(express.json());

let GLOBAL_INDEX_ID = null;
const GLOBAL_INDEX_NAME = "VidScore_Hybrid";

// --- 1. INDEX SETUP ---
const getOrCreateGlobalIndex = async () => {
  const indexes = await client.indexes.list();
  const list = Array.isArray(indexes) ? indexes : indexes?.data || [];
  const existing = list.find((i) => i.indexName === GLOBAL_INDEX_NAME);
  if (existing) {
    GLOBAL_INDEX_ID = existing.id;
    console.log(`✅ Using Index: ${GLOBAL_INDEX_ID}`);
  } else {
    console.log(`🆕 Creating new index...`);
    const newIndex = await client.indexes.create({
      indexName: GLOBAL_INDEX_NAME,
      models: [
        { modelName: "marengo3.0", modelOptions: ["visual", "audio"] },
        { modelName: "pegasus1.2", modelOptions: ["visual", "audio"] },
      ],
      addons: ["thumbnail"],
    });
    GLOBAL_INDEX_ID = newIndex.id;
    console.log(`✅ Created Index: ${GLOBAL_INDEX_ID}`);
  }
};
await getOrCreateGlobalIndex();

// --- 2. GEMINI PROMPT ---
const ANALYSIS_PROMPT = (audience, platform, summary) => `
You are an elite viral strategist for ${platform}, targeting audience: ${audience}.
Below are extracted perceptual insights (clips, timestamps, transcription) from the video:
${JSON.stringify(summary, null, 2)}

Now return ONLY valid JSON (no markdown) matching this structure:
{ "overallScore": (0-100), ... etc. }
Be harsh, specific, and timestamp-based.
`;

// --- 3. MAIN ENDPOINT ---
app.post("/analyze-video", upload.single("video"), async (req, res) => {
  if (!req.file || !GLOBAL_INDEX_ID)
    return res.status(400).json({ error: "Not ready" });

  const filePath = req.file.path;
  const { audience, platform } = req.body;

  try {
    console.log("[1] Uploading...");
    const task = await client.tasks.create({
      indexId: GLOBAL_INDEX_ID,
      videoFile: fs.createReadStream(filePath),
    });

    console.log(`[2] Processing Task: ${task.id}`);
    let attempts = 0;
    let videoId = null;
    let status = null;

    // Poll with safe retries
    while (attempts < 60) {
      status = await client.tasks.retrieve(task.id);
      console.log(`   → Poll ${attempts}: ${status.status}`);
      if (status.status === "ready") {
        videoId = status.videoId;
        break;
      }
      if (status.status === "failed" && attempts < 3) {
        console.log("⚠️ Retrying failed upload once...");
        attempts = 0;
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (status.status === "failed")
        throw new Error("TwelveLabs processing failed");
      await new Promise((r) => setTimeout(r, 2000));
      attempts++;
    }

    if (!videoId) throw new Error("Timeout: video not processed");

    console.log(`[3] Video ready: ${videoId}`);

    // Step 1️⃣: Extract perceptual insights
    const searchResults = await client.search.query({
      indexId: GLOBAL_INDEX_ID,
      queryText:
        "hooks, pacing, transitions, dialogue, emotional tone, main scenes",
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

    const summary = { audience, platform, totalClips: clips.length, clips };

    // Step 2️⃣: Pass to Gemini for reasoning
    console.log(`[4] Sending ${clips.length} clips to Gemini...`);
    const geminiResp = await gemini.generateContent({
      prompt: ANALYSIS_PROMPT(audience, platform, summary),
      temperature: 0.15,
      maxOutputTokens: 1024,
    });

    const raw = geminiResp.response.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error("⚠️ Gemini JSON parse error, returning fallback.");
      parsed = { error: "Invalid JSON", raw };
    }

    fs.unlink(filePath, () => {});
    return res.json({ analysis: parsed, source: "Gemini+TwelveLabs" });
  } catch (error) {
    console.error("❌ Error in /analyze-video:", error);
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () =>
  console.log(`🚀 Hybrid VidScore Engine running on ${port}`)
);
