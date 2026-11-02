import { normKey } from "./text.js";

const NUM = String.raw`(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|the\s+\w+)`;
const PART_RE = new RegExp(String.raw`^(?:part|book|volume|vol\.)\s+${NUM}\b`, "i");
const CHAP_RE = new RegExp(String.raw`^(?:chapter|chap\.|letter|act|canto|stave)\s+${NUM}\b`, "i");
const NAMED_RE =
  /^(?:prologue|epilogue|introduction|preface|foreword|afterword|conclusion|interlude|appendix(?:\s+[a-z0-9]+)?|acknowledge?ments|about the author|bibliography|glossary|notes|index)\b[^.!?]{0,60}$/i;
const BARE_NUMERAL_RE = /^(?:[IVXLC]{1,7}|\d{1,3})\.?$/; // "IV" or "12." alone on a line

/**
 * Find chapter-like headings in plain text.
 * @returns {{offset:number, title:string, depth:number}[]}
 */
export function detectHeadings(text, { allowBareNumerals = false } = {}) {
  const found = [];
  const re = /^.*$/gm;
  let m;
  let prevBlank = true;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const line = raw.trim().replace(/^[#*_\s]+|[*_\s]+$/g, "");
    if (m[0].length === 0) re.lastIndex++;
    const blank = line.length === 0;
    if (!blank && line.length <= 60 && prevBlank) {
      let depth = null;
      let label = null;
      if ((label = line.match(PART_RE)) && !/chapter/i.test(line)) depth = 0;
      else if ((label = line.match(CHAP_RE) ?? line.match(NAMED_RE))) depth = 1;
      else if (allowBareNumerals && (label = line.match(BARE_NUMERAL_RE))) depth = 1;
      if (depth !== null) {
        let title = line;
        // Bare label ("CHAPTER IV") followed by a standalone short line → use it as the subtitle
        if (/^[\s.:—-]*$/.test(line.slice(label[0].length))) {
          const after = text.slice(m.index + raw.length, m.index + raw.length + 300).split("\n");
          let k = 0;
          while (k < after.length && !after[k].trim()) k++;
          const next = after[k]?.trim();
          const standalone = k + 1 < after.length && !after[k + 1].trim();
          if (next && standalone && next.length <= 70 && !/[,;]$/.test(next) &&
              !PART_RE.test(next) && !CHAP_RE.test(next)) {
            title = `${line.replace(/[.:—-]+$/, "")}: ${next}`;
          }
        }
        found.push({ offset: m.index, title, depth, key: normKey(label[0]) });
      }
    }
    prevBlank = blank;
  }
  return dropTocRuns(found, text.length);
}

/** Remove runs of headings that are really a printed table of contents. */
function dropTocRuns(heads, textLen) {
  if (heads.length < 3) return heads;
  const gap = (i) => (i + 1 < heads.length ? heads[i + 1].offset : textLen) - heads[i].offset;
  const dense = heads.map((h, i) => gap(i) < 200);
  const drop = new Set();
  for (let i = 0; i < heads.length; ) {
    if (!dense[i]) { i++; continue; }
    let j = i;
    while (j < heads.length && dense[j]) j++;
    if (j - i >= 3) {
      for (let k = i; k < j; k++) drop.add(k);
      // the entry right after a TOC run is often the TOC's last line; drop it if it recurs later
      if (j < heads.length && heads.slice(j + 1).some((h) => h.key === heads[j].key)) drop.add(j);
    }
    i = j;
  }
  return heads.filter((_, i) => !drop.has(i)).map(({ key, ...h }) => h);
}
