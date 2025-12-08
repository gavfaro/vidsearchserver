import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { TwelveLabs } from "twelvelabs-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import "dotenv/config";

const app = express();
const upload = multer({ dest: "/tmp/" });
const port = process.env.PORT || 3000;

// -----------------------------------------------------------------------------
// ENVIRONMENT VALIDATION
// -----------------------------------------------------------------------------
if (!process.env.TWELVE_LABS_API_KEY || !process.env.GEMINI_API_KEY) {
  console.error("❌ Missing TWELVE_LABS_API_KEY or GEMINI_API_KEY");
  process.exit(1);
}

// -----------------------------------------------------------------------------
// CLIENT INITIALIZATION
// -----------------------------------------------------------------------------
const tlClient = new TwelveLabs({ apiKey: process.env.TWELVE_LABS_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
});

// -----------------------------------------------------------------------------
// RETRY HELPER
// -----------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retryApiCall = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (error) {
    if (retries === 0) throw error;
    const isRateLimit =
      error.response?.status === 429 || error.statusCode === 429;
    console.log(
      `${
        isRateLimit ? "⚠️ Rate Limit Hit" : "⚠️ API Error"
      }: Retrying in ${delay}ms...`
    );
    await sleep(delay);
    return retryApiCall(fn, retries - 1, delay * 2);
  }
};

// -----------------------------------------------------------------------------
// GLOBAL INDEX SETUP
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
      models: [{ modelName: "pegasus1.2", modelOptions: ["visual", "audio"] }],
      addons: ["thumbnail"],
    });

    GLOBAL_INDEX_ID = created.id;
    console.log(`✅ Created Pegasus index: ${GLOBAL_INDEX_ID}`);
  } catch (err) {
    console.error("❌ Index setup error:", err.message);
  }
};

(async () => await getOrCreateGlobalIndex())();

app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// ZOD SCHEMA FOR JSON VALIDATION
// -----------------------------------------------------------------------------
const analysisSchema = z.object({
  scores: z.object({
    overall: z.number().min(0).max(100),
    potential: z.number().min(0).max(100),
    hook: z.number().min(0).max(100),
    retention: z.number().min(0).max(100),
    visuals: z.number().min(0).max(100),
    audio: z.number().min(0).max(100),
    pacing: z.number().min(0).max(100),
    dialogue: z.number().min(0).max(100),
  }),
  analysis: z.object({
    targetAudienceAnalysis: z.string(),
    strengths: z.array(z.string()),
    weaknesses: z.array(z.string()),
    tips: z.array(z.string()),
  }),
  metadata: z.object({
    caption: z.string(),
    hashtags: z.array(z.string()),
  }),
});

