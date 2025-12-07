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
      addons: ["thumbnail"], // add transcription for dialogue clarity
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
    // STEP A: MULTI-LAYERED PEGASUS ANALYSIS
    // -------------------------------------------------------------------------
    console.log(`[3] Deep analysis with Pegasus...`);

    const [narrativeAnalysis, technicalAnalysis, visualAnalysis, gistResult] =
      await Promise.all([
        // First pass: understand the STORY and INTENT
        tlClient.analyze({
          videoId,
          prompt: `
          Analyze this video's narrative and intent:
          - What is the creator trying to communicate or sell?
          - What emotions are they targeting (urgency, curiosity, desire, FOMO)?
          - Describe the hook/opening (first 3 seconds) - what grabs attention?
          - How does the video progress? Does it build tension or lose momentum?
          - Is there a clear call-to-action or payoff?
          - What style is this (educational, entertaining, promotional, storytelling)?
        `,
          temperature: 0.2,
        }),
        // Second pass: technical execution
        tlClient.analyze({
          videoId,
          prompt: `
          Analyze technical execution:
          - Audio quality: Is dialogue clear? Background music volume? Any distortion?
          - Visual quality: Resolution, lighting (natural/artificial/harsh/soft), color grading
          - Camera work: Stability, movement, angles, framing
          - Editing: Cut frequency, transitions, text overlays, effects
          - Pacing: Seconds per scene, does it feel rushed/dragging/natural?
          - On-screen elements: Text, graphics, faces, products shown
        `,
          temperature: 0.1,
        }),
        // Third pass: visual storytelling and aesthetics
        tlClient.analyze({
          videoId,
          prompt: `
          Analyze visual storytelling and aesthetic choices:
          - What's the dominant color palette? Does it create a specific mood or brand feel?
          - Describe the setting/environment. Does it look professional or amateur?
          - Are there visual patterns or repetitive setups (same angle, static vs dynamic)?
          - How many distinct scenes or visual moments? Does each serve a purpose?
          - What's the most visually striking or memorable moment?
          - Any visual hooks (product reveals, transformations, before/after, unexpected elements)?
          - Are faces visible and expressive, or is it B-roll focused?
          - Does the overall aesthetic match ${audience} content expectations?
          - Any visual distractions or cluttered elements?
        `,
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
    // STEP B: CONTEXTUAL GEMINI SCORING
    // -------------------------------------------------------------------------
    console.log(`[4] Contextual scoring with Gemini...`);

    const nicheContext = getNicheContext(audience);

    const geminiPrompt = `
      You are a ${audience} content expert and social media strategist.
      Analyze this ${platform} video for viral potential and audience fit.

      === NARRATIVE & INTENT ===
      ${narrative}

      === TECHNICAL EXECUTION ===
      ${technical}

      === VISUAL STORYTELLING ===
      ${visual}

      === TARGET AUDIENCE: ${audience} ===
      ${nicheContext}

      YOUR TASK:
      1. First, understand what this video is actually trying to do. Don't force it into a template.
      2. Evaluate if it will resonate with ${audience} specifically (not just "general audience").
      3. Consider how the VISUALS support (or undermine) the message and niche expectations.
      4. Score honestly - a weak hook is 20/100, not 60/100. Exceptional gets 90+.
      5. Give actionable critique that shows you understand the content, not generic advice.

      Return JSON with this structure (but adapt your analysis to the actual content):
      {
        "scores": {
          "overall": (0-100, weighted average reflecting true performance potential),
          "potential": (0-100, ceiling if flaws are fixed),
          "hook": (0-100, does the first 3s stop scrolling?),
          "retention": (0-100, does pacing maintain attention?),
          "visuals": (0-100, quality + aesthetic fit for niche),
          "dialogue": (0-100, clarity + persuasiveness if applicable, or N/A),
          "audio": (0-100, music/sound quality + emotional impact),
          "pacing": (0-100, scene cuts + momentum)
        },
        "analysis": {
          "targetAudienceAnalysis": "Deep analysis: Does this authentically speak to ${audience}? What do they care about that this hits/misses?",
          "strengths": ["Specific observations about what works, referencing actual content"],
          "weaknesses": ["Honest critique with examples from the video"],
          "tips": ["Concrete improvements tied to the content, not generic 'add music' advice"]
        },
        "metadata": {
          "caption": "Compelling caption that matches the video's actual content and style",
          "hashtags": ["relevant", "to", "actual", "content"]
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

    // -------------------------------------------------------------------------
    // CLEANUP: Delete video from index to avoid storage costs
    // -------------------------------------------------------------------------
    try {
      await tlClient.indexes.videos.delete(GLOBAL_INDEX_ID, videoId);
      console.log(`🗑️ Deleted video ${videoId} from index (no storage cost)`);
    } catch (cleanupErr) {
      console.warn("⚠️ Failed to delete video from index:", cleanupErr.message);
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
