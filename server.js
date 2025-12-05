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
      indexes = await client.index.list();
    } catch (listError) {
      console.error("Error listing indexes:", listError.message);
      throw new Error(
        `Failed to list indexes. Check your API key and network connection. Details: ${listError.message}`
      );
    }

    // Handle different SDK response structures
    // API returns: { data: [...], page_info: {...} }
    const indexList = Array.isArray(indexes) ? indexes : indexes?.data || [];

    // API uses 'index_name' and '_id' fields
    const existingIndex = indexList.find(
      (i) => i.index_name === GLOBAL_INDEX_NAME
    );

    if (existingIndex) {
      console.log(
        `✅ Found existing index: ${existingIndex.index_name} (${existingIndex._id})`
      );
      GLOBAL_INDEX_ID = existingIndex._id;
    } else {
      console.log(
        `Index "${GLOBAL_INDEX_NAME}" not found. Creating new global index...`
      );

      // API expects: index_name, models (with model_name and model_options)
      const newIndex = await client.index.create({
        index_name: GLOBAL_INDEX_NAME,
        models: [
          {
            model_name: "marengo3.0",
            model_options: ["visual", "audio"],
          },
          {
            model_name: "pegasus1.2",
            model_options: ["visual", "audio"],
          },
        ],
        addons: ["thumbnail"],
      });

      GLOBAL_INDEX_ID = newIndex._id;
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

// --- PROMPTS ---

const getHashtagPrompt = () => {
  return `
    Generate 7 to 10 viral, relevant hashtags for this video. 
    Focus strictly on the actions, the emotions, the objects, and the funny moments. 
    DO NOT generate hashtags about the video quality. 
    Return ONLY the hashtags separated by spaces (e.g. #rain #funny #lol).
  `;
};

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

    const task = await client.task.create({
      indexId: GLOBAL_INDEX_ID,
      file: fs.createReadStream(filePath),
    });

    console.log(`[2/3] Indexing Task ID: ${task.id}. Waiting...`);

    await task.waitForDone({
      sleepInterval: 2,
      callback: (taskUpdate) => {
        console.log(`  Status: ${taskUpdate.status}`);
      },
    });

    const videoId = task.videoId;
    console.log(`[3/3] Video Indexed: ${videoId}. Generating Content...`);

    // --- Generate Caption and Hashtags in parallel ---
    const captionPromise = client.generate.text({
      videoId: videoId,
      prompt: userPrompt,
      temperature: 0.7,
    });

    const hashtagPromise = client.generate.text({
      videoId: videoId,
      prompt: getHashtagPrompt(),
      temperature: 0.5,
    });

    const [captionResult, hashtagResult] = await Promise.all([
      captionPromise,
      hashtagPromise,
    ]);

    const rawHashtags = hashtagResult.data || "";

    const hashtagsArray = rawHashtags
      .replace(/#/g, "")
      .replace(/,/g, " ")
      .split(/\s+/)
      .filter((tag) => tag.length > 2)
      .slice(0, 10);

    const responseData = {
      platform: platform,
      caption: captionResult.data.trim(),
      hashtags: hashtagsArray,
      topics: hashtagsArray,
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
