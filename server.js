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

// Validate Keys
if (!process.env.TWELVE_LABS_API_KEY || !process.env.GEMINI_API_KEY) {
  console.error(
    "❌ CRITICAL: MISSING API KEYS (TWELVE_LABS_API_KEY or GEMINI_API_KEY)"
  );
  process.exit(1);
}

// Initialize Clients
const client = new TwelveLabs({ apiKey: process.env.TWELVE_LABS_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  // Enforce JSON schema for perfect Swift decoding
  generationConfig: { responseMimeType: "application/json" },
});

app.use(cors());
app.use(express.json());

let GLOBAL_INDEX_ID = null;
const GLOBAL_INDEX_NAME = "VidScore_Hybrid_Engine";

// --- 1. SETUP TWELVE LABS INDEX ---
const getOrCreateGlobalIndex = async () => {
  try {
    const indexes = await client.indexes.list();
    const indexList = Array.isArray(indexes) ? indexes : indexes?.data || [];
    const existingIndex = indexList.find(
      (i) => i.indexName === GLOBAL_INDEX_NAME
    );

    if (existingIndex) {
      GLOBAL_INDEX_ID = existingIndex.id;
      console.log(
        `✅ Found existing index: ${GLOBAL_INDEX_NAME} (${GLOBAL_INDEX_ID})`
      );
    } else {
      console.log(`Index ${GLOBAL_INDEX_NAME} not found. Creating new one...`);
      const newIndex = await client.indexes.create({
        indexName: GLOBAL_INDEX_NAME,
        models: [
          {
            modelName: "marengo3.0", // Or 3.0 if available to your key
            modelOptions: ["visual", "audio"],
          },
        ],
        addons: ["thumbnail"],
      });
      GLOBAL_INDEX_ID = newIndex.id;
      console.log(`✅ Created Index: ${GLOBAL_INDEX_ID}`);
    }
  } catch (error) {
    console.error("Index Error:", error.message);
  }
};

(async () => {
  await getOrCreateGlobalIndex();
})();

// --- 2. NICHE RULES (Passed to Gemini) ---
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

// --- 3. THE HYBRID PIPELINE ---
app.post("/analyze-video", upload.single("video"), async (req, res) => {
  if (!req.file || !GLOBAL_INDEX_ID)
    return res.status(400).json({ error: "System not ready" });

  const filePath = req.file.path;
  const { audience, platform } = req.body;

  try {
    console.log(`[1] Uploading to Twelve Labs (The Eyes)...`);
    const task = await client.tasks.create({
      indexId: GLOBAL_INDEX_ID,
      videoFile: fs.createReadStream(filePath),
    });

    console.log(`[2] Processing Task: ${task.id}`);

    // Poll for completion
    let videoId = null;
    let attempts = 0;
    while (attempts < 60) {
      const status = await client.tasks.retrieve(task.id);
      if (status.status === "ready") {
        videoId = status.videoId;
        break;
      }
      if (status.status === "failed")
        throw new Error("Twelve Labs Processing Failed");
      await new Promise((r) => setTimeout(r, 2000));
      attempts++;
    }

    if (!videoId) throw new Error("Processing Timeout");

    // --- STEP A: TWELVE LABS EXTRACTION (THE PERCEPTION LAYER) ---
    console.log(`[3] Extracting Visual Data...`);

    // We explicitly ask Twelve Labs to separate Dialogue from Background Audio in its description
    const [summaryResult, gistResult] = await Promise.all([
      client.generate.text({
        videoId: videoId,
        prompt: `
          Analyze this video for a professional critique.
          1. Describe the FIRST 3 SECONDS in detail (Visuals + Audio).
          2. Describe the Audio Mixing: Is there spoken dialogue? Is it clear? Is there background music?
          3. Describe the Pacing: Is it fast, slow, or inconsistent?
          4. Describe the Visuals: Lighting quality, camera stability, color grading.
          5. Transcribe any on-screen text.
        `,
        temperature: 0.1,
      }),
      client.gist({
        videoId: videoId,
        types: ["hashtag", "topic"],
      }),
    ]);

    const videoFacts = summaryResult.data || summaryResult.content;
    const detectedHashtags = gistResult.hashtags || [];

    // --- STEP B: GEMINI ANALYSIS (THE LOOKSMAXXING BRAIN) ---
    console.log(`[4] Sending Facts to Gemini (The Brain)...`);

    const nicheContext = getNicheContext(audience);

    const geminiPrompt = `
      You are a specialized AI designed to "Looksmax" social media videos. 
      Your job is to provide a brutal, stat-heavy breakdown of this video's performance potential for ${platform}.
      
      *** THE VIDEO FACTS (Perceived by Vision AI) ***
      ${videoFacts}
      ***********************************************

      *** TARGET AUDIENCE STANDARDS: ${audience} ***
      ${nicheContext}
      **********************************************

      Your Goal: Grade this video like a character stat sheet.
      
      SCORING CRITERIA:
      - "potential": Your prediction of its virality (0-100).
      - "hook": How effectively it stops scrolling in sec 0-3.
      - "retention": Pacing score. Does it get boring?
      - "dialogue": Clarity, delivery, and script quality (0 if no speech).
      - "audio": Background music, SFX, and mixing quality (non-dialogue).
      - "visuals": Aesthetic quality, lighting, and composition.

      FEEDBACK SECTIONS:
      - "strengths": What did they do right? (The "Halo Effect" qualities).
      - "weaknesses": What is lowering their score? (The "Flaws").
      - "tips": Actionable steps to "looksmax" this video (e.g., "Increase saturation", "Cut the pause at 0:04").

      RETURN RAW JSON ONLY (No Markdown):
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
          "targetAudienceAnalysis": "Specific analysis of how well this fits the ${audience} niche.",
          "strengths": ["Strength 1", "Strength 2"],
          "weaknesses": ["Weakness 1", "Weakness 2"],
          "tips": ["Tip 1", "Tip 2", "Tip 3"]
        },
        "metadata": {
          "caption": "A viral-optimized caption suggestion",
          "hashtags": ["tag1", "tag2"]
        }
      }
    `;

    const result = await geminiModel.generateContent(geminiPrompt);
    const response = await result.response;
    const text = response.text();

    const cleanJson = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const analysisData = JSON.parse(cleanJson);

    // Merge Hashtags
    if (
      !analysisData.metadata.hashtags ||
      analysisData.metadata.hashtags.length < 3
    ) {
      analysisData.metadata.hashtags = [
        ...detectedHashtags,
        ...(analysisData.metadata.hashtags || []),
      ].slice(0, 10);
    }

    console.log("✅ Analysis Complete");

    // Cleanup
    fs.unlink(filePath, () => {});

    res.json(analysisData);
  } catch (error) {
    console.error("❌ Error:", error);
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

app.listen(port, () =>
  console.log(`🚀 VidScore Looksmaxxing Engine on ${port}`)
);
