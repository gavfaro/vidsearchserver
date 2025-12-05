import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { TwelveLabs } from "twelvelabs-js";
import "dotenv/config";

const app = express();
const upload = multer({ dest: "/tmp/" });
const port = process.env.PORT || 3000;

// Initialize Twelve Labs Client
const client = new TwelveLabs({ apiKey: process.env.TWELVE_LABS_API_KEY });

app.use(cors());
app.use(express.json());

const GLOBAL_INDEX_NAME = "VidScore_Premium_Index_V2";
let GLOBAL_INDEX_ID = null;

// --- 1. INITIALIZATION: Setup Marengo 3.0 + Pegasus 1.2 Index ---
const getOrCreateGlobalIndex = async () => {
  try {
    // FIX: Used 'indexes' (plural) instead of 'index'
    const indexes = await client.indexes.list();
    const existingIndex = indexes.data.find(
      (i) => i.indexName === GLOBAL_INDEX_NAME
    );

    if (existingIndex) {
      GLOBAL_INDEX_ID = existingIndex.id;
      console.log(`✅ Linked to existing index: ${GLOBAL_INDEX_ID}`);
    } else {
      console.log(`Creating new index with Marengo 3.0 & Pegasus 1.2...`);
      // FIX: Updated model names and options syntax
      const newIndex = await client.indexes.create({
        indexName: GLOBAL_INDEX_NAME,
        models: [
          {
            modelName: "marengo3.0",
            modelOptions: ["visual", "audio"],
          },
          {
            modelName: "pegasus1.2",
            modelOptions: ["visual", "audio"],
          },
        ],
      });
      GLOBAL_INDEX_ID = newIndex.id;
      console.log(`✅ Created New Index: ${GLOBAL_INDEX_ID}`);
    }
  } catch (error) {
    console.error("Index Init Error:", error);
  }
};

// Initialize on start
getOrCreateGlobalIndex();

// --- 2. LAYER 1: FORENSIC AGENT (Search) ---
// Searches for negative traits to provide hard evidence
const performForensicSearch = async (indexId, videoId) => {
  // The "Crimes" against retention
  const negativeQueries = [
    { query: "dark screen poorly lit", label: "Bad Lighting" },
    { query: "shaky camera unstable footage", label: "Unstable Camera" },
    { query: "blurry out of focus", label: "Focus Issues" },
    { query: "loading screen static buffering", label: "Dead Air/Static" },
  ];

  console.log("🕵️‍♂️ Forensic Agent: Scanning for flaws...");

  // Run searches in parallel for speed
  const searchPromises = negativeQueries.map(async (item) => {
    try {
      // FIX: Using 'client.search.query' and 'searchOptions'
      const searchPager = await client.search.query({
        indexId: indexId,
        queryText: item.query,
        searchOptions: ["visual"],
        filter: { id: [videoId] }, // Strict filter for this video
      });

      // Pagination handling - we just check the first page
      let bestMatch = null;
      for await (const result of searchPager) {
        if (result.score > 75) {
          bestMatch = result;
          break; // Found a high confidence match
        }
      }

      if (bestMatch) {
        const timestamp = `${Math.floor(bestMatch.start)}s-${Math.floor(
          bestMatch.end
        )}s`;
        return `${item.label} detected at ${timestamp}`;
      }
    } catch (e) {
      console.warn(`Skipped forensic check for ${item.label}: ${e.message}`);
    }
    return null;
  });

  const results = await Promise.all(searchPromises);
  return results.filter((r) => r !== null);
};

// --- 3. LAYER 2: NICHE DETECTION AGENT ---
const detectVideoNiche = async (videoId) => {
  try {
    // FIX: Using 'client.analyze' for text generation
    const result = await client.analyze({
      videoId: videoId,
      prompt:
        "Analyze this video and return exactly ONE category name from this list: Real Estate, Fitness, Tech, Beauty, Business, Pets, Cooking, Gaming. If unclear, return 'General'. Return only the word.",
      temperature: 0.1,
    });
    return result.data ? result.data.trim() : "General";
  } catch (e) {
    console.log("Niche detection failed, defaulting to General");
    return "General";
  }
};

// --- 4. LAYER 3: CONTEXT RULES ENGINE ---
const getNicheContext = (audience) => {
  const norm = audience.toLowerCase();
  if (norm.includes("real estate"))
    return "Standards: Elegant pacing, wide angles, high light. Hook must show the property hero shot.";
  if (norm.includes("fitness"))
    return "Standards: High energy, clear form visibility. Hook must show the struggle or the result.";
  if (norm.includes("tech"))
    return "Standards: Crisp audio, macro shots of hardware. Hook must show the finished product/result.";
  if (norm.includes("beauty"))
    return "Standards: Perfect lighting, texture visibility. Hook must be a transformation.";
  return "Standards: High retention, clear audio, visual movement every 3 seconds.";
};

