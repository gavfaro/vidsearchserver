import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import "dotenv/config";

const app = express();
const port = process.env.PORT || 3000;

// MARK: - 1. Configure Multer with 50MB Limit
const upload = multer({
  dest: "/tmp/",
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB in bytes
  },
});

// MARK: - API Key Validation
if (!process.env.GEMINI_API_KEY) {
  console.error("❌ Missing GEMINI_API_KEY in .env");
  process.exit(1);
}

// MARK: - Client Initialization
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

// MARK: - Middleware
app.use(cors());
app.use(express.json());

// MARK: - Helper Functions
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// MARK: - Upload Middleware Wrapper
// This catches the "File Too Large" error before it crashes the request
const uploadMiddleware = (req, res, next) => {
  const uploadSingle = upload.single("video");

  uploadSingle(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      // A Multer error occurred when uploading.
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: "File too large. Maximum size is 50MB.",
          type: "limit_error",
        });
      }
      return res.status(400).json({ error: err.message });
    } else if (err) {
      // An unknown error occurred when uploading.
      return res.status(500).json({ error: "Upload failed: " + err.message });
    }
    // Everything went fine.
    next();
  });
};

// Supported MIME types from Gemini Docs
const SUPPORTED_VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/mpeg",
  "video/mov",
  "video/avi",
  "video/x-flv",
  "video/mpg",
  "video/webm",
  "video/wmv",
  "video/3gpp",
];

// MARK: - Schema Definitions (Gemini)
const metricScoreSchema = {
  type: SchemaType.OBJECT,
  properties: {
    key: {
      type: SchemaType.STRING,
      description: "The internal key identifier provided in the prompt",
    },
    label: {
      type: SchemaType.STRING,
      description: "The human readable name of the metric",
    },
    score: { type: SchemaType.INTEGER, description: "The score from 0-100" },
    reason: {
      type: SchemaType.STRING,
      description:
        "A short explanation (10-15 words) of why this score was given",
    },
  },
  required: ["key", "label", "score"],
};

const responseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    scores: {
      type: SchemaType.ARRAY,
      items: metricScoreSchema,
    },
    analysis: {
      type: SchemaType.OBJECT,
      properties: {
        overallScore: { type: SchemaType.INTEGER },
        targetAudienceAnalysis: { type: SchemaType.STRING },
        strengths: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              title: { type: SchemaType.STRING },
              description: { type: SchemaType.STRING },
            },
          },
        },
        weaknesses: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              title: { type: SchemaType.STRING },
              description: { type: SchemaType.STRING },
            },
          },
        },
        tips: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              title: { type: SchemaType.STRING },
              description: { type: SchemaType.STRING },
            },
          },
        },
      },
    },
    metadata: {
      type: SchemaType.OBJECT,
      properties: {
        caption: { type: SchemaType.STRING },
        hashtags: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
        },
      },
    },
  },
};

// MARK: - Routes
app.get("/", (req, res) => {
  res.send("VidScore Server Running (Gemini 2.5 Vision) 🚀");
});

// UPDATED: Using 'uploadMiddleware' instead of 'upload.single("video")' directly
app.post("/analyze-video", uploadMiddleware, async (req, res) => {
  const filePath = req.file?.path;
  const mimeType = req.file?.mimetype;

  // Initialize SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  if (!req.file || !filePath) {
    sendEvent("error", { message: "Missing video file" });
    res.end();
    return;
  }

  // Validate File Type
  if (mimeType && !SUPPORTED_VIDEO_MIME_TYPES.includes(mimeType)) {
    // Fallback for generic binary/octet-stream if mostly likely video, otherwise warn
    console.warn(
      `Warning: Uploaded mimeType ${mimeType} is not explicitly in supported list, attempting generic video/mp4 fallback.`
    );
  }

  try {
    // 1. Parse Context Inputs
    const userAudience = req.body.audience || "General Audience";
    const platform = req.body.platform || "TikTok";
    const customSystemPrompt =
      req.body.system_prompt || "Analyze for viral potential.";

    // 2. Parse Dynamic Metrics
    let customMetrics = [];
    if (req.body.metric_context) {
      try {
        customMetrics = JSON.parse(req.body.metric_context);
      } catch (e) {
        console.error("Failed to parse metric_context", e);
      }
    }

    if (customMetrics.length === 0) {
      customMetrics = [
        {
          key: "potential",
          name: "Viral Potential",
          context: "Likelihood of sharing",
        },
        { key: "hook", name: "Hook", context: "First 3 seconds impact" },
      ];
    }

    // 3. Upload Video to Gemini File Manager
    sendEvent("progress", {
      message: "Uploading to Gemini 2.5...",
      progress: 0.2,
    });

    const uploadResult = await fileManager.uploadFile(filePath, {
      // Use the detected mimeType or fallback to mp4
      mimeType: mimeType || "video/mp4",
      displayName: `VidScore_${Date.now()}`,
    });

    const fileUri = uploadResult.file.uri;
    const fileName = uploadResult.file.name;

    console.log(`Uploaded file: ${fileName} (${fileUri})`);

    // 4. Wait for Processing
    sendEvent("progress", {
      message: "Processing video frames...",
      progress: 0.4,
    });

    let fileState = uploadResult.file.state;
    while (fileState === FileState.PROCESSING) {
      await sleep(2000); // Check every 2 seconds
      const fileStatus = await fileManager.getFile(fileName);
      fileState = fileStatus.state;
      console.log(`File processing status: ${fileState}`);

      if (fileState === FileState.FAILED) {
        throw new Error("Video processing failed on Gemini servers.");
      }
    }

    sendEvent("progress", {
      message: "Analyzing with Gemini 2.5...",
      progress: 0.7,
    });

    // 5. Construct Prompt
    const metricInstructions = customMetrics
      .map(
        (m) =>
          `- Metric Key: "${m.key}"\n   - Display Name: "${m.name}"\n   - Evaluation Logic: ${m.context}`
      )
      .join("\n");

    const geminiPrompt = `
      You are an expert creative director for social media.
      
      === YOUR GOAL ===
      ${customSystemPrompt}

      === CONTEXT ===
      Target Audience: "${userAudience}"
      Platform: "${platform}"

      === SCORING TASKS ===
      Watch the attached video carefully.
      Evaluate the video based on the following CUSTOM METRICS.
      You MUST return an array in the JSON output under "scores", maintaining the exact "key" identifiers provided below.

      ${metricInstructions}

      === INSTRUCTIONS ===
      1. Analyze the video visuals, audio, and pacing against the metric logic.
      2. Provide a score (0-100) and a short reasoning for each metric.
      3. Generate an overall analysis, strengths, weaknesses, and tips.
      4. Suggest a caption and hashtags.
      5. Output pure JSON matching the schema.
    `;

    // 6. Call Gemini
    // UPDATED: Using gemini-2.5-flash per documentation
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      },
    });

    const result = await model.generateContent([
      {
        fileData: {
          mimeType: uploadResult.file.mimeType,
          fileUri: fileUri,
        },
      },
      { text: geminiPrompt },
    ]);

    const responseText = result.response.text();
    const finalJson = JSON.parse(responseText);

    // 7. Complete
    sendEvent("complete", { result: finalJson });
    res.end();

    // Cleanup local temp file
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Optional: Delete from Google Servers to save storage
    // await fileManager.deleteFile(fileName);
  } catch (err) {
    console.error("Server Error:", err);
    sendEvent("error", { message: err.message || "Internal Server Error" });
    res.end();

    // Cleanup temp file if exists
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
});

app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
