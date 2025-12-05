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

const GLOBAL_INDEX_NAME = "VidScore_Premium_Index";
let GLOBAL_INDEX_ID = null;

// --- 1. INITIALIZATION: Setup Marengo 3.0 + Pegasus 1.2 Index ---
const getOrCreateGlobalIndex = async () => {
  try {
    const indexes = await client.index.list();
    const existingIndex = indexes.data.find(
      (i) => i.indexName === GLOBAL_INDEX_NAME
    );

    if (existingIndex) {
      GLOBAL_INDEX_ID = existingIndex.id;
      console.log(`✅ Linked to existing index: ${GLOBAL_INDEX_ID}`);
    } else {
      console.log(`Creating new index with Marengo 3.0 & Pegasus 1.2...`);
      const newIndex = await client.index.create({
        name: GLOBAL_INDEX_NAME,
        models: [
          {
            name: "marengo2.6",
            options: ["visual", "conversation", "text_in_video"],
          },
          {
            name: "pegasus1.1",
            options: ["visual", "conversation"],
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
  const issues = [];

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
      const results = await client.search.query({
        indexId: indexId,
        queryText: item.query,
        options: ["visual"],
        filter: { id: [videoId] }, // Strict filter for this video
      });

      // Filter for high confidence matches (> 75)
      const matches = results.data.filter((clip) => (clip.score ?? 0) > 75);

      if (matches.length > 0) {
        // Take the highest confidence match
        const bestMatch = matches[0];
        const timestamp = `${Math.floor(bestMatch.start)}s-${Math.floor(
          bestMatch.end
        )}s`;
        return `${item.label} detected at ${timestamp}`;
      }
    } catch (e) {
      console.warn(`Skipped forensic check for ${item.label}`);
    }
    return null;
  });

  const results = await Promise.all(searchPromises);
  return results.filter((r) => r !== null);
};

// --- 3. LAYER 2: NICHE DETECTION AGENT ---
const detectVideoNiche = async (videoId) => {
  try {
    const result = await client.generate.text({
      videoId: videoId,
      prompt:
        "Analyze this video and return exactly ONE category name from this list: Real Estate, Fitness, Tech, Beauty, Business, Pets, Cooking, Gaming. If unclear, return 'General'. Return only the word.",
      temperature: 0.1,
    });
    return result.data.trim();
  } catch (e) {
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
  let { audience, platform } = req.body;

  try {
    console.log(`[1] 📤 Uploading & Indexing...`);

    // 1. Upload & Index
    const task = await client.task.create({
      indexId: GLOBAL_INDEX_ID,
      file: fs.createReadStream(filePath),
    });

    console.log(`[2] ⏳ Waiting for Indexing (Task: ${task.id})...`);
    await client.task.waitForDone(task.id);

    // Retrieve video ID from task
    const taskResult = await client.task.retrieve(task.id);
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
      client.generate.gist({ videoId: videoId, types: ["hashtag", "topic"] }),
    ]);

    // Update audience if it was auto-detected
    audience = detectedAudience;
    console.log(`   👉 Context: ${audience}`);
    console.log(`   👉 Forensics: ${forensicIssues.length} issues found`);

    // 3. Construct The Master Prompt (Layer 4: The Creative Director)
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

      OUTPUT FORMAT (JSON Schema):
      {
        "overallScore": (integer 0-100),
        "hookScore": (integer 0-10),
        "visualScore": (integer 0-10),
        "audioScore": (integer 0-10),
        "audienceMatchScore": (integer 0-10),
        "predictedRetention": [array of 6 integers 0-100 representing graph points],
        "hookAnalysis": {
          "status": "Weak" | "Strong",
          "timestamp": "0:00-0:03",
          "feedback": "string"
        },
        "criticalIssues": ["string (include timestamps from forensics if available)"],
        "actionableFixes": ["string"],
        "captionSuggestion": "string",
        "viralPotential": "Low" | "Medium" | "High"
      }
    `;

    // 4. Pegasus Generation
    const analysis = await client.generate.text({
      videoId: videoId,
      prompt: prompt,
      temperature: 0.2, // Low temperature for consistent JSON
    });

    // 5. Data Merge & Cleanup
    // Basic JSON extraction
    const jsonString = analysis.data
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const finalResult = JSON.parse(jsonString);

    // Inject the real hashtags from Gist Agent (more accurate than Pegasus hallucination)
    finalResult.hashtags = gistData.hashtags || [];
    finalResult.detectedAudience = audience;

    // Fallback: If Pegasus ignored the forensic data, force inject it
    if (forensicIssues.length > 0) {
      const missingIssues = forensicIssues.filter(
        (issue) =>
          !JSON.stringify(finalResult.criticalIssues).includes(
            issue.substring(0, 10)
          )
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
