import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { TwelveLabs } from "twelvelabs-js";
import "dotenv/config";

const app = express();
const upload = multer({ dest: "/tmp/" });
const port = process.env.PORT || 3000;

const client = new TwelveLabs({ apiKey: process.env.TWELVE_LABS_API_KEY });
app.use(cors());
app.use(express.json());

const INDEX_NAME = "VidScore_Premium_Index";
let GLOBAL_INDEX_ID = null;

// 1. Ensure Index uses Marengo 3.0 (Critical for Search) and Pegasus 1.2
const initIndex = async () => {
  const indexes = await client.index.list();
  const existing = indexes.data.find((i) => i.indexName === INDEX_NAME);

  if (existing) {
    GLOBAL_INDEX_ID = existing.id;
    console.log(`✅ Index Ready: ${GLOBAL_INDEX_ID}`);
  } else {
    const newIndex = await client.index.create({
      name: INDEX_NAME,
      models: [
        {
          modelName: "marengo3.0",
          modelOptions: ["visual", "audio", "text_in_video"],
        },
        { modelName: "pegasus1.2", modelOptions: ["visual", "audio"] },
      ],
    });
    GLOBAL_INDEX_ID = newIndex.id;
    console.log(`✅ Created Premium Index: ${GLOBAL_INDEX_ID}`);
  }
};
initIndex();

// --- THE ROAST PROMPT ---
const generateRoastPrompt = (audience, platform, searchData) => `
ROLE: You are the algorithm for ${platform}. You are ruthless, data-driven, and focused purely on retention and shareability.
TARGET AUDIENCE: ${audience}

HARD DATA EVIDENCE (Use this to justify your scores):
- Hook Strength Evidence: We detected ${searchData.faceCount} close-ups of faces and ${searchData.textCount} text overlays in the video.
- Visual Pacing: The video contains various distinct visual segments.

TASK: Analyze this video for virality.
1. PREDICTED RETENTION GRAPH: Generate 6 numbers (0-100) representing viewer retention at [0s, 5s, 10s, 15s, 20s, End]. 
   - If the first 3 seconds lack "Face" or "Text", drop the graph sharply at 5s.
   - If there is constant talking without visual changes, drop retention over time.
2. HOOK ANALYSIS: Analyze the first 3 seconds specifically. Did they start with a visual bang?
3. ROAST THE CREATOR: List 3 Critical Issues. Be mean but accurate. Use the timestamps.
   - Bad example: "The audio is bad."
   - Good example: "At 0:04, you paused for 2 seconds. That is instant death on TikTok. Cut the silence."

OUTPUT FORMAT (JSON ONLY):
{
  "overallScore": (int 0-100),
  "scores": { "hook": (0-10), "visual": (0-10), "audio": (0-10), "audience": (0-10) },
  "retentionCurve": [int, int, int, int, int, int],
  "hookAudit": { "status": "Weak/Strong", "timestamp": "0:00", "advice": "string" },
  "roast": [ "stingy critique 1", "stingy critique 2", "stingy critique 3" ],
  "fixes": [ "actionable fix 1", "actionable fix 2", "actionable fix 3" ],
  "viralPotential": "Low/Med/High",
  "caption": "string",
  "hashtags": ["string"]
}
`;

app.post("/analyze-video", upload.single("video"), async (req, res) => {
  if (!req.file || !GLOBAL_INDEX_ID)
    return res.status(400).json({ error: "System not ready" });

  const filePath = req.file.path;
  const { audience, platform } = req.body;

  try {
    // 1. Upload & Index
    const task = await client.task.create({
      indexId: GLOBAL_INDEX_ID,
      file: fs.createReadStream(filePath),
    });

    // Poll for completion
    await task.waitForDone({ sleepInterval: 2000 });
    const videoId = task.videoId;

    // 2. MARENGO INTELLIGENCE GATHERING (The Premium Step)
    // We search the video *before* asking for the roast to get hard numbers.

    const [faceSearch, textSearch] = await Promise.all([
      client.search.query({
        indexId: GLOBAL_INDEX_ID,
        queryText: "face looking at camera",
        searchOptions: ["visual"],
        pageLimit: 5, // Just check density
      }),
      client.search.query({
        indexId: GLOBAL_INDEX_ID,
        queryText: "text on screen",
        searchOptions: ["visual"],
        pageLimit: 5,
      }),
    ]);

    // Prepare Evidence for Pegasus
    const evidence = {
      faceCount: faceSearch.data.length,
      textCount: textSearch.data.length,
    };

    // 3. PEGASUS ANALYSIS (The Verdict)
    const analysis = await client.analyze({
      videoId: videoId,
      prompt: generateRoastPrompt(audience, platform, evidence),
      temperature: 0.4, // Higher temp for more "creative" roasting
    });

    // 4. HASHTAGS (Gist)
    const gist = await client.generate.gist({
      videoId: videoId,
      types: ["hashtag"],
    });

    // Parse Response
    let result = JSON.parse(analysis.data.replace(/```json|```/g, "").trim());
    result.hashtags = gist.hashtags;

    // Clean up
    fs.unlinkSync(filePath);

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Analysis failed" });
  }
});

app.listen(port, () => console.log(`🔥 VidScore Core Active: ${port}`));
