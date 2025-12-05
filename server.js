import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { TwelveLabs } from "twelvelabs-js";
import "dotenv/config";

const app = express();
const upload = multer({ dest: "/tmp/" });
const port = process.env.PORT || 3000;

if (!process.env.TWELVE_LABS_API_KEY) {
  console.error("❌ CRITICAL: API KEY MISSING");
  process.exit(1);
}

const client = new TwelveLabs({ apiKey: process.env.TWELVE_LABS_API_KEY });
app.use(cors());
app.use(express.json());

let GLOBAL_INDEX_ID = null;
const GLOBAL_INDEX_NAME = "VidScore_Analysis";

// --- 1. SETUP INDEX ---
const getOrCreateGlobalIndex = async () => {
  try {
    const indexes = await client.indexes.list();
    const indexList = Array.isArray(indexes) ? indexes : indexes?.data || [];
    const existingIndex = indexList.find(
      (i) => i.indexName === GLOBAL_INDEX_NAME
    );

    if (existingIndex) {
      GLOBAL_INDEX_ID = existingIndex.id;
      console.log(`✅ Using Index: ${GLOBAL_INDEX_ID}`);
    } else {
      console.log(`Creating new index...`);
      const newIndex = await client.indexes.create({
        indexName: GLOBAL_INDEX_NAME,
        models: [
          // FIX: Removed "text" from modelOptions as it caused a BadRequestError
          { modelName: "marengo2.7", modelOptions: ["visual", "audio"] },
          { modelName: "pegasus1.2", modelOptions: ["visual", "audio"] },
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

// --- 2. THE MEGA PROMPT ---
// This instructs the AI to return strictly formatted JSON data
const ANALYSIS_PROMPT = (audience, platform) => `
You are a viral video consultant for ${platform}. The target audience is: ${audience}.
Analyze this video strictly. Do not be nice. Be accurate.

Return a valid JSON object (no markdown, no code blocks, just raw JSON) with this exact structure:
{
  "overallScore": (number 0-100),
  "hookScore": (number 0-10),
  "visualScore": (number 0-10),
  "audioScore": (number 0-10),
  "audienceMatchScore": (number 0-10),
  "predictedRetention": [ (array of 6 numbers from 100 down to X representing viewer % at 0s, 5s, 10s, 15s, 20s, 25s+) ],
  "hookAnalysis": {
    "status": "Weak" or "Strong",
    "timestamp": "0:03",
    "feedback": "string explaining the hook issue or strength"
  },
  "criticalIssues": [
    "string 1 (major issue)",
    "string 2 (major issue)"
  ],
  "actionableFixes": [
    "string 1 (specific edit to make)",
    "string 2 (specific edit to make)"
  ],
  "captionSuggestion": "A viral style caption",
  "viralPotential": "Low", "Medium", or "High"
}
`;

app.post("/analyze-video", upload.single("video"), async (req, res) => {
  if (!req.file || !GLOBAL_INDEX_ID)
    return res.status(400).json({ error: "Not ready" });

  const filePath = req.file.path;
  const { audience, platform } = req.body;

  try {
    console.log(`[1] Uploading...`);
    const task = await client.tasks.create({
      indexId: GLOBAL_INDEX_ID,
      videoFile: fs.createReadStream(filePath),
    });

    console.log(`[2] Processing Task: ${task.id}`);

    // Polling Loop
    let attempts = 0;
    let videoId = null;
    while (attempts < 60) {
      const status = await client.tasks.retrieve(task.id);
      if (status.status === "ready") {
        videoId = status.videoId;
        break;
      }
      if (status.status === "failed") throw new Error("Processing failed");
      await new Promise((r) => setTimeout(r, 2000));
      attempts++;
    }

    if (!videoId) throw new Error("Timeout");

    console.log(`[3] Analyzing Video ID: ${videoId}`);

    // Use GENERATE (Pegasus) for deep reasoning
    const result = await client.generate.text({
      videoId: videoId,
      prompt: ANALYSIS_PROMPT(audience, platform),
      temperature: 0.2, // Low temp for consistent JSON
    });

    // Clean the output to ensure it's valid JSON
    let cleanJson = result.data
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const analysisData = JSON.parse(cleanJson);

    // Get hashtags separately for SEO
    const gistResult = await client.gist({
      videoId: videoId,
      types: ["hashtag"],
    });
    analysisData.hashtags = gistResult.hashtags || [];

    console.log("✅ Analysis Sent");

    fs.unlink(filePath, () => {}); // Cleanup
    res.json(analysisData);
  } catch (error) {
    console.error("❌ Error:", error);
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => console.log(`🚀 VidScore Engine on ${port}`));
