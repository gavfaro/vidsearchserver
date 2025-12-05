import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { TwelveLabs } from "twelvelabs-js";
import "dotenv/config";

const app = express();
const upload = multer({ dest: "/tmp/" });
const port = process.env.PORT || 3000;

const client = new TwelveLabs({
  apiKey: process.env.TWELVE_LABS_API_KEY || "",
});

app.use(cors());
app.use(express.json());

// 1. IMPROVED: Context-aware system prompts for Captions
const getCaptionPrompt = (platform) => {
  switch (platform) {
    case "Instagram":
      return "Write an engaging, fun Instagram caption for this video. Use emojis liberally. Keep it under 100 words. Focus on the visual vibe and the fun parts.";
    case "LinkedIn":
      return "Write a professional LinkedIn post based on this video. Focus on the lesson learned or the activity shown. Professional tone.";
    case "TikTok":
      return "Write a viral TikTok caption (POV style). Keep it very short, punchy. Focus on the humor or the hook.";
    case "Twitter":
      return "Write a short tweet about this video. Be concise and witty.";
    default:
      return "Write a social media summary for this video.";
  }
};

// 2. NEW: Specific Prompt for Hashtags to fix the "#PoorAudio" issue
// We explicitly tell the AI to ignore technical quality.
const getHashtagPrompt = () => {
  return `
    Generate 7 to 10 viral, relevant hashtags for this video. 
    Focus strictly on the actions, the emotions, the objects, and the funny moments. 
    DO NOT generate hashtags about the video quality (e.g. ignore poor audio, ignore blur, ignore lighting). 
    Return ONLY the hashtags separated by spaces (e.g. #rain #funny #lol).
  `;
};

app.post("/generate-post", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No video file provided" });
  }

  const filePath = req.file.path;
  const platform = req.body.platform || "Instagram";
  const indexName = `social-gen-${Date.now()}`;

  try {
    console.log(`[1/5] Creating Index for platform: ${platform}...`);

    // We only strictly need Marengo for indexing, but Pegasus (generative) needs to be enabled
    const index = await client.indexes.create({
      indexName: indexName,
      models: [
        {
          modelName: "marengo2.7", // Using 2.7 or 2.6 is often faster/cheaper for indexing, adjust as needed
          modelOptions: ["visual", "audio"],
        },
        {
          modelName: "pegasus1.2", // Essential for the 'analyze' call
          modelOptions: ["visual", "audio"],
        },
      ],
    });

    console.log(`[2/5] Index Created: ${index.id}. Uploading Video...`);

    const task = await client.tasks.create({
      indexId: index.id,
      videoFile: fs.createReadStream(filePath),
    });

    console.log(`[3/5] Indexing Task ID: ${task.id}. Waiting...`);

    await client.tasks.waitForDone(task.id, {
      sleepInterval: 5,
      callback: (taskUpdate) => {
        console.log(`  Status: ${taskUpdate.status}`);
      },
    });

    const videoId = task.videoId;
    console.log(`[4/5] Video Indexed: ${videoId}. Generating Content...`);

    // --- STEP 1: Generate Caption (Pegasus) ---
    const captionPromise = client.analyze({
      videoId: videoId,
      prompt: getCaptionPrompt(platform),
      temperature: 0.7,
    });

    // --- STEP 2: Generate Hashtags (Pegasus) ---
    // REPLACED client.gist with client.analyze
    const hashtagPromise = client.analyze({
      videoId: videoId,
      prompt: getHashtagPrompt(),
      temperature: 0.5, // Lower temp for more relevant/focused tags
    });

    // Run both AI requests in parallel for speed
    const [captionResult, hashtagResult] = await Promise.all([
      captionPromise,
      hashtagPromise,
    ]);

    // Parse the AI text output into an array of strings
    // The AI usually returns "#tag1 #tag2", so we split by space
    const rawHashtags = hashtagResult.data || "";

    // Cleanup: Remove existing # symbols to clean up, then split, filter empty
    const hashtagsArray = rawHashtags
      .replace(/#/g, "") // Remove # if the AI added them
      .replace(/,/g, " ") // Replace commas with spaces if AI added them
      .split(/\s+/) // Split by whitespace
      .filter((tag) => tag.length > 2) // Remove tiny artifacts
      .slice(0, 10); // Limit to 10

    const responseData = {
      platform: platform,
      caption: captionResult.data.trim(),
      hashtags: hashtagsArray,
      // We pass empty topics or copy hashtags because your Swift Struct expects this field
      topics: hashtagsArray,
    };

    console.log(
      `[5/5] Success! Caption: ${responseData.caption.substring(0, 20)}...`
    );

    fs.unlink(filePath, (err) => {
      if (err) console.error("Error deleting temp file:", err);
    });

    // Cleanup index (Recommended for production to save costs/clutter)
    // await client.indexes.delete(index.id);

    res.json(responseData);
  } catch (error) {
    console.error("Error processing video:", error);
    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, () => {});
    }
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
