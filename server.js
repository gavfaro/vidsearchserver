require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const { TwelveLabs } = require("twelvelabs-js");
const cors = require("cors");

const app = express();
const upload = multer({ dest: "uploads/" }); // Temporary storage
app.use(cors());

// Initialize Twelve Labs SDK
// The SDK automatically handles Multipart Uploads for large files (up to 4GB)
const client = new TwelveLabs({ apiKey: process.env.TWELVE_LABS_API_KEY });

app.post("/upload-and-index", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No video file provided" });
  }

  const indexId = req.body.indexId;
  const filePath = req.file.path;

  console.log(
    `📦 Received file: ${req.file.originalname} (${req.file.size} bytes)`
  );
  console.log(`🎯 Target Index: ${indexId}`);

  try {
    console.log("🚀 Starting Multipart Upload to Twelve Labs via SDK...");

    // The SDK's tasks.create method automatically detects file size
    // and switches to Multipart Upload if > 200MB.
    const task = await client.tasks.create({
      indexId: indexId,
      videoFile: fs.createReadStream(filePath),
      language: "en",
    });

    console.log(`✅ Upload initiated! Task ID: ${task.id}`);

    // Clean up local file
    fs.unlinkSync(filePath);

    // Return the Task ID to the iOS app so it can poll for status
    res.json({
      taskId: task.id,
      message: "Upload successful, indexing started.",
    });
  } catch (error) {
    console.error("❌ Upload failed:", error);
    // Clean up local file on error
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
