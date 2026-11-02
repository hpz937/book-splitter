import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseEpub } from "./epub.js";
import { parsePdf } from "./pdf.js";
import { parseText } from "./text.js";

const run = promisify(execFile);

export const NATIVE = { ".epub": parseEpub, ".pdf": parsePdf, ".txt": parseText, ".md": parseText, ".markdown": parseText };
export const VIA_CALIBRE = [".mobi", ".azw", ".azw3", ".prc", ".fb2", ".docx", ".rtf", ".odt", ".lit", ".pdb", ".html", ".htm"];

/** Parse any supported ebook into { title, author, format, chapters[], warnings[] }. */
export async function parseBook(file, opts, { workDir, hash }) {
  const ext = path.extname(file).toLowerCase();
  if (NATIVE[ext]) return NATIVE[ext](file, opts);
  if (VIA_CALIBRE.includes(ext)) {
    const out = path.join(workDir, "converted", `${hash}.epub`);
    if (!existsSync(out)) {
      await mkdir(path.dirname(out), { recursive: true });
      const bin = process.env.EBOOK_CONVERT || "ebook-convert";
      try {
        await run(bin, [file, out], { timeout: 5 * 60_000, maxBuffer: 64 * 1024 * 1024 });
      } catch (err) {
        if (err.code === "ENOENT") {
          throw new Error(`${ext} files need Calibre's \`ebook-convert\` on PATH (or set EBOOK_CONVERT). Install Calibre from https://calibre-ebook.com.`);
        }
        throw new Error(`ebook-convert failed: ${err.stderr?.toString().slice(-500) || err.message}`);
      }
    }
    const book = await parseEpub(out, opts);
    return { ...book, format: `${ext.slice(1)} (via calibre)` };
  }
  throw new Error(`Unsupported file type "${ext}". Supported: ${[...Object.keys(NATIVE), ...VIA_CALIBRE].join(", ")}`);
}
