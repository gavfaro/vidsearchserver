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
  generationConfig: {
    responseMimeType: "application/json",
    temperature: 0.2, // Low temp for analytical consistency
  },
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

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  if (!req.file || !GLOBAL_INDEX_ID) {
    sendEvent("error", { message: "System not ready or missing video file" });
    res.end();
    if (filePath) fs.unlink(filePath, () => {});
    return;
  }

  const { audience = "General Audience", platform = "TikTok" } = req.body;

  try {
    // -------------------------------------------------------------------------
    // STEP 1: INDEXING
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

    for (let i = 0; i < 60; i++) {
      const status = await tlClient.tasks.retrieve(task.id);

      if (status.status === "ready") {
        videoId = status.videoId;
        break;
      }
      if (status.status === "failed")
        throw new Error("Twelve Labs processing failed");

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
    // STEP 2: RAW ANALYSIS
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
            "Analyze the narrative structure. Does the hook fail? Is the middle boring? Describe the pacing.",
          temperature: 0.1,
        }),
        tlClient.analyze({
          videoId,
          prompt:
            "List technical attributes: audio clarity, lighting conditions, camera stability, editing style.",
          temperature: 0.1,
        }),
        tlClient.analyze({
          videoId,
          prompt: `Analyze the visual style for a ${audience} audience.`,
          temperature: 0.1,
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
    // STEP 3: PRE-SCORING
    // -------------------------------------------------------------------------
    sendEvent("progress", {
      message: "Analyzing Audio Mixing...",
      progress: 0.7,
    });

    // REPLACED HARDCODED LOGIC WITH DYNAMIC AI PROMPTING
    const geminiPrompt = `
      You are a VIRAL CONTENT AUDITOR. You are critical and nuanced.
      
      USER CONTEXT:
      - Target Audience Input: "${audience}"
      - Platform: "${platform}"

      === STEP 1: DEFINE THE STANDARD (INTERNAL REASONING) ===
      Based on the specific "Target Audience Input" above, define the visual/audio standard yourself.
      - Example A: If Audience is "Skateboarders", then "Raw/Fish-eye/Lo-fi" is GOOD.
      - Example B: If Audience is "Luxury Watch Collectors", then "Grainy/Dark" is BAD.
      - Example C: If Audience is "Corporate HR", then "Polished/Professional" is MANDATORY.
      
      Establish the standard for "${audience}" on "${platform}" right now.
      
      === STEP 2: ANALYZE RAW DATA ===
      NARRATIVE: ${narrative}
      TECHNICAL: ${technical}
      VISUAL: ${visual}

      === STEP 3: APPLY SCORING ===
      Compare STEP 2 against STEP 1.
      
      PENALTIES:
      1. If the video fails the SPECIFIC standard you established in Step 1, penalize heavily.
      2. If the audio is unintelligible (universal fail), max score 60.
      3. If the hook is boring (universal fail), max score 70.

      Start Score: 50/100.
      
      Return JSON:
      {
        "scores": {
          "overall": "integer (0-100)",
          "potential": "integer (0-100)",
          "hook": "integer (0-100)",
          "retention": "integer (0-100)",
          "visuals": "integer (0-100)",
          "audio": "integer (0-100)",
          "pacing": "integer (0-100)"
        },
        "analysis": {
          "brutal_feedback": "Short, sharp summary. Explicitly mention if the video met the standard for '${audience}'.",
          "strengths": ["list strings"],
          "weaknesses": ["list strings (be specific)"],
          "tips": ["actionable fix"]
        },
        "metadata": {
          "caption": "Viral style caption",
          "hashtags": ["tag1", "tag2"]
        }
      }
    `;

    // -------------------------------------------------------------------------
    // STEP 4: SCORING
    // -------------------------------------------------------------------------
    sendEvent("progress", {
      message: "Calculating Viral Potential...",
      progress: 0.9,
    });

    const result = await geminiModel.generateContent(geminiPrompt);
    const text = result.response.text();
    const cleanJson = text.replace(/```json|```/g, "").trim();

    let analysisData;
    try {
      analysisData = JSON.parse(cleanJson);
    } catch (e) {
      console.error("JSON Parse error", e);
      analysisData = {
        scores: { overall: 50 },
        analysis: { brutal_feedback: "Error parsing AI response." },
      };
    }

    // Merge hashtags
    if (
      !analysisData.metadata?.hashtags ||
      analysisData.metadata.hashtags.length < 3
    ) {
      analysisData.metadata = analysisData.metadata || {};
      analysisData.metadata.hashtags = [
        ...detectedHashtags,
        ...(analysisData.metadata.hashtags || []),
      ].slice(0, 10);
    }

    // -------------------------------------------------------------------------
    // STEP 5: DONE
    // -------------------------------------------------------------------------
    sendEvent("complete", { result: analysisData });
    res.end();

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
  console.log(`🚀 Pegasus Engine (Dynamic Mode) running on port ${port}`)
);
