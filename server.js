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
  model: "gemini-1.5-flash",
  generationConfig: { responseMimeType: "application/json" },
});

app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// GLOBAL SETTINGS
// -----------------------------------------------------------------------------
let GLOBAL_INDEX_ID = null;
const GLOBAL_INDEX_NAME = "VidScore_Pegasus_Engine";

// -----------------------------------------------------------------------------
// 1. CREATE OR REUSE PEGASUS INDEX
// -----------------------------------------------------------------------------
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
          modelName: "pegasus1.2", // ✅ supports generate/analyze
          modelOptions: ["visual", "audio"], // multimodal perception
        },
      ],
      addons: ["thumbnail", "transcription"], // add transcription for dialogue clarity
    });

    GLOBAL_INDEX_ID = created.id;
    console.log(`✅ Created Pegasus index: ${GLOBAL_INDEX_ID}`);
  } catch (err) {
    console.error("❌ Index setup error:", err.message);
  }
};

// initialize on startup
(async () => await getOrCreateGlobalIndex())();

// -----------------------------------------------------------------------------
// 2. AUDIENCE CONTEXT PRESETS
// -----------------------------------------------------------------------------
const getNicheContext = (audience) => {
  const normalized = audience ? audience.toLowerCase() : "general";

  const contexts = {
    "real estate":
      "Needs luxury aesthetic, wide steady shots, clear value proposition, elegant music.",
    fitness:
      "Needs high energy, clear physique/form display, fast pacing, aggressive or upbeat audio.",
    tech: "Needs crisp 4K visuals, clear screen recordings, fast pacing, intelligent script.",
    beauty:
      "Needs perfect lighting (ring light), texture close-ups, before/after hook.",
    business:
      "Needs authority, direct eye contact, controversial or value-heavy hook, zero fluff.",
  };

  for (const [key, value] of Object.entries(contexts)) {
    if (normalized.includes(key)) return value;
  }
  return "Needs high retention, strong visual hook, clear audio, and fast pacing.";
};

// -----------------------------------------------------------------------------
// 3. ANALYZE ENDPOINT
// -----------------------------------------------------------------------------
app.post("/analyze-video", upload.single("video"), async (req, res) => {
  if (!req.file || !GLOBAL_INDEX_ID)
    return res
      .status(400)
      .json({ error: "System not ready or missing video file" });

  const filePath = req.file.path;
  const { audience = "general", platform = "TikTok" } = req.body;

  try {
    console.log(`[1] Uploading to Twelve Labs Pegasus...`);
    const task = await tlClient.tasks.create({
      indexId: GLOBAL_INDEX_ID,
      videoFile: fs.createReadStream(filePath),
    });

    console.log(`[2] Processing task ${task.id}...`);
    let videoId = null;
    for (let i = 0; i < 60; i++) {
      const status = await tlClient.tasks.retrieve(task.id);
      if (status.status === "ready") {
        videoId = status.videoId;
        break;
      }
      if (status.status === "failed")
        throw new Error("Twelve Labs processing failed");
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!videoId) throw new Error("Processing timeout");

    // -------------------------------------------------------------------------
    // STEP A: PEGASUS VIDEO ANALYSIS
    // -------------------------------------------------------------------------
    console.log(`[3] Extracting Visual + Audio Data...`);

    const [summaryResult, gistResult] = await Promise.all([
      tlClient.analyze({
        videoId,
        prompt: `
          Describe this video in technical detail:
          1. Detail the first 3 seconds (visuals + audio).
          2. Describe the pacing (fast, slow, inconsistent).
          3. Evaluate lighting, color grading, and camera stability.
          4. Identify if there's dialogue or narration and its clarity.
          5. Mention background music or sound effects and their tone.
          6. List any visible on-screen text.
        `,
        temperature: 0.1,
      }),
      tlClient.gist({ videoId, types: ["hashtag", "topic"] }),
    ]);

    const videoFacts =
      summaryResult.data || summaryResult.content || summaryResult;
    const detectedHashtags = gistResult.hashtags || gistResult.topics || [];

    // -------------------------------------------------------------------------
    // STEP B: GEMINI SCORING + CRITIQUE
    // -------------------------------------------------------------------------
    console.log(`[4] Sending Pegasus facts to Gemini for scoring...`);

    const nicheContext = getNicheContext(audience);

    const geminiPrompt = `
      You are an expert social media video critic.
      Score this video for performance potential on ${platform}.

      *** VIDEO FACTS (from Pegasus) ***
      ${videoFacts}

      *** TARGET AUDIENCE: ${audience} ***
      ${nicheContext}

      Return JSON only:
      {
        "scores": {
          "overall": (integer 0-100),
          "potential": (integer 0-100),
          "hook": (integer 0-100),
          "retention": (integer 0-100),
          "visuals": (integer 0-100),
          "dialogue": (integer 0-100),
          "audio": (integer 0-100),
          "pacing": (integer 0-100)
        },
        "analysis": {
          "targetAudienceAnalysis": "Analysis string",
          "strengths": ["string"],
          "weaknesses": ["string"],
          "tips": ["string"]
        },
        "metadata": {
          "caption": "string",
          "hashtags": ["string"]
        }
      }
    `;

    const result = await geminiModel.generateContent(geminiPrompt);
    const text = result.response.text();

    const cleanJson = text.replace(/```json|```/g, "").trim();
    const analysisData = JSON.parse(cleanJson);

    if (
      !analysisData.metadata?.hashtags ||
      analysisData.metadata.hashtags.length < 3
    ) {
      analysisData.metadata.hashtags = [
        ...detectedHashtags,
        ...(analysisData.metadata.hashtags || []),
      ].slice(0, 10);
    }

    console.log("✅ Analysis complete.");
    fs.unlink(filePath, () => {});
    res.json(analysisData);
  } catch (err) {
    console.error("❌ Error:", err);
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

app.listen(port, () =>
  console.log(`🚀 Pegasus Looksmaxxing Engine running on port ${port}`)
);
