import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { TwelveLabs } from "twelvelabs-js";
import "dotenv/config";

const app = express();
const upload = multer({ dest: "/tmp/" });
const port = process.env.PORT || 3000;

// Validate API Key presence immediately
if (!process.env.TWELVE_LABS_API_KEY) {
  console.error(
    "❌ CRITICAL ERROR: TWELVE_LABS_API_KEY is missing in .env file"
  );
  process.exit(1); // Exit if no API key
}

const client = new TwelveLabs({
  apiKey: process.env.TWELVE_LABS_API_KEY,
});

app.use(cors());
app.use(express.json());

// --- SINGLE INDEX LOGIC ---
let GLOBAL_INDEX_ID = null;
const GLOBAL_INDEX_NAME = "VidTag";

// Function to find existing index or create a new one ONCE
const getOrCreateGlobalIndex = async () => {
  try {
    console.log(`Checking for existing index named "${GLOBAL_INDEX_NAME}"...`);

    // Try-catch around the list operation specifically
    let indexes;
    try {
      // SDK uses 'indexes' (plural), not 'index'
      indexes = await client.indexes.list();
    } catch (listError) {
      console.error("Error listing indexes:", listError.message);
      throw new Error(
        `Failed to list indexes. Check your API key and network connection. Details: ${listError.message}`
      );
    }

    // Handle different SDK response structures
    // API returns: { data: [...], page_info: {...} }
    const indexList = Array.isArray(indexes) ? indexes : indexes?.data || [];

    // SDK uses 'indexName' and 'id' fields (camelCase, not snake_case)
    const existingIndex = indexList.find(
      (i) => i.indexName === GLOBAL_INDEX_NAME
    );

    if (existingIndex) {
      console.log(
        `✅ Found existing index: ${existingIndex.indexName} (${existingIndex.id})`
      );
      GLOBAL_INDEX_ID = existingIndex.id;
    } else {
      console.log(
        `Index "${GLOBAL_INDEX_NAME}" not found. Creating new global index...`
      );

      // SDK expects: indexName (camelCase), models with modelName and modelOptions
      const newIndex = await client.indexes.create({
        indexName: GLOBAL_INDEX_NAME,
        models: [
          {
            modelName: "marengo2.7",
            modelOptions: ["visual", "audio"],
          },
          {
            modelName: "pegasus1.2",
            modelOptions: ["visual", "audio"],
          },
        ],
        addons: ["thumbnail"],
      });

      GLOBAL_INDEX_ID = newIndex.id;
      console.log(`✅ Created new index: ${GLOBAL_INDEX_ID}`);
    }
  } catch (error) {
    console.error("❌ Error initializing index:", error.message);
    console.error("Full error:", error);

    // Don't exit process, but log clearly
    console.error(
      "⚠️  Server will continue but video processing will fail until index is initialized"
    );
  }
};

// Initialize index on server start - with error handling
(async () => {
  try {
    await getOrCreateGlobalIndex();
  } catch (error) {
    console.error("Failed to initialize index on startup:", error);
  }
})();

// --- ROUTES ---

app.post("/generate-post", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No video file provided" });
  }

  // Ensure we have an index to upload to
  if (!GLOBAL_INDEX_ID) {
    console.log("Index not initialized, attempting to initialize now...");
    await getOrCreateGlobalIndex();

    if (!GLOBAL_INDEX_ID) {
      return res.status(500).json({
        error:
          "Server failed to initialize Index. Please check API key and try again.",
        details: "The TwelveLabs index could not be created or accessed.",
      });
    }
  }

  const filePath = req.file.path;
  const userPrompt =
    req.body.prompt || "Write a social media summary for this video.";
  const platform = req.body.platform || "Custom";

  try {
    console.log(`[1/3] Uploading Video to Index ${GLOBAL_INDEX_ID}...`);

    // SDK uses client.tasks.create (plural), not client.task.create
    const task = await client.tasks.create({
      indexId: GLOBAL_INDEX_ID,
      videoFile: fs.createReadStream(filePath),
    });

    const taskId = task.id || task._id;
    console.log(`[2/3] Indexing Task ID: ${taskId}. Waiting...`);

    // Poll for task completion
    let taskStatus;
    let attempts = 0;
    const maxAttempts = 150; // 5 minutes max (150 * 2 seconds)

    while (attempts < maxAttempts) {
      taskStatus = await client.tasks.retrieve(taskId);
      console.log(`  Status: ${taskStatus.status}`);

      if (taskStatus.status === "ready") {
        break;
      } else if (taskStatus.status === "failed") {
        throw new Error("Task failed during processing");
      }

      // Wait 2 seconds before checking again
      await new Promise((resolve) => setTimeout(resolve, 2000));
      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new Error("Task timed out after 5 minutes");
    }

    const videoId = taskStatus.videoId || taskStatus.video_id;
    console.log(`[3/3] Video Indexed: ${videoId}. Generating Content...`);

    // --- Generate Caption using analyze (open-ended analysis) ---
    const captionPromise = client.analyze({
      videoId: videoId,
      prompt: userPrompt,
      temperature: 0.7,
    });

    // --- Generate Hashtags using gist ---
    const hashtagPromise = client.gist({
      videoId: videoId,
      types: ["hashtag", "topic"],
    });

    const [captionResult, hashtagResult] = await Promise.all([
      captionPromise,
      hashtagPromise,
    ]);

    // Extract caption from analyze response
    const caption = captionResult.data || "";

    // Extract hashtags from gist response
    const hashtagsArray = hashtagResult.hashtags || [];
    const topicsArray = hashtagResult.topics || [];

    const responseData = {
      platform: platform,
      caption: caption.trim(),
      hashtags: hashtagsArray,
      topics: topicsArray,
    };

    console.log(
      `✅ Success! Caption: ${responseData.caption.substring(0, 50)}...`
    );

    // Clean up the uploaded file
    fs.unlink(filePath, (err) => {
      if (err) console.error("Error deleting temp file:", err);
    });

    res.json(responseData);
  } catch (error) {
    console.error("❌ Error processing video:", error);
    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, () => {});
    }
    res.status(500).json({
      error: error.message,
      details: "Video processing failed. Check server logs for details.",
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    indexInitialized: !!GLOBAL_INDEX_ID,
    indexId: GLOBAL_INDEX_ID,
  });
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
