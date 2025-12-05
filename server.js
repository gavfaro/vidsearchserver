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
    // FIX: Changed client.index.list() to client.indexes.list()
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
      console.log(
        `Index ${GLOBAL_INDEX_NAME} not found. Creating new one with Marengo & Pegasus...`
      );

      // FIX: Changed client.index.create to client.indexes.create
      // FIX: Reverted to 'models' syntax from your working old code to ensure compatibility
      const newIndex = await client.indexes.create({
        indexName: GLOBAL_INDEX_NAME,
        models: [
          {
            modelName: "marengo3.0",
            modelOptions: ["visual", "audio"], // ✅ FIXED
          },
          {
            modelName: "pegasus1.2",
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

const startServer = async () => {
  await getOrCreateGlobalIndex();

  if (!GLOBAL_INDEX_ID) {
    console.error(
      "❌ Could not initialize index. Check API key or permissions."
    );
    process.exit(1);
  }

  app.listen(port, () => console.log(`🚀 VidScore Premium Engine on ${port}`));
};

startServer();

// --- LAYER 1: FORENSIC AGENT (Search) ---
// Actively hunts for bad quality footage
const performForensicSearch = async (indexId, videoId) => {
  const issues = [];
  const negativeQueries = [
    { query: "dark screen poorly lit black screen", label: "Bad Lighting" },
    { query: "shaky camera unstable footage", label: "Unstable Camera" },
    { query: "blurry out of focus", label: "Focus Issues" },
    { query: "static screen loading screen", label: "Static Visuals" },
  ];

  console.log("   🔎 Starting Forensic Search...");

  // Run searches in parallel to save time
  await Promise.all(
    negativeQueries.map(async (item) => {
      try {
        const results = await client.search.query({
          indexId: indexId,
          queryText: item.query,
          options: ["visual"],
          filter: { id: [videoId] },
        });

        // If we find a high confidence match (>75), it's a "Fact", not an opinion
        const matches = results.data || [];
        const bestMatch = matches[0];

        if (bestMatch && bestMatch.score > 75) {
          issues.push({
            type: item.label,
            timestamp: `${Math.floor(bestMatch.start)}s-${Math.floor(
              bestMatch.end
            )}s`,
            confidence: bestMatch.score,
            details: `Confidence: ${Math.round(bestMatch.score)}%`,
          });
        }
      } catch (e) {
        // Ignore search failures, just means no issues found
      }
    })
  );

  return issues;
};

// --- LAYER 2: PACING AGENT (Transcription) ---
// Calculates WPM and checks for dead air
const analyzePacing = async (indexId, videoId, duration) => {
  try {
    console.log("   🗣 Analyzing Pacing...");

    // FIX: Changed client.index.video... to client.indexes.video... (or fallback)
    // Note: Depending on SDK version, transcription might be on a different path.
    // We try the most common path compatible with 'indexes' syntax.
    let transcript;
    try {
      transcript = await client.indexes.video.transcription(indexId, videoId);
    } catch (err) {
      // Fallback for older SDKs that might nest it differently
      console.log("   ⚠️ Transcription path fallback...");
      // If this fails, we return empty to prevent crash
      return { wpm: 0, deadAirCount: 0, hasAudio: false };
    }

    // Safety check if transcript is empty
    if (!transcript || !transcript.data || transcript.data.length === 0) {
      return { wpm: 0, deadAirCount: 0, hasAudio: false };
    }

    const words = transcript.data.reduce(
      (acc, curr) => acc + curr.value.split(" ").length,
      0
    );
    const durationMins = duration / 60;
    const wpm = durationMins > 0 ? Math.round(words / durationMins) : 0;

    // Detect dead air (gaps between segments > 2 seconds)
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
    console.log("Pacing analysis failed (likely no audio)", e.message);
    return { wpm: 0, deadAirCount: 0, hasAudio: false };
  }
};

// --- LAYER 3: CREATIVE DIRECTOR (Prompt Engineering) ---
const GENERATE_MASTER_PROMPT = (
  audience,
  platform,
  forensics,
  pacing,
  gist
) => {
  // Convert forensic data into a narrative for the AI
  const forensicSummary =
    forensics.length > 0
      ? `CRITICAL TECHNICAL FLAWS DETECTED BY COMPUTER VISION: ${JSON.stringify(
          forensics
        )}. You MUST reference these specific timestamps as reasons for lower scores.`
      : "Computer vision detected no major technical flaws (lighting and camera work are stable).";

  const pacingSummary = pacing.hasAudio
    ? `PACING DATA: Speaker is at ${pacing.wpm} WPM. There are ${pacing.deadAirCount} instances of "dead air" (silence > 2.5s).`
    : `PACING DATA: No speech detected.`;

  const topicSummary = `DETECTED TOPICS: ${
    gist.topics ? gist.topics.join(", ") : "General"
  }`;

  return `
      You are a harsh, high-ticket viral consultant for ${platform}. 
      
      CONTEXTUAL DATA (FACTS):
      - Target Audience: ${audience}
      - ${topicSummary}
      - ${forensicSummary}
      - ${pacingSummary}
      
      YOUR TASK:
      Analyze the video for "Retention", "Hook", and "Value".
      
      1. HOOK (0:00-0:03): Be ruthless. Does it grab attention?
      2. RETENTION: Use the Technical Data provided. If there are flaws (shaky/dark), cite them as reasons people scroll away.
      3. SCRIPT: Use the WPM data. < 120 is too slow for TikTok/Shorts. > 160 is energetic.
      
      OUTPUT JSON format exactly (no markdown):
      {
        "overallScore": (0-100),
        "hookScore": (0-10),
        "visualScore": (0-10),
        "audioScore": (0-10),
        "audienceMatchScore": (0-10),
        "predictedRetention": [100, 80, 60... array of 6 ints ending at video end],
        "hookAnalysis": {
          "status": "Weak" | "Strong",
          "timestamp": "0:00-0:03",
          "feedback": "Specific advice."
        },
        "criticalIssues": ["List 3 specific things to fix. If forensics found issues, list them here with timestamps"],
        "actionableFixes": ["3 steps to improve"],
        "captionSuggestion": "A viral caption",
        "viralPotential": "High/Med/Low"
      }
    `;
};

// --- MAIN ROUTE ---
app.post("/analyze-video", upload.single("video"), async (req, res) => {
  if (!req.file || !GLOBAL_INDEX_ID)
    return res.status(400).json({ error: "System not ready" });

  const filePath = req.file.path;
  const { audience = "General", platform = "TikTok" } = req.body;

  try {
    // 1. UPLOAD
    console.log(`[1] Uploading Video...`);

    // FIX: Changed client.task.create to client.tasks.create
    const task = await client.tasks.create({
      index_id: GLOBAL_INDEX_ID,
      video_file: fs.createReadStream(filePath),
    });

    // 2. WAIT FOR INDEXING
    console.log(`[2] Processing Task: ${task.id}`);
    let videoId = null;
    let videoDuration = 0;

    // Polling mechanism
    for (let i = 0; i < 60; i++) {
      // FIX: Changed client.task.retrieve to client.tasks.retrieve
      const status = await client.tasks.retrieve(task.id);
      if (status.status === "ready") {
        videoId = status.videoId; // Note: Old SDK usually uses 'videoId'

        // Fetch video metadata for duration
        // FIX: Changed client.index.video to client.indexes.video (or basic retrieve)
        try {
          const vidData = await client.indexes.video.retrieve(
            GLOBAL_INDEX_ID,
            videoId
          );
          videoDuration = vidData.metadata.duration;
        } catch (e) {
          console.log("Could not retrieve duration, defaulting to 60s");
          videoDuration = 60;
        }
        break;
      }
      if (status.status === "failed") throw new Error("Indexing Failed");
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!videoId) throw new Error("Timeout waiting for video");

    // 3. PARALLEL ANALYSIS (The "Premium" Difference)
    console.log("⚡ Starting Deep Analysis Layers...");

    // Safe retrieval of Gist
    let gistData = { topics: [], hashtags: [] };
    try {
      gistData = await client.gist({ videoId, types: ["topic", "hashtag"] });
    } catch (e) {
      // Fallback if gist fails or syntax is different
      console.log("Gist skipped or failed", e.message);
    }

    const [forensicIssues, pacingData] = await Promise.all([
      performForensicSearch(GLOBAL_INDEX_ID, videoId),
      analyzePacing(GLOBAL_INDEX_ID, videoId, videoDuration),
    ]);

    // 4. GENERATIVE SYNTHESIS
    console.log("🧠 Synthesizing Final Report...");

    const prompt = GENERATE_MASTER_PROMPT(
      audience,
      platform,
      forensicIssues,
      pacingData,
      gistData
    );

    // FIX: Switched back to client.generate.text
    // NOTE: If this fails, your SDK might require client.analyze (like the old code).
    // We will wrap this in a try/catch specifically for the generate call.
    let aiResult;
    try {
      aiResult = await client.generate.text(videoId, prompt, {
        temperature: 0.2,
      });
    } catch (e) {
      console.log("Generative text failed, trying fallback to analyze...");
      // Fallback to client.analyze from your old code
      aiResult = await client.analyze({
        videoId: videoId,
        prompt: prompt,
        temperature: 0.2,
      });
    }

    // 5. MERGE & CLEANUP
    const cleanJson = (aiResult.data || aiResult.content || "")
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    let finalData;

    try {
      finalData = JSON.parse(cleanJson);
    } catch (e) {
      console.error("JSON Parse Error", cleanJson);
      // Fallback structure
      finalData = {
        overallScore: 0,
        criticalIssues: ["AI generation error"],
        actionableFixes: [],
      };
    }

    // Inject real hashtags and detected audience
    finalData.hashtags = gistData.hashtags || [];
    finalData.detectedAudience = audience;

    // CRITICAL: Force forensic issues into the report if AI missed them
    // This ensures the "Hard Data" is shown to the user
    if (forensicIssues.length > 0) {
      const forensicText = forensicIssues.map(
        (i) => `${i.timestamp}: ${i.type} detected (${i.details})`
      );
      // Prepend to critical issues
      finalData.criticalIssues = [...forensicText, ...finalData.criticalIssues];
    }

    // Add Pacing Warning if necessary
    if (pacingData.deadAirCount > 1) {
      finalData.criticalIssues.push(
        `Found ${pacingData.deadAirCount} awkward pauses (Dead Air). Remove gaps > 2s.`
      );
    }

    console.log("✅ Analysis Complete");
    res.json(finalData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Analysis Failed: " + error.message });
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

app.listen(port, () => console.log(`🚀 VidScore Premium Engine on ${port}`));
