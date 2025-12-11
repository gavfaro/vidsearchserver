import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import "dotenv/config";

const app = express();
const upload = multer({ dest: "/tmp/" });
const port = process.env.PORT || 3000;

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
  res.send("Scanning Video 🚀");
});

app.post("/analyze-video", upload.single("video"), async (req, res) => {
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
    console.warn(
      `Warning: Uploaded mimeType ${mimeType} is not explicitly in supported list, attempting generic video/mp4 fallback.`
    );
  }

  try {
    // 1. Parse Inputs
    const userAudience = req.body.audience || "General Audience";
    const platform = req.body.platform || "TikTok";
    const customSystemPrompt =
      req.body.system_prompt || "Analyze for viral potential.";

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

    // 2. Upload Video to Gemini File Manager
    // Starting slightly higher since upload to server is done
    sendEvent("progress", {
      message: "Sending to AI Engine...",
      progress: 0.1,
    });

    const uploadResult = await fileManager.uploadFile(filePath, {
      mimeType: mimeType || "video/mp4",
      displayName: `VidScore_${Date.now()}`,
    });

    const fileUri = uploadResult.file.uri;
    const fileName = uploadResult.file.name;

    console.log(`Uploaded file: ${fileName} (${fileUri})`);

    // 3. Wait for Processing (Dynamic Progress)
    // We increment this from 0.2 up to 0.6 while waiting
    let fileState = uploadResult.file.state;
    let processingProgress = 0.2;

    sendEvent("progress", {
      message: "AI is watching video...",
      progress: processingProgress,
    });

    while (fileState === FileState.PROCESSING) {
      await sleep(2000); // Check every 2 seconds

      // Increment progress slightly to show activity, cap at 0.6
      if (processingProgress < 0.6) {
        processingProgress += 0.05;
        sendEvent("progress", {
          message: "AI is processing frames...",
          progress: Number(processingProgress.toFixed(2)),
        });
      }

      const fileStatus = await fileManager.getFile(fileName);
      fileState = fileStatus.state;
      console.log(`File processing status: ${fileState}`);

      if (fileState === FileState.FAILED) {
        throw new Error("Video processing failed on Gemini servers.");
      }
    }

    // 4. Construct Prompt
    sendEvent("progress", {
      message: "Drafting analysis...",
      progress: 0.65,
    });

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

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      },
    });

    // 5. Generate Content with STREAMING
    // This allows us to tick progress (0.7 -> 0.9) as tokens generate
    const resultStream = await model.generateContentStream([
      {
        fileData: {
          mimeType: uploadResult.file.mimeType,
          fileUri: fileUri,
        },
      },
      { text: geminiPrompt },
    ]);

    let fullResponseText = "";
    let chunkCount = 0;
    let generationProgress = 0.7;

    for await (const chunk of resultStream.stream) {
      const chunkText = chunk.text();
      fullResponseText += chunkText;
      chunkCount++;

      // Update progress every few chunks to avoid flooding the client
      // Cap at 0.95 so we don't hit 100% prematurely
      if (chunkCount % 2 === 0 && generationProgress < 0.95) {
        generationProgress += 0.02;
        sendEvent("progress", {
          message: "Generating insights...",
          progress: Number(generationProgress.toFixed(2)),
        });
      }
    }

    // 6. Parse Final JSON
    const finalJson = JSON.parse(fullResponseText);

    // 7. Complete
    sendEvent("complete", { result: finalJson });
    res.end();

    // Cleanup
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error("Server Error:", err);
    sendEvent("error", { message: err.message || "Internal Server Error" });
    res.end();

    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
});

app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
