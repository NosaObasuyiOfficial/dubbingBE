import fs from "fs";
import os from "os";
import path from "path";

export function tempFile(ext: string) {
  return path.join(os.tmpdir(), `${Date.now()}-${Math.random()}${ext}`);
}

export function safeUnlink(file?: string) {
  if (file && fs.existsSync(file)) fs.unlinkSync(file);
}
