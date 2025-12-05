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
const GLOBAL_INDEX_NAME = "VidScore_Server";

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
      console.log(
        `✅ Found existing index: ${GLOBAL_INDEX_NAME} (${GLOBAL_INDEX_ID})`
      );
    } else {
      console.log(
        `Index ${GLOBAL_INDEX_NAME} not found. Creating new one with Marengo 3.0...`
      );
      const newIndex = await client.indexes.create({
        indexName: GLOBAL_INDEX_NAME,
        models: [
          {
            modelName: "marengo3.0",
            modelOptions: ["visual", "audio", "text_in_video"],
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

(async () => {
  await getOrCreateGlobalIndex();
})();

// --- 2. NICHE RULES ENGINE (HYBRID) ---
const getNicheContext = (audience) => {
  const normalizedAudience = audience ? audience.toLowerCase() : "general";

  // Hardcoded rules for high-value niches
  const rules = {
    "real estate": `
- VISUALS: Look for high-quality wide angles, smooth drone shots, or bright interior lighting.
- PACING: Should be elegant and smooth, not frantic.
- HOOK: Must show the "hero shot" (front of house or best room) immediately or overlay text with price/location.
- AUDIO: clear voiceover or trending luxury audio.
- FAILURE POINTS: Dark lighting, shaky camera, clutter in rooms.
`,
    fitness: `
- VISUALS: Needs to show physique or movement clearly.
- PACING: Fast, energetic, cuts on the beat of the music.
- HOOK: Needs to show the "result" (the six-pack) or the "struggle" (the heavy weight) in the first second.
- AUDIO: High energy music or ASMR gym sounds.
- FAILURE POINTS: Bad form, boring rest periods left in, bad camera angle.
`,
    tech: `
- VISUALS: Clean desk setup, clear screen recordings, high contrast.
- PACING: Very fast, information-dense.
- HOOK: Show the "cool gadget" or the "final code result" immediately.
- AUDIO: Crisp voiceover is mandatory.
- FAILURE POINTS: Blurry screens, slow typing, monotone voice.
`,
    beauty: `
- VISUALS: Perfect lighting (ring light), close-ups of texture.
- PACING: Transitions (swipes, finger snaps) are critical.
- HOOK: Before/After result shown instantly.
- FAILURE POINTS: Bad color grading, messy background.
`,
    business: `
- VISUALS: Talking head, but must have dynamic captions.
- PACING: No pauses. "Millennial Pause" at start is a critical failure.
- HOOK: A controversial statement or a specific "How to" promise.
- FAILURE POINTS: looking away from camera, slow start, boring background.
`,
    pets: `
- VISUALS: Cute close-ups, funny movements.
- PACING: Chaos is good.
- HOOK: The funny action must happen immediately.
- FAILURE POINTS: Human talking too much, camera too far away.
`,
  };

  // 1. Check strict hardcoded matches
  for (const [key, value] of Object.entries(rules)) {
    if (normalizedAudience.includes(key)) return value;
  }

  // 2. Dynamic Handle: User typed something specific
  if (normalizedAudience !== "general" && normalizedAudience !== "") {
    return `
- CONTEXT: The user explicitly stated this video is for the "${audience}" niche.
- INSTRUCTION: Use your internal knowledge of ${audience} content on social media.
- CRITERIA: Judge the hook, pacing, and visuals based on what currently performs well for ${audience}.
`;
  }

  // 3. Fallback
  return `
- VISUALS: Clear, bright, high definition.
- PACING: Remove all dead air and pauses.
- HOOK: Visual movement or text overlay in first 3 seconds.
`;
};

// --- 3. AUTO-DETECT NICHE HELPER ---
const detectVideoNiche = async (videoId) => {
  try {
    // ✅ FIX: Switched from client.generate.text to client.analyze
    const result = await client.analyze({
      videoId: videoId,
      prompt: `
Analyze this video and categorize it into exactly one of these niches:
'Real Estate', 'Fitness', 'Tech', 'Beauty', 'Business', 'Pets'.
If it is clearly one of these, return ONLY the category name.
If it does not fit these but has a clear theme, return that theme name (e.g. 'Cooking', 'Gaming').
If it is unclear, return 'General'.
`,
      temperature: 0.1,
    });

    // Ensure we handle result.data correctly depending on SDK version
    const detected = (result.data || result.content || "").trim();
    console.log(`🤖 AI Auto-Detected Niche: ${detected}`);
    return detected;
  } catch (e) {
    console.log("Auto-detect failed, defaulting to General. Error:", e.message);
    return "General";
  }
};

// --- 4. THE PROMPT ---
const GENERATE_PREMIUM_PROMPT = (audience, platform, nicheInstructions) => `
You are a top-tier Viral Video Consultant for ${platform} specializing in the "${audience}" niche.
Your goal is to critique this video specifically against the standards of top performers in ${audience}.

*** NICHE SPECIFIC STANDARDS FOR ${audience.toUpperCase()} ***
${nicheInstructions}
************************************************************

Step 1: Analyze the "Hook" (0:00 to 0:03) based on the Niche Standards above.
- Does it match the niche expectation? (e.g., Luxury Real Estate needs elegance, Fitness needs energy).
- Is the text/visual clear?

Step 2: Analyze Technical Execution.
- Lighting, Composition, and Audio Quality compared to top ${audience} creators.

Step 3: Provide Analytics.
Generate a strict JSON response.
Rules:
- "hookAnalysis": Be specific to the niche. (e.g., "For a Real Estate video, this pan was too fast/shaky").
- "virality": Compare it to viral hits in this specific category.

Output format (Raw JSON only):
{
"overallScore": (integer 0-100),
"hookScore": (integer 0-10),
"visualScore": (integer 0-10),
"audioScore": (integer 0-10),
"audienceMatchScore": (integer 0-10),
"predictedRetention": [100, 85, 70, 60, 50, 40],
"hookAnalysis": {
"status": "Weak" | "Strong",
"timestamp": "0:00-0:03",
"feedback": "Critique based on niche standards."
},
"criticalIssues": [
"Issue 1",
"Issue 2"
],
"actionableFixes": [
"Fix 1",
"Fix 2"
],
"captionSuggestion": "Viral caption relevant to niche",
"viralPotential": "Low" | "Medium" | "High"
}
`;

app.post("/analyze-video", upload.single("video"), async (req, res) => {
  if (!req.file || !GLOBAL_INDEX_ID)
    return res.status(400).json({ error: "System not ready" });

  const filePath = req.file.path;
  let { audience, platform } = req.body;

  try {
    console.log(`[1] Uploading...`);
    const task = await client.tasks.create({
      indexId: GLOBAL_INDEX_ID,
      videoFile: fs.createReadStream(filePath),
    });

    console.log(`[2] Processing Task: ${task.id}`);

    let attempts = 0;
    let videoId = null;
    while (attempts < 60) {
      const status = await client.tasks.retrieve(task.id);
      if (status.status === "ready") {
        videoId = status.videoId;
        break;
      }
      if (status.status === "failed") {
        throw new Error(
          `Processing failed: ${status.processStatus || "Unknown error"}`
        );
      }
      await new Promise((r) => setTimeout(r, 2000));
      attempts++;
    }

    if (!videoId) throw new Error("Processing Timeout");

    // --- HYBRID LOGIC ---
    const isUserProvided =
      audience &&
      audience.trim() !== "" &&
      audience.toLowerCase() !== "general" &&
      audience.toLowerCase() !== "unknown";

    if (!isUserProvided) {
      console.log("[3a] No audience provided. Auto-detecting...");
      audience = await detectVideoNiche(videoId);
    } else {
      console.log(`[3a] User manually specified: ${audience}`);
    }

    const nicheInstructions = getNicheContext(audience);

    // ✅ FIX: Switched from client.generate.text to client.analyze
    const result = await client.analyze({
      videoId: videoId,
      prompt: GENERATE_PREMIUM_PROMPT(audience, platform, nicheInstructions),
      temperature: 0.2, // Low temp for JSON consistency
    });

    // Handle data structure safely
    let rawText = result.data || result.content || "";

    rawText = rawText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    let analysisData;
    try {
      analysisData = JSON.parse(rawText);
    } catch (e) {
      console.error("JSON Parse Error:", rawText);
      throw new Error("AI generated invalid format. Please try again.");
    }

    analysisData.detectedAudience = audience;

    try {
      const gistResult = await client.gist({
        videoId: videoId,
        types: ["hashtag", "topic"],
      });
      analysisData.hashtags = gistResult.hashtags || [];
      analysisData.topics = gistResult.topics || [];
    } catch (err) {
      console.log("Gist generation skipped:", err.message);
      analysisData.hashtags = [];
    }

    console.log("✅ Analysis Complete");
    fs.unlink(filePath, () => {});
    res.json(analysisData);
  } catch (error) {
    console.error("❌ Error:", error);
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

app.listen(port, () => console.log(`🚀 VidScore Premium Engine on ${port}`));