// --- MAIN ROUTE ---
app.post("/analyze-video", upload.single("video"), async (req, res) => {
  if (!req.file || !GLOBAL_INDEX_ID) {
    return res.status(400).json({ error: "System not ready or file missing" });
  }

  const filePath = req.file.path;
  // Default values if not provided
  let audience = req.body.audience || "";
  let platform = req.body.platform || "TikTok";

  try {
    console.log(`[1] 📤 Uploading & Indexing...`);

    // 1. Upload & Index
    // FIX: Using 'client.tasks.create'
    const task = await client.tasks.create({
      indexId: GLOBAL_INDEX_ID,
      videoFile: fs.createReadStream(filePath),
    });

    console.log(`[2] ⏳ Waiting for Indexing (Task: ${task.id})...`);
    // FIX: Using 'client.tasks.waitForDone'
    await client.tasks.waitForDone(task.id);

    // Retrieve video ID from task
    const taskResult = await client.tasks.retrieve(task.id);
    const videoId = taskResult.videoId;

    if (!videoId) throw new Error("Video ID not found after indexing");

    console.log(`[3] 🧠 Starting Parallel Agents for Video: ${videoId}`);

    // 2. Parallel Execution of Agents
    const nichePromise =
      !audience || audience === ""
        ? detectVideoNiche(videoId)
        : Promise.resolve(audience);

    const [detectedAudience, forensicIssues, gistData] = await Promise.all([
      nichePromise,
      performForensicSearch(GLOBAL_INDEX_ID, videoId),
      client.gist({ videoId: videoId, types: ["hashtag", "topic"] }),
    ]);

    // Update audience if it was auto-detected
    audience = detectedAudience;
    console.log(`   👉 Context: ${audience}`);
    console.log(`   👉 Forensics: ${forensicIssues.length} issues found`);

    // 3. Construct The Master Prompt
    const forensicSummary =
      forensicIssues.length > 0
        ? `CRITICAL: I have technically detected the following flaws with high confidence: ${JSON.stringify(
            forensicIssues
          )}. You MUST reference these in your 'criticalIssues' list.`
        : "Technical analysis passed (no dark/shaky footage detected).";

    const nicheRules = getNicheContext(audience);

    const prompt = `
      You are a specialized Viral Video Auditor for ${platform}.
      
      INPUT DATA:
      - Target Audience: ${audience}
      - Detected Topics: ${gistData.topics?.join(", ")}
      - Technical Forensics: ${forensicSummary}
      - Niche Standards: ${nicheRules}

      TASK:
      Perform a diagnostic analysis. Do not be polite. Be data-driven.
      
      1. HOOK (0:00-0:03): Does it meet the Niche Standards?
      2. RETENTION: If Forensics found issues, cite them as reasons for drop-off.
      3. VALUE: Does the content match the detected topics?
    `;

    // 4. Pegasus Generation with JSON Schema enforcement
    // This ensures the output strictly matches the Swift Codable struct
    const analysis = await client.analyze({
      videoId: videoId,
      prompt: prompt,
      temperature: 0.2,
      responseFormat: {
        type: "json_schema",
        jsonSchema: {
          type: "object",
          properties: {
            overallScore: { type: "integer" },
            hookScore: { type: "number" },
            visualScore: { type: "number" },
            audioScore: { type: "number" },
            audienceMatchScore: { type: "number" },
            predictedRetention: {
              type: "array",
              items: { type: "integer" },
            },
            hookAnalysis: {
              type: "object",
              properties: {
                status: { type: "string" },
                timestamp: { type: "string" },
                feedback: { type: "string" },
              },
              required: ["status", "timestamp", "feedback"],
            },
            criticalIssues: {
              type: "array",
              items: { type: "string" },
            },
            actionableFixes: {
              type: "array",
              items: { type: "string" },
            },
            captionSuggestion: { type: "string" },
            viralPotential: { type: "string" },
          },
          required: [
            "overallScore",
            "hookScore",
            "visualScore",
            "hookAnalysis",
            "criticalIssues",
            "captionSuggestion",
            "viralPotential",
          ],
        },
      },
    });

    // 5. Data Merge & Cleanup
    const finalResult = JSON.parse(analysis.data);

    // Inject the real hashtags from Gist Agent
    finalResult.hashtags = gistData.hashtags || [];
    finalResult.detectedAudience = audience;

    // Fallback: If Pegasus ignored the forensic data, force inject it
    if (forensicIssues.length > 0) {
      const issuesString = JSON.stringify(finalResult.criticalIssues);
      const missingIssues = forensicIssues.filter(
        (issue) => !issuesString.includes(issue.substring(0, 10))
      );
      finalResult.criticalIssues.unshift(...missingIssues);
    }

    // Cleanup temp file
    fs.unlink(filePath, () => {});

    res.json(finalResult);
  } catch (error) {
    console.error("Analysis Failed:", error);
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(port, () =>
  console.log(`🚀 VidScore Premium Engine running on port ${port}`)
);
