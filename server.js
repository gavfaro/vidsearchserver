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
    temperature: 0.2,
  },
});

app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// HELPER: RETRY LOGIC (Exponential Backoff)
// -----------------------------------------------------------------------------
// If the API says "429 Too Many Requests" or fails, this waits and retries.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retryApiCall = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (error) {
    if (retries === 0) throw error;

    // Check if it's a rate limit error (usually 429) or a temporary glitch
    const isRateLimit =
      error.response?.status === 429 || error.statusCode === 429;
    const msg = isRateLimit ? "⚠️ Rate Limit Hit" : "⚠️ API Error";

    console.log(`${msg}. Retrying in ${delay}ms...`);
    await sleep(delay);
    return retryApiCall(fn, retries - 1, delay * 2); // Double the delay each time
  }
};

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

  const userAudience = req.body.audience || "General Audience";
  const platform = req.body.platform || "TikTok";

  try {
    // -------------------------------------------------------------------------
    // STEP 1: INDEXING (With Retry)
    // -------------------------------------------------------------------------
    sendEvent("progress", {
      message: "Marengo Vision AI Scanning...",
      progress: 0.3,
    });

    // Wrapping task creation in retry logic just in case
    const task = await retryApiCall(() =>
      tlClient.tasks.create({
        indexId: GLOBAL_INDEX_ID,
        videoFile: fs.createReadStream(filePath),
      })
    );

    let videoId = null;
    let pollProgress = 0.3;

    for (let i = 0; i < 60; i++) {
      const status = await retryApiCall(() => tlClient.tasks.retrieve(task.id));

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
    // STEP 2: CONSOLIDATED RAW ANALYSIS (1 Call = 1 Credit)
    // -------------------------------------------------------------------------
    sendEvent("progress", {
      message: "Measuring Retention Hooks...",
      progress: 0.5,
    });

    // OPTIMIZATION: We combine 4 prompts into 1.
    // This saves 75% of your API usage while getting the same data.
    const consolidatedPrompt = `
      Please provide a comprehensive analysis of this video in four distinct sections:
      
      1. DETECTED AUDIENCE: Who specifically is this video for? (e.g. Gamers, Cooks, etc.)
      2. NARRATIVE ANALYSIS: Analyze the hook, pacing, and story structure.
      3. TECHNICAL ANALYSIS: List any flaws in audio (echo, quiet), lighting (dark, grain), or camera work.
      4. VISUAL STYLE: Describe the aesthetic and color palette.
    `;

    const [pegasusResult, gistResult] = await Promise.all([
      retryApiCall(() =>
        tlClient.analyze({
          videoId,
          prompt: consolidatedPrompt,
          temperature: 0.1,
        })
      ),
      retryApiCall(() =>
        tlClient.gist({ videoId, types: ["hashtag", "topic"] })
      ),
    ]);

    const rawAnalysisText =
      pegasusResult.data || pegasusResult.content || pegasusResult;
    const detectedHashtags = gistResult.hashtags || gistResult.topics || [];

    // -------------------------------------------------------------------------
    // STEP 3: PRE-SCORING
    // -------------------------------------------------------------------------
    sendEvent("progress", {
      message: "Analyzing Audio Mixing...",
      progress: 0.7,
    });

    const geminiPrompt = `
      You are a VIRAL CONTENT AUDITOR. You are critical and nuanced.
      
      === CONTEXT INPUTS ===
      1. USER PROVIDED AUDIENCE: "${userAudience}"
      2. PLATFORM: "${platform}"

      === RAW VIDEO DATA (FROM VISION AI) ===
      "${rawAnalysisText}"

      === INSTRUCTIONS ===
      1. **Extract Context:** Read the "DETECTED AUDIENCE" from the Raw Video Data above.
      2. **Resolve Standard:** - If User Audience is "General", use the AI Detected Audience to set the quality standard.
         - If User Audience is specific, prioritize it.
      3. **Scoring:**
         - Start at 50/100.
         - Penalize if the video fails the specific quality standard for its niche (e.g. Gaming can be raw, Real Estate must be polished).
         - Universal Fail: Unintelligible audio = Max 60. Boring Hook = Max 70.

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
          "brutal_feedback": "Short, sharp summary. Mention if it met the standard for the specific niche.",
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

    // Also wrap Gemini in retry (Google APIs can be flaky under load)
    const result = await retryApiCall(() =>
      geminiModel.generateContent(geminiPrompt)
    );
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
  console.log(`🚀 Pegasus Engine (Efficient Mode) running on port ${port}`)
);
