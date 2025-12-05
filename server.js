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
const GLOBAL_INDEX_NAME = "VidScore_Premium_Analysis";

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
          {
            modelName: "marengo3.0",
            modelOptions: ["visual", "audio", "transcription"],
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

// --- 2. THE MEGA PREMIUM PROMPT ---
const ANALYSIS_PROMPT = (audience, platform) => `
You are an elite viral content strategist specializing in ${platform} with expertise in audience: ${audience}.
Your analysis must be brutally honest and hyper-specific. No generic advice.

Analyze this video with precision and return ONLY valid JSON (no markdown, no code blocks):

{
  "overallScore": (0-100, be harsh - 70+ is excellent),
  "viralityScore": (0-10, realistic assessment of viral potential),
  "hookScore": (0-10),
  "retentionScore": (0-10),
  "engagementScore": (0-10, for profile visits/link clicks),
  "audioScore": (0-10, music/sound quality),
  "dialogueScore": (0-10, if speech present, otherwise null),
  
  "predictedMetrics": {
    "estimatedViews": (realistic number based on quality),
    "retentionCurve": [100, 95, 88, 82, 75, 68] (% retention at 0s, 3s, 6s, 9s, 12s, 15s+),
    "likeRatio": (0-10, expected engagement %),
    "shareRatio": (0-10, expected share %)
  },
  
  "hookAnalysis": {
    "strength": "Weak" | "Moderate" | "Strong" | "Viral-Worthy",
    "hookTimestamp": "0.0-2.5s",
    "firstFrameImpact": "Describe what viewer sees in first 0.5s",
    "psychologicalTriggers": ["curiosity", "shock", "relatability", etc],
    "improvements": "Specific first 3 seconds fix"
  },
  
  "retentionKillers": [
    {
      "timestamp": "5.2s",
      "issue": "Slow transition loses momentum",
      "severity": "High" | "Medium" | "Low",
      "fix": "Cut 2 seconds, add text overlay 'Wait for it'"
    }
  ],
  
  "strengths": [
    {
      "element": "Lighting in 10-15s range",
      "impact": "Creates professional aesthetic",
      "timestamp": "10s-15s"
    }
  ],
  
  "criticalIssues": [
    "Specific technical or content problem with timestamp",
    "Another critical fix needed"
  ],
  
  "actionableFixes": [
    {
      "priority": 1,
      "timestamp": "0s-3s",
      "action": "Recut opening to show [specific element] immediately",
      "expectedImprovement": "+15% hook retention",
      "difficulty": "Easy" | "Medium" | "Advanced"
    },
    {
      "priority": 2,
      "timestamp": "specific time",
      "action": "Exact edit to make",
      "expectedImprovement": "predicted boost",
      "difficulty": "level"
    }
  ],
  
  "audioAnalysis": {
    "musicChoice": "Describe if effective/trending",
    "volumeLevels": "Too quiet/loud/perfect",
    "syncWithVisuals": (0-10),
    "trendingSound": true/false,
    "recommendation": "Specific audio swap suggestion"
  },
  
  "dialogueAnalysis": {
    "clarity": (0-10),
    "pacing": "Too fast" | "Perfect" | "Too slow",
    "scriptQuality": "Assessment",
    "deliveryEnergy": (0-10),
    "improvements": ["Specific dialogue fixes"]
  },
  
  "audienceAlignment": {
    "score": (0-10),
    "matches": ["What works for target"],
    "mismatches": ["What doesn't fit audience"],
    "ageAppropriate": true/false,
    "culturalRelevance": "Assessment"
  },
  
  "algorithmOptimization": {
    "watchTimeOptimized": true/false,
    "engagementBait": ["Comment/Share triggers present"],
    "loopPotential": (0-10, for rewatches),
    "trending": ["#trends", "#hashtags", "relevant"]
  },
  
  "competitorComparison": {
    "topCreatorLevel": (0-10, vs best in niche),
    "uniqueAngle": "What makes this different",
    "improvements": "How to match top 1%"
  },
  
  "captionSuggestion": "Write actual ${platform} caption optimized for clicks",
  "hashtagStrategy": ["#ranked", "#by", "#relevance", "#trending"],
  "postingStrategy": {
    "bestTime": "Time to post for audience",
    "frequency": "How often similar content",
    "abTestIdea": "What to test next"
  },
  
  "viralPotential": "Low" | "Medium" | "High" | "Viral-Ready",
  "confidenceLevel": (0-100, how sure are you of this analysis)
}

RULES:
- Be HARSH but CONSTRUCTIVE
- Every score must have reasoning in relevant section
- Timestamps must be EXACT (use decimals)
- "Actionable" means: "Do THIS exact thing at THIS timestamp"
- No generic advice like "improve lighting" - say "Add ring light at 45° in 7-12s segment"
- Compare to actual viral videos in same niche
- Predict REALISTIC numbers, not optimistic dreams
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

    console.log(`[3] Deep Analysis Video ID: ${videoId}`);

    // ✅ Use Marengo 3.0's analyze endpoint for comprehensive analysis
    const result = await client.analyze({
      videoId: videoId,
      prompt: ANALYSIS_PROMPT(audience, platform),
      temperature: 0.1, // Very low for consistent, precise JSON
    });

    // Clean the output
    let cleanJson = result.data
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const analysisData = JSON.parse(cleanJson);

    console.log("✅ Premium Analysis Complete");

    fs.unlink(filePath, () => {});
    res.json(analysisData);
  } catch (error) {
    console.error("❌ Error:", error);
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => console.log(`🚀 Premium VidScore Engine on ${port}`));
