import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { TwelveLabs } from "twelvelabs-js";
import "dotenv/config";

const app = express();
// Use /tmp/ for uploads on Render/Serverless environments as root may be read-only
const upload = multer({ dest: "/tmp/" });

// Render provides the port in the environment variables.
// Fallback to 3000 only for local testing.
const port = process.env.PORT || 3000;

// Initialize Twelve Labs Client
// Ensure TWELVE_LABS_API_KEY is set in Render "Environment Variables" settings
const client = new TwelveLabs({
  apiKey: process.env.TWELVE_LABS_API_KEY || "",
});

app.use(cors());
app.use(express.json());

// Helper: Select specific system prompt based on social platform
const getSystemPrompt = (platform) => {
  switch (platform) {
    case "Instagram":
      return "Write an engaging, fun Instagram caption for this video. Use emojis liberally. Keep it under 100 words. Focus on the visual vibe.";
    case "LinkedIn":
      return "Write a professional LinkedIn post based on this video. Focus on industry insights, key takeaways, and business value. Use a professional tone. No emojis.";
    case "TikTok":
      return "Write a viral TikTok caption. Keep it very short, punchy, and use Gen-Z slang if appropriate. Focus on the hook.";
    case "Twitter":
      return "Write a short, thread-style tweet summary of this video. Keep it under 280 characters. Be concise and witty.";
    default:
      return "Write a social media summary for this video.";
  }
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

    const index = await client.indexes.create({
      indexName: indexName,
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

    console.log(`[2/5] Index Created: ${index.id}. Uploading Video...`);

    const task = await client.tasks.create({
      indexId: index.id,
      videoFile: fs.createReadStream(filePath),
    });

    console.log(
      `[3/5] Indexing Task ID: ${task.id}. Waiting for completion...`
    );

    // Poll for completion
    await client.tasks.waitForDone(task.id, {
      sleepInterval: 5,
      callback: (taskUpdate) => {
        console.log(`  Status: ${taskUpdate.status}`);
      },
    });

    const videoId = task.videoId;
    console.log(`[4/5] Video Indexed: ${videoId}. Generating Content...`);

    // 1. Generate Caption using Open-Ended Analysis (Pegasus)
    const analysisResult = await client.analyze({
      videoId: videoId,
      prompt: getSystemPrompt(platform),
      temperature: 0.7,
    });

    // 2. Generate Hashtags using Gist (Marengo/Pegasus)
    const gistResult = await client.gist({
      videoId: videoId,
      types: ["hashtag", "topic"],
    });

    // Combine results
    const responseData = {
      platform: platform,
      caption: analysisResult.data,
      hashtags: gistResult.hashtags,
      topics: gistResult.topics,
    };

    console.log(`[5/5] Success! Sending response.`);

    // Cleanup: Delete local file
    fs.unlink(filePath, (err) => {
      if (err) console.error("Error deleting temp file:", err);
    });

    // Optional: Cleanup index to save costs
    // await client.indexes.delete(index.id);

    res.json(responseData);
  } catch (error) {
    console.error("Error processing video:", error);
    // Cleanup on error
    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, (err) => {
        if (err) console.error("Error deleting temp file on fail:", err);
      });
    }
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
