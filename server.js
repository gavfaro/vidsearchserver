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

// Validate API Keys
if (!process.env.TWELVE_LABS_API_KEY || !process.env.GEMINI_API_KEY) {
  console.error("❌ CRITICAL: Missing TWELVE_LABS_API_KEY or GEMINI_API_KEY");
  process.exit(1);
}

// Initialize Clients
const tlClient = new TwelveLabs({ apiKey: process.env.TWELVE_LABS_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { responseMimeType: "application/json" },
});

app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// GLOBAL SETTINGS
// -----------------------------------------------------------------------------
let GLOBAL_INDEX_ID = null;
const GLOBAL_INDEX_NAME = "VidScore_Pegasus_Engine";

const getOrCreateGlobalIndex = async () => {
  try {
    const indexes = await tlClient.indexes.list();
    const list = Array.isArray(indexes) ? indexes : indexes?.data || [];
    const existing = list.find((i) => i.indexName === GLOBAL_INDEX_NAME);

    if (existing) {
      GLOBAL_INDEX_ID = existing.id;
      console.log(
        `✅ Found Pegasus index: ${GLOBAL_INDEX_NAME} (${GLOBAL_INDEX_ID})`
      );
      return;
    }

    console.log(`Creating Pegasus index: ${GLOBAL_INDEX_NAME} ...`);
    const created = await tlClient.indexes.create({
      indexName: GLOBAL_INDEX_NAME,
      models: [
        {
          modelName: "pegasus1.2",
          modelOptions: ["visual", "audio"],
        },
      ],
      addons: ["thumbnail"],
    });

    GLOBAL_INDEX_ID = created.id;
    console.log(`✅ Created Pegasus index: ${GLOBAL_INDEX_ID}`);
  } catch (err) {
    console.error("❌ Index setup error:", err.message);
  }
};

(async () => await getOrCreateGlobalIndex())();

const getNicheContext = (audience) => {
  const normalized = audience ? audience.toLowerCase() : "general";
  if (normalized.includes("real estate"))
    return "Needs luxury aesthetic, wide steady shots, clear value proposition, elegant music.";
  if (normalized.includes("fitness"))
    return "Needs high energy, clear physique/form display, fast pacing, aggressive or upbeat audio.";
  if (normalized.includes("tech"))
    return "Needs crisp 4K visuals, clear screen recordings, fast pacing, intelligent script.";
  if (normalized.includes("beauty"))
    return "Needs perfect lighting, texture close-ups, before/after hook.";
  if (normalized.includes("business"))
    return "Needs authority, direct eye contact, value-heavy hook, zero fluff.";
  return "Needs high retention, strong visual hook, clear audio, and fast pacing.";
};

