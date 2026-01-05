import { Router } from "express";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { dubVideo } from "../services/dub.service";
import { progressMap, outputMap } from "../utils/progress";
import { safeUnlink } from "../utils/temp";

const upload = multer({ dest: "tmp/" });
const router = Router();

/* START JOB */
router.post("/", upload.single("video"), async (req, res) => {
  const jobId = uuid();
  progressMap.set(jobId, 0);

  dubVideo(req.file!.path, jobId).catch(err => {
    console.error(err);
    progressMap.set(jobId, -1);
  });

  res.json({ jobId });
});

/* PROGRESS STREAM */
router.get("/progress/:id", (req, res) => {
  const { id } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const timer = setInterval(() => {
    const progress = progressMap.get(id) ?? 0;
    res.write(`data: ${progress}\n\n`);

    if (progress >= 100 || progress < 0) {
      clearInterval(timer);
      res.end();
    }
  }, 1000);
});

/* DOWNLOAD */
router.get("/download", (req, res) => {
  const jobId = req.query.job as string;
  const file = outputMap.get(jobId);

  if (!file) return res.status(404).end();

  res.download(file, "dubbed.mp4", () => {
    safeUnlink(file);
    outputMap.delete(jobId);
    progressMap.delete(jobId);
  });
});

export default router;
