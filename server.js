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
}

const client = new TwelveLabs({
  apiKey: process.env.TWELVE_LABS_API_KEY || "",
});

app.use(cors());
app.use(express.json());

// --- SINGLE INDEX LOGIC ---
// We will store the Index ID here so we don't keep creating new ones.
let GLOBAL_INDEX_ID = null;
const GLOBAL_INDEX_NAME = "VidTag"; // Updated Index Name

// Function to find existing index or create a new one ONCE
const getOrCreateGlobalIndex = async () => {
  try {
    // Safety check: Ensure the SDK client is properly initialized
    if (!client.index) {
      throw new Error(
        "TwelveLabs SDK 'index' property is undefined. Check your API Key and SDK version."
      );
    }

    console.log(`Checking for existing index named "${GLOBAL_INDEX_NAME}"...`);
    const indexes = await client.index.list();

    // Check if our specific index already exists
    // Note: Adjust based on SDK response structure if needed (e.g. some versions return array directly)
    const indexList = Array.isArray(indexes) ? indexes : indexes.data || [];
    const existingIndex = indexList.find((i) => i.name === GLOBAL_INDEX_NAME);

    if (existingIndex) {
      console.log(
        `Found existing index: ${existingIndex.name} (${existingIndex.id})`
      );
      GLOBAL_INDEX_ID = existingIndex.id;
    } else {
      console.log(
        `Index "${GLOBAL_INDEX_NAME}" not found. Creating new global index...`
      );
      const newIndex = await client.index.create({
        name: GLOBAL_INDEX_NAME,
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
      });
      GLOBAL_INDEX_ID = newIndex.id;
      console.log(`Created new index: ${GLOBAL_INDEX_ID}`);
    }
  } catch (error) {
    console.error("Error initializing index:", error);
  }
};

// Initialize index on server start
getOrCreateGlobalIndex();

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
    await getOrCreateGlobalIndex(); // Try one more time if it failed at startup
    if (!GLOBAL_INDEX_ID) {
      return res
        .status(500)
        .json({ error: "Server failed to initialize Index" });
    }
  }

  const filePath = req.file.path;
  // We now accept the custom prompt directly from the UI
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
      sleepInterval: 2, // Check every 2 seconds
      callback: (taskUpdate) => {
        console.log(`  Status: ${taskUpdate.status}`);
      },
    });

    const videoId = task.videoId;
    console.log(`[3/3] Video Indexed: ${videoId}. Generating Content...`);

    // --- STEP 1: Generate Caption (Pegasus) ---
    // Use the USER PROVIDED prompt
    const captionPromise = client.generate.text({
      videoId: videoId,
      prompt: userPrompt,
      temperature: 0.7,
    });

    // --- STEP 2: Generate Hashtags (Pegasus) ---
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
      `Success! Caption: ${responseData.caption.substring(0, 20)}...`
    );

    // Clean up the uploaded file
    fs.unlink(filePath, (err) => {
      if (err) console.error("Error deleting temp file:", err);
    });

    // Note: We DO NOT delete the index anymore. We keep it for the next request.

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
