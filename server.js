import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
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

// --- 1. SETUP INDEX (FIXED MODEL OPTIONS) ---
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

      // CRITICAL FIX: Restored "text_in_video". Removing it causes issues with
      // hooks that rely on reading text overlays, and can cause mismatches.
      const newIndex = await client.indexes.create({
        indexName: GLOBAL_INDEX_NAME,
        models: [
          {
            modelName: "marengo3.0", // Using 2.6 is often more stable for text OCR than 3.0 in some regions, but 3.0 is fine if enabled correctly.
            modelOptions: ["visual", "audio", "text_in_video"],
          },
          {
            modelName: "pegasus1.2", // standard for generation
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

// --- LAYER 1: FORENSIC AGENT ---
const performForensicSearch = async (indexId, videoId) => {
  const issues = [];
  const negativeQueries = [
    { query: "dark screen poorly lit black screen", label: "Bad Lighting" },
    { query: "shaky camera unstable footage", label: "Unstable Camera" },
    { query: "blurry out of focus", label: "Focus Issues" },
  ];

  console.log("   🔎 Starting Forensic Search...");

  await Promise.all(
    negativeQueries.map(async (item) => {
      try {
        const results = await client.search.query({
          indexId: indexId,
          queryText: item.query,
          options: ["visual"],
          filter: { id: [videoId] },
        });

        const matches = results.data || [];
        // High threshold to avoid false positives
        if (matches.length > 0 && matches[0].score > 82) {
          const best = matches[0];
          issues.push({
            type: item.label,
            timestamp: `${Math.floor(best.start)}s`,
            confidence: Math.round(best.score),
          });
        }
      } catch (e) {
        // Ignore failures
      }
    })
  );

  return issues;
};

// --- LAYER 2: PACING AGENT ---
const analyzePacing = async (indexId, videoId, duration) => {
  try {
    console.log("   🗣 Analyzing Pacing...");
    // Fallback-safe transcription fetch
    let transcript;
    try {
      transcript = await client.indexes.video.transcription(indexId, videoId);
    } catch (e) {
      console.log("   ⚠️ No transcription found (Music only or SDK mismatch)");
      return { wpm: 0, deadAirCount: 0, hasAudio: false };
    }

    if (!transcript || !transcript.data || transcript.data.length === 0) {
      return { wpm: 0, deadAirCount: 0, hasAudio: false };
    }

    const words = transcript.data.reduce(
      (acc, curr) => acc + curr.value.split(" ").length,
      0
    );
    const durationMins = duration / 60;
    const wpm = durationMins > 0 ? Math.round(words / durationMins) : 0;

    let deadAirCount = 0;
    for (let i = 0; i < transcript.data.length - 1; i++) {
      const endCurrent = transcript.data[i].end;
      const startNext = transcript.data[i + 1].start;
      if (startNext - endCurrent > 2.5) {
        deadAirCount++;
      }
    }

    return { wpm, deadAirCount, hasAudio: true };
  } catch (e) {
    console.log("Pacing analysis failed:", e.message);
    return { wpm: 0, deadAirCount: 0, hasAudio: false };
  }
};

// --- LAYER 3: PROMPT ENGINEERING ---
const GENERATE_MASTER_PROMPT = (
  audience,
  platform,
  forensics,
  pacing,
  gist
) => {
  const forensicSummary =
    forensics.length > 0
      ? `CRITICAL FLAWS DETECTED: ${JSON.stringify(
          forensics
        )}. Mention these as reasons for score deductions.`
      : "Visuals are technically stable.";

  const pacingSummary = pacing.hasAudio
    ? `Speaker Pace: ${pacing.wpm} WPM. Dead Air detected: ${pacing.deadAirCount} times.`
    : `No speech detected (Music/Visual only).`;

  return `
      Act as a viral content strategist for ${platform}.
      Target Audience: ${audience}.
      
      VIDEO DATA:
      - ${forensicSummary}
      - ${pacingSummary}
      - Topics: ${gist.topics ? gist.topics.join(", ") : "General"}
      
      Provide a critique in this JSON format:
      {
        "overallScore": (0-100),
        "hookScore": (0-10),
        "visualScore": (0-10),
        "hookAnalysis": { "status": "Weak"|"Strong", "feedback": "..." },
        "criticalIssues": ["List 3 fatal flaws"],
        "actionableFixes": ["List 3 specific fixes"],
        "viralPotential": "High"|"Medium"|"Low"
      }
    `;
};

// --- MAIN ROUTE ---
app.post("/analyze-video", upload.single("video"), async (req, res) => {
  if (!req.file || !GLOBAL_INDEX_ID)
    return res.status(400).json({ error: "System not ready" });

  // 1. FILE RENAMING FIX
  // Multer saves as "554a..." with no extension. TwelveLabs needs ".mp4" to process correctly.
  const originalExt = path.extname(req.file.originalname) || ".mp4";
  const safeFilePath = req.file.path + originalExt;

  try {
    fs.renameSync(req.file.path, safeFilePath);

    console.log(`[1] Uploading ${safeFilePath}...`);

    const task = await client.tasks.create({
      indexId: GLOBAL_INDEX_ID,
      videoFile: fs.createReadStream(safeFilePath), // Send the file with the extension
    });

    console.log(`[2] Processing Task: ${task.id}`);

    let videoId = null;
    let videoDuration = 60; // Default

    // Polling - Increased checks
    let attempts = 0;
    while (attempts < 60) {
      const status = await client.tasks.retrieve(task.id);

      if (status.status === "ready") {
        videoId = status.videoId;
        try {
          // Retrieve Metadata for accurate pacing
          const vidMeta = await client.indexes.video.retrieve(
            GLOBAL_INDEX_ID,
            videoId
          );
          videoDuration = vidMeta.metadata.duration || 60;
        } catch (e) {}
        break;
      }

      if (status.status === "failed") {
        console.error("❌ Indexing Failure:", JSON.stringify(status));
        throw new Error(
          `Indexing Failed: ${status.processStatus || status.error_reason}`
        );
      }

      await new Promise((r) => setTimeout(r, 2000)); // Wait 2s between checks
      attempts++;
    }

    if (!videoId) throw new Error("Timeout waiting for video processing");

    // 3. RUN AGENTS
    console.log("⚡ Running Agents...");

    // Get Gist (Topics/Hashtags)
    let gistData = { topics: [], hashtags: [] };
    try {
      gistData = await client.gist({ videoId, types: ["topic", "hashtag"] });
    } catch (e) {
      console.log("Gist skipped");
    }

    const [forensicIssues, pacingData] = await Promise.all([
      performForensicSearch(GLOBAL_INDEX_ID, videoId),
      analyzePacing(GLOBAL_INDEX_ID, videoId, videoDuration),
    ]);

    // 4. GENERATE REPORT
    console.log("🧠 Generating Insight...");
    const { audience = "General", platform = "TikTok" } = req.body;

    const prompt = GENERATE_MASTER_PROMPT(
      audience,
      platform,
      forensicIssues,
      pacingData,
      gistData
    );

    // Using `analyze` (or generate.text depending on SDK version)
    const result = await client.generate.text(videoId, prompt, {
      temperature: 0.2,
    });

    // 5. PARSE & CLEANUP
    let finalData = {};
    const rawText = (result.data || result.content || "")
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    try {
      finalData = JSON.parse(rawText);
    } catch (e) {
      finalData = { overallScore: 0, criticalIssues: ["AI Parsing Error"] };
    }

    // Merge Forensics into Critical Issues
    if (!finalData.criticalIssues) finalData.criticalIssues = [];
    if (forensicIssues.length > 0) {
      forensicIssues.forEach((i) =>
        finalData.criticalIssues.unshift(
          `Technical Flaw: ${i.type} at ${i.timestamp}`
        )
      );
    }
    if (pacingData.deadAirCount > 1) {
      finalData.criticalIssues.push(
        `Pacing Alert: ${pacingData.deadAirCount} moments of dead air detected.`
      );
    }

    finalData.hashtags = gistData.hashtags || [];

    console.log("✅ Complete");
    res.json(finalData);
  } catch (error) {
    console.error("❌ Error:", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    // Cleanup the safe file path
    if (fs.existsSync(safeFilePath)) fs.unlinkSync(safeFilePath);
    // Cleanup original just in case rename failed
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

app.listen(port, () => console.log(`🚀 VidScore Fixed & Running on ${port}`));
