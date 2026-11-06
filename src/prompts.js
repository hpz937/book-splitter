// Built-in MCP prompts. Each one resolves the book first (by path or search words), so the model starts
// with the book_id, the chunk list and a note budget that fits the book, instead of generic instructions.
import path from "node:path";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { z } from "zod";
import { findBooks, loadBook } from "./library.js";
import { bookPages, chunkPageRanges } from "./pages.js";

// ---------------------------------------------------------------------------- arguments

const bookArg = completable(
  z.string().describe("The book: words to search for (e.g. 'dune herbert'), a path inside the book folder, or a full path"),
  async (value) => {
    try {
      const { files, searched } = await findBooks({ query: value ?? "", limit: 20 });
      return files.map((f) => {
        const root = searched.find((r) => f.path.startsWith(r + path.sep));
        return root ? path.relative(root, f.path) : f.path;
      });
    } catch {
      return [];
    }
  },
);
const choice = (options, description) =>
  completable(z.string().optional().describe(description), (v) => options.filter((o) => o.startsWith((v ?? "").toLowerCase())));
const upToArg = z.string().optional().describe(
  "Only read up to here, e.g. 'chapter 12', 'page 240', or a chapter title. For readers who haven't finished the book.");

// ---------------------------------------------------------------------------- helpers

async function resolveBook(arg) {
  try {
    return { book: await loadBook(arg) };
  } catch (err) {
    if (!/^Not found/.test(err.message)) return { error: err.message };
  }
  try {
    const { files } = await findBooks({ query: arg, limit: 10 });
    if (files.length === 1) return { book: await loadBook(files[0].path) };
    if (files.length > 1) return { choices: files.map((f) => f.path) };
    return { error: `No book file matches "${arg}".` };
  } catch (err) {
    return { error: err.message };
  }
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));
const fmt = (n) => n.toLocaleString("en-US");

function bookContext(book) {
  const ranges = chunkPageRanges(book, book.wordsPerPage);
  const pg = bookPages(book, book.wordsPerPage);
  const pages = pg.count ? `${fmt(pg.count)} pages` : `~${fmt(pg.estimate)} pages (estimated)`;
  const rows = book.chunks.slice(0, 400).map((c) =>
    `${c.index} · ${c.path?.length ? c.path.join(" › ") + " › " : ""}${c.title}` +
    `${c.parts > 1 ? ` (part ${c.part}/${c.parts})` : ""} · ${ranges[c.index]} · ${fmt(c.words ?? 0)} words`);
  if (book.chunks.length > 400) rows.push(`… ${book.chunks.length - 400} more — call load_book to see the full list.`);
  return `## The book
**${book.title}**${book.author ? ` by ${book.author}` : ""} — book_id \`${book.id}\`
${book.chunks.length} chunks in ${book.chapterCount} chapters · ~${fmt(book.words ?? 0)} words · ${pages}

Chunk list (index · title · pages · words):
${rows.join("\n")}

Chunks marked "part n/m" are consecutive pieces of one chapter. Page numbers starting with "~" are estimates.`;
}

/** Build the user message. Falls back to find/load instructions if the book couldn't be resolved here. */
async function buildPrompt(arg, plan) {
  const r = await resolveBook(arg);
  let intro;
  let n;
  if (r.book) {
    n = r.book.chunks.length;
    intro = bookContext(r.book);
  } else {
    n = 40; // unknown yet; the budget below is a reasonable default
    intro = r.choices
      ? `## The book
Several files match "${arg}":
${r.choices.map((c) => `- ${c}`).join("\n")}

Ask the user which one they mean, then call load_book with that path and use its book_id and chunk list below.`
      : `## The book
"${arg}" could not be loaded automatically (${r.error}). Call find_books to locate it (ask the user if it's
ambiguous), then load_book, and use the resulting book_id and chunk list below.`;
  }
  return { messages: [{ role: "user", content: { type: "text", text: `${plan.task}\n\n${intro}\n\n${plan.steps(n)}` } }] };
}

const COMMON_RULES = `## Rules
- Work only from the text you read with get_chapter. Don't fill gaps from memory of this book, its sequels or
  adaptations, and don't invent details. If something is unclear in the text, say so.
- Refer to chapters by their title, with page ranges where helpful (write "approx." for "~" pages).`;

const readSteps = ({ which, noteWords, notes }) => `## How to work
**Step 0 — Brief.** Call get_overview(book_id) and write a 5–8 line brief: genre, setting, premise, the
protagonist(s). Give this brief to every reading step so names and pronouns make sense out of context.

**Step 1 — Read.** Call get_chapter for ${which}. Chunks are independent: if you can run sub-agents or parallel
tool calls, do that, giving each one the brief and its chunk index. Otherwise read them in order, and after each
one keep only your notes (not the chapter text). For each chunk, write notes of at most ~${noteWords} words:
${notes}`;