// -----------------------------------------------------------------------------
// /analyze-video ENDPOINT
// -----------------------------------------------------------------------------
app.post("/analyze-video", upload.single("video"), async (req, res) => {
  const filePath = req.file?.path;

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
    // STEP 1: Indexing
    sendEvent("progress", {
      message: "Marengo Vision AI Scanning...",
      progress: 0.3,
    });
    const task = await retryApiCall(() =>
      tlClient.tasks.create({
        indexId: GLOBAL_INDEX_ID,
        videoFile: fs.createReadStream(filePath),
      })
    );

    let videoId = null;
    for (let i = 0; i < 60; i++) {
      const status = await retryApiCall(() => tlClient.tasks.retrieve(task.id));
      if (status.status === "ready") {
        videoId = status.videoId;
        break;
      }
      if (status.status === "failed")
        throw new Error("Twelve Labs processing failed");
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!videoId) throw new Error("Processing timeout");

    // STEP 2: Deep Analysis Prompt (Enhanced with Audience & Engagement Signals)
    sendEvent("progress", {
      message: "Extracting Creative DNA...",
      progress: 0.5,
    });

    const deepPegasusPrompt = `
      Perform an expert-level creative audit of the video. Divide your response into four sections:

      1. **TARGET AUDIENCE DETECTION**
         - Specify age, interests, and platform behavior.
         - Include example creators or channels.
         - Indicate production tolerance (what flaws they forgive or expect).

      2. **NARRATIVE STRUCTURE AND RETENTION**
         - Break into beats (hook, escalation, climax, resolution, CTA).
         - Highlight engagement peaks and potential drop-off points.
         - Evaluate emotional pacing and visual-dialogue alignment.

      3. **CINEMATIC AND TECHNICAL CRAFT**
         - Evaluate framing, color, motion stability, lighting, editing rhythm.
         - Diagnose causal issues (e.g., “slow pan reduces momentum”).
         - Identify moments where production aids or hurts retention.

      4. **VISUAL STYLE AND BRAND COHERENCE**
         - Assess grading, palette, typography, and on-screen design.
         - Relate to platform norms (TikTok, YouTube Shorts, etc.).
         - Highlight stylistic references or mismatches.

      5. **ENGAGEMENT SIGNALS**
         - Indicate when attention is likely to peak or drop.
         - Include visual, auditory, or narrative cues impacting retention.

      Use precise, diagnostic language. Avoid generic praise.
    `;

    const [pegasusResult, gistResult] = await Promise.all([
      retryApiCall(() =>
        tlClient.analyze({
          videoId,
          prompt: deepPegasusPrompt,
          temperature: 0.1,
        })
      ),
      retryApiCall(() =>
        tlClient.gist({ videoId, types: ["hashtag", "topic"] })
      ),
    ]);

    // STEP 3: Sanitize Raw Output
    const rawAnalysisText =
      pegasusResult.data || pegasusResult.content || pegasusResult;
    const sanitizedRaw = rawAnalysisText
      .replace(/audience.*?:.*?(general audience|unspecified)/gi, "")
      .replace(/parameters?:.*?\n/gi, "")
      .replace(/\b(context|system|prompt).*?:.*?\n/gi, "")
      .trim();

    const detectedHashtags = gistResult.hashtags || gistResult.topics || [];

    // STEP 4: Context-Aware Scoring
    sendEvent("progress", {
      message: "Calculating Viral Potential...",
      progress: 0.8,
    });

    const geminiPrompt = `
      You are a seasoned creative director and viral content auditor.

      === CONTEXT INPUTS ===
      1. USER PROVIDED AUDIENCE: "${userAudience}"
      2. PLATFORM: "${platform}"

      === RAW VIDEO DATA ===
      "${sanitizedRaw}"

      === CONTEXT WEIGHTING RULES ===
      - Use the detected or user-specified audience to determine scoring tolerance.
      - Raw/authentic niches: minor camera/audio flaws are forgiven.
      - Aspirational niches: production flaws penalized more heavily.
      - Prioritize engagement and retention over pure technical polish.
      - Excellent quality but low engagement = limited viral potential.
      - Poor quality but high authenticity/story = strong engagement potential.

      === TASK ===
      Score each dimension and explain *why*. Identify visual, auditory, or narrative causes of strengths and weaknesses.
      Avoid vague statements. Return valid JSON:
      {
        "scores": { "overall": int, "potential": int, "hook": int, "retention": int, "visuals": int, "audio": int, "pacing": int, "dialogue": int },
        "analysis": { "targetAudienceAnalysis": string, "strengths": [string], "weaknesses": [string], "tips": [string] },
        "metadata": { "caption": string, "hashtags": [string] }
      }
    `;

    const geminiResponse = await retryApiCall(() =>
      geminiModel.generateContent(geminiPrompt)
    );
    let analysisData;
    try {
      const jsonText = geminiResponse.response
        .text()
        .replace(/```json|```/g, "")
        .trim();
      analysisData = analysisSchema.parse(JSON.parse(jsonText));
    } catch (err) {
      console.error("⚠️ Gemini JSON Parse Error:", err.message);
      analysisData = {
        scores: { overall: 50 },
        analysis: {
          targetAudienceAnalysis: "Error parsing AI output",
          strengths: [],
          weaknesses: [],
          tips: [],
        },
        metadata: { caption: "", hashtags: [] },
      };
    }

    if (!analysisData.metadata.hashtags.length) {
      analysisData.metadata.hashtags = detectedHashtags.slice(0, 10);
    }

    // STEP 5: Optional Refinement Pass
    sendEvent("progress", {
      message: "Refining Creative Insights...",
      progress: 0.9,
    });

    const refinementPrompt = `
      You are a creative strategist. Deepen the analysis below by expanding on the specific decisions that shape retention, emotion, and style.
      Avoid repetition. Keep JSON structure identical.
      ${JSON.stringify(analysisData)}
    `;

    try {
      const refinedResponse = await retryApiCall(() =>
        geminiModel.generateContent(refinementPrompt)
      );
      const refinedJson = refinedResponse.response
        .text()
        .replace(/```json|```/g, "")
        .trim();
      analysisData = analysisSchema.parse(JSON.parse(refinedJson));
    } catch (e) {
      console.log("Refinement skipped due to JSON issues.");
    }

    // STEP 6: Complete
    sendEvent("complete", { result: analysisData });
    res.end();

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
  console.log(
    `🚀 Pegasus Engine (Audience-Aware Enhanced Mode) running on port ${port}`
  )
);