// -----------------------------------------------------------------------------
// 3. STREAMING ANALYZE ENDPOINT
// -----------------------------------------------------------------------------
app.post("/analyze-video", upload.single("video"), async (req, res) => {
  const filePath = req.file?.path;

  // 1. Setup SSE Headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Helper to send events
  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  if (!req.file || !GLOBAL_INDEX_ID) {
    sendEvent("error", { message: "System not ready or missing video file" });
    res.end();
    if (filePath) fs.unlink(filePath, () => {});
    return;
  }

  const { audience = "general", platform = "TikTok" } = req.body;

  try {
    // -------------------------------------------------------------------------
    // STEP 1: INDEXING (Map to "Marengo Vision AI Scanning...") - 0.3
    // -------------------------------------------------------------------------
    sendEvent("progress", {
      message: "Marengo Vision AI Scanning...",
      progress: 0.3,
    });

    const task = await tlClient.tasks.create({
      indexId: GLOBAL_INDEX_ID,
      videoFile: fs.createReadStream(filePath),
    });

    let videoId = null;
    let pollProgress = 0.3;

    // Poll for indexing completion
    for (let i = 0; i < 60; i++) {
      const status = await tlClient.tasks.retrieve(task.id);

      if (status.status === "ready") {
        videoId = status.videoId;
        break;
      }
      if (status.status === "failed")
        throw new Error("Twelve Labs processing failed");

      // Gently nudge progress bar while waiting so it feels alive
      if (pollProgress < 0.45) {
        pollProgress += 0.01;
        sendEvent("progress", {
          message: "Marengo Vision AI Scanning...",
          progress: pollProgress,
        });
      }

      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!videoId) throw new Error("Processing timeout");

    // -------------------------------------------------------------------------
    // STEP 2: RAW ANALYSIS (Map to "Measuring Retention Hooks...") - 0.5
    // -------------------------------------------------------------------------
    sendEvent("progress", {
      message: "Measuring Retention Hooks...",
      progress: 0.5,
    });

    const [narrativeAnalysis, technicalAnalysis, visualAnalysis, gistResult] =
      await Promise.all([
        tlClient.analyze({
          videoId,
          prompt:
            "Analyze narrative, intent, emotions, hook effectiveness, and progression.",
          temperature: 0.2,
        }),
        tlClient.analyze({
          videoId,
          prompt:
            "Analyze technical execution: audio quality, lighting, camera work, editing pacing.",
          temperature: 0.1,
        }),
        tlClient.analyze({
          videoId,
          prompt: `Analyze visual storytelling for ${audience} audience. Color palette, setting, visual hooks.`,
          temperature: 0.2,
        }),
        tlClient.gist({ videoId, types: ["hashtag", "topic"] }),
      ]);

    const narrative =
      narrativeAnalysis.data || narrativeAnalysis.content || narrativeAnalysis;
    const technical =
      technicalAnalysis.data || technicalAnalysis.content || technicalAnalysis;
    const visual =
      visualAnalysis.data || visualAnalysis.content || visualAnalysis;
    const detectedHashtags = gistResult.hashtags || gistResult.topics || [];

    // -------------------------------------------------------------------------
    // STEP 3: PRE-SCORING (Map to "Analyzing Audio Mixing...") - 0.7
    // -------------------------------------------------------------------------
    // We have the data, just about to send to Gemini. Perfect time for this step.
    sendEvent("progress", {
      message: "Analyzing Audio Mixing...",
      progress: 0.7,
    });

    const nicheContext = getNicheContext(audience);
    const geminiPrompt = `
      You are a ${audience} content expert. Analyze this ${platform} video.
      
      === NARRATIVE ===
      ${narrative}
      === TECHNICAL ===
      ${technical}
      === VISUAL ===
      ${visual}
      === CONTEXT ===
      ${nicheContext}

      CRITICAL SCORING INSTRUCTIONS:
      - All scores MUST be integers between 0 and 100.

      Return JSON with: scores (overall, potential, hook, retention, visuals, dialogue, audio, pacing), analysis (targetAudienceAnalysis, strengths, weaknesses, tips), metadata (caption, hashtags).
    `;

    // -------------------------------------------------------------------------
    // STEP 4: SCORING (Map to "Calculating Viral Potential...") - 0.9
    // -------------------------------------------------------------------------
    sendEvent("progress", {
      message: "Calculating Viral Potential...",
      progress: 0.9,
    });

    const result = await geminiModel.generateContent(geminiPrompt);
    const text = result.response.text();
    const cleanJson = text.replace(/```json|```/g, "").trim();
    const analysisData = JSON.parse(cleanJson);

    // Merge hashtags
    if (
      !analysisData.metadata?.hashtags ||
      analysisData.metadata.hashtags.length < 3
    ) {
      analysisData.metadata.hashtags = [
        ...detectedHashtags,
        ...(analysisData.metadata.hashtags || []),
      ].slice(0, 10);
    }

    // -------------------------------------------------------------------------
    // STEP 5: DONE
    // -------------------------------------------------------------------------
    sendEvent("complete", { result: analysisData });
    res.end(); // Close stream

    // Cleanup
    try {
      await tlClient.indexes.videos.delete(GLOBAL_INDEX_ID, videoId);
    } catch (e) {}
    fs.unlink(filePath, () => {});
  } catch (err) {
    console.error("❌ Error:", err);
    sendEvent("error", { message: err.message || "Analysis failed" });
    res.end();
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
  }
});

app.listen(port, () =>
  console.log(`🚀 Pegasus Engine (Streaming Mode) running on port ${port}`)
);