const upToRule = (upTo) => upTo ? `
**Reading limit:** the reader has only reached "${upTo}". Using the chunk list, find the last chunk that
matches (by chapter title, chapter number or page) and only read chunks up to and including it. Never fetch later
chunks, and reveal nothing that happens after that point.` : "";

// ---------------------------------------------------------------------------- prompts

export function registerPrompts(server) {
  // 1. Story summary -------------------------------------------------------------------------
  server.registerPrompt("summarize_book", {
    title: "Summarize a book",
    description: "Plot summary — brief, standard, or chapter-by-chapter — read in parallel chunks then combined",
    argsSchema: {
      book: bookArg,
      length: choice(["brief", "standard", "detailed"], "brief (~350 words), standard (~1,500 words, default), detailed (chapter by chapter)"),
      focus: z.string().optional().describe("Anything to emphasize, e.g. 'the political intrigue' or 'key arguments'"),
      up_to: upToArg,
    },
  }, async ({ book, length = "standard", focus, up_to }) => {
    const len = ["brief", "standard", "detailed"].includes(length) ? length : "standard";
    const total = { brief: 15000, standard: 30000, detailed: 45000 }[len];
    const outputs = {
      brief: "A summary of about 300–400 words: the premise, the main arc, and how it ends (or where it stands at the reading limit).",
      standard: `1. **Overview**: one paragraph (100–150 words).
2. **The story**: summary by part or by group of chapters, under headings with page ranges, ~1,000–1,500 words total.
3. **Main characters**: one line each.
4. **Themes**: 3–5 bullets.
5. **Ending**: how it resolves (skip if there's a reading limit).`,
      detailed: `1. **Overview**: one paragraph.
2. **Chapter by chapter**: a heading per chapter (title + pages), 100–200 words each. Merge "part n/m" chunks.
3. **Main characters** and how they change.
4. **Themes and motifs.**
5. **Ending and resolution** (skip if there's a reading limit).`,
    };
    return buildPrompt(book, {
      task: `Summarize this book (${len} length).${focus ? ` Give extra weight to: ${focus}.` : ""}`,
      steps: (n) => `${readSteps({
        which: up_to ? "each chunk up to the reading limit" : `every chunk (0–${n - 1})`,
        noteWords: clamp(total / n, 60, 300),
        notes: `what happens (events in order); which characters appear and what they do; any change of setting or
time; plot threads opened or resolved; one line on why the chunk matters to the whole book.`,
      })}${upToRule(up_to)}

**Step 2 — Combine.** Merge the notes into the final answer. Keep names and threads consistent across chapters
(the same person may be called different things in different chunks).

## Output
${outputs[len]}

${COMMON_RULES}`,
    });
  });

  // 2. Character guide -----------------------------------------------------------------------
  server.registerPrompt("character_guide", {
    title: "Character guide",
    description: "Who's who: main and supporting characters, their arcs, relationships and first appearances",
    argsSchema: {
      book: bookArg,
      spoilers: choice(["yes", "no"], "yes (default): full arcs and fates. no: only how characters are introduced"),
      detail: choice(["main", "all"], "main (default): main + supporting characters. all: also list minor characters"),
      up_to: upToArg,
    },
  }, async ({ book, spoilers = "yes", detail = "main", up_to }) => {
    const spoilerFree = /^n/i.test(spoilers);
    return buildPrompt(book, {
      task: `Create a character guide for this book${spoilerFree ? " (spoiler-free)" : ""}${up_to ? ` for a reader who is at "${up_to}"` : ""}.`,
      steps: (n) => `${readSteps({
        which: up_to ? "each chunk up to the reading limit" : `every chunk (0–${n - 1})`,
        noteWords: clamp(36000 / n, 80, 300),
        notes: `for each named character who actually appears (skip passing mentions):
**NAME** (plus any other names, titles or nicknames used for them in this chunk). What they do here; what we
learn about them (appearance, personality, background, motives); relationships revealed or changed; any change
in status (dies, revealed as someone else, changes sides). Add a very short quote only if it's truly
characteristic.`,
      })}${upToRule(up_to)}

**Step 2 — Merge.** Combine the notes across chunks:
- Merge aliases into one entry: name changes, titles ("the Captain"), nicknames, and married or maiden names.
- Keep apart different people who share a name.
- Rank characters by how much of the story they drive, not just how often they appear.

## Output
1. **Main characters**: for each one, give:
   - name and aliases;
   - role in the story;
   - a short description (look, personality, what they want);
   - their arc through the book, with chapter references;
   - their key relationships;
   - ${spoilerFree ? "**no** fate or late reveals" : "their fate"}.
2. **Supporting characters**: 1–2 lines each: who they are and why they matter, with their first appearance
   (chapter title, page).
${detail === "all" ? "3. **Minor characters**: name and one line each, with their first appearance.\n4." : "3."} **Relationships**: the key pairs and groups (family, rivals, allies, lovers) and how each relationship
   develops.

${spoilerFree ? `## Spoiler-free
Even though you read the whole book, describe each character only as they're introduced and in the early part of
their story. Don't reveal deaths, twists, secret identities, betrayals, or how arcs end. When in doubt, leave it out.

` : ""}${COMMON_RULES}`,
    });
  });

  // 3. Synopsis ------------------------------------------------------------------------------
  server.registerPrompt("book_synopsis", {
    title: "Book synopsis",
    description: "Complete plot synopsis including the ending, e.g. for agents, editors, or a plot reference",
    argsSchema: {
      book: bookArg,
      length: choice(["short", "standard", "long"], "short (~250 words), standard (~500–600 words, one page; default), long (~1,200 words)"),
      audience: z.string().optional().describe("Who it's for, e.g. 'literary agent', 'book club', 'encyclopedia-style plot summary'"),
    },
  }, async ({ book, length = "standard", audience }) => {
    const words = { short: "about 250 words", standard: "about 500–600 words (one page, single-spaced)", long: "about 1,000–1,500 words, covering the major subplots too" }[length] ?? "about 500–600 words";
    return buildPrompt(book, {
      task: `Write a synopsis of this book: ${words}.${audience ? ` It's for: ${audience}.` : ""}`,
      steps: (n) => `${readSteps({
        which: `every chunk (0–${n - 1})`,
        noteWords: clamp(25000 / n, 50, 250),
        notes: `the plot beats in order: who does what, why, and what changes. Label a beat's role in the story when
it's clear: setup, inciting incident, turning point, midpoint, crisis, climax, or resolution. Note what the
protagonist wants, what stands in the way, and how they change. Include the ending; this is not spoiler-free.`,
      })}

**Step 2 — Write.**

## Output
- The complete story, including the ending, in chronological order.
- Present tense, third person.
- Follow the protagonist's arc: goal, stakes, the major turning points, the climax, and the resolution. Include
  subplots only where they change the main story.
- Name only the characters who are essential. Put each name in CAPITALS the first time it appears (the standard
  manuscript convention; skip this if the audience suggests otherwise).
- This is a summary, not marketing: no teaser questions, no "will she survive?", no cliffhanger endings. Let word
  choice convey the tone.
- If the book is nonfiction, write a synopsis of its argument instead: the problem, the thesis, how each part
  builds it, the key evidence, and the conclusions.

${COMMON_RULES}`,
    });
  });

  // 4. Blurb ---------------------------------------------------------------------------------
  server.registerPrompt("book_blurb", {
    title: "Book blurb",
    description: "Spoiler-free cover copy: back-cover blurb, short listing blurb, tagline and hooks",
    argsSchema: {
      book: bookArg,
      style: z.string().optional().describe("Genre, audience or tone, e.g. 'YA fantasy', 'literary', 'cozy and funny', 'Amazon listing'"),
      words: z.string().optional().describe("Length of the main blurb in words (default 150–200)"),
    },
  }, async ({ book, style, words }) => {
    const len = /^\d+$/.test(words ?? "") ? `about ${words} words` : "150–200 words";
    return buildPrompt(book, {
      task: `Write spoiler-free cover copy for this book.${style ? ` Style / audience: ${style}.` : ""}`,
      steps: (n) => {
        const setupEnd = Math.max(1, Math.ceil(n * 0.35)); // the first ~third is what a blurb can draw on
        return `${readSteps({
          which: n > 1 ? `chunks 0–${setupEnd - 1} (the set-up) in full detail, and chunks ${setupEnd}–${n - 1} only lightly` : "the chunk",
          noteWords: clamp(20000 / setupEnd, 80, 300),
          notes: `for set-up chunks: the protagonist(s) and what makes them compelling; the world or setting; the
inciting incident; what the protagonist wants and what stands in the way; the central question or danger; and
striking images or lines that capture the voice.
For later chunks: at most 40 words each, covering only genre, tone, themes and how big the stakes become. These
notes are for calibration only; their plot must not appear in the blurb.`,
        })}

**Step 2 — Write.**

## Output
1. **Back-cover blurb** (${len}):
   - Open with a hook line.
   - Introduce the protagonist and their situation, then the inciting incident.
   - Show what they want and what stands in the way, and raise the stakes.
   - End on tension or a question that makes the reader need to know.
   - Use short paragraphs and present tense.
2. **Short blurb** (~50–60 words) for a store listing or social post.
3. **Tagline**: one sentence, under 15 words.
4. **Two alternative hook lines.**

## Craft rules
- **Spoiler-free:** use only the premise and set-up, roughly the first third. Never reveal twists, the climax,
  who dies, or the ending.
- **Match the genre and voice:** a cozy mystery shouldn't read like a thriller, and literary fiction shouldn't
  read like an action movie.
- **Be specific:** use this story's concrete details instead of clichés ("in a world where…", "nothing will ever
  be the same", "a journey of self-discovery") and empty superlatives ("stunning", "unputdownable").
- **No invented praise:** don't make up review quotes, awards, sales figures or author credentials.
- **Nonfiction:** hook with the problem or a surprising claim, then say what the reader will learn and why it
  matters.

${COMMON_RULES}`;
      },
    });
  });
}
