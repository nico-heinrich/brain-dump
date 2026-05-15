// ============================================================
// Brain Dump → Obsidian
// Run via Shortcuts: pass the brain dump text as argument [0]
// ============================================================

// ── Config ──────────────────────────────────────────────────
const VAULT_BOOKMARK   = "vault";    // bookmark to your vault root
const INBOX_BOOKMARK   = "inbox";    // bookmark to your inbox folder
const ARCHIVE_BOOKMARK = "archive";  // bookmark to your archive folder

const API_ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_MODEL = "claude-haiku-4-5-20251001";

// ── Helpers: Bookmarks ───────────────────────────────────────

const fm = FileManager.iCloud();

function readBookmarkFile(name) {
  const path = fm.bookmarkedPath(name);
  return fm.readString(path).trim();
}

function bookmarkDir(name) {
  return fm.bookmarkedPath(name);
}

// ── Helpers: Date / Time ─────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function currentHHMM() {
  const d = new Date();
  return d.toTimeString().slice(0, 5); // "HH:MM"
}

// ── Model API call ───────────────────────────────────────────

async function callModel(apiKey, userInput) {
  const today = todayISO();
  const locale = "German";

  const systemPrompt = `You are a personal knowledge management assistant.
Your job is to process a raw brain dump and turn it into structured notes for Obsidian.

## Instructions

1. Read the brain dump carefully.
2. Split it into one or more discrete notes. A single brain dump may contain multiple distinct thoughts.
3. Classify each note as exactly one of:
   - **idea** — a concept, insight, or thing to explore
   - **log** — something that happened, a meeting, a conversation, an observation
   - **ref** — a reference to save: article, book, tool, link, quote
   - **todo** — an action item; extract one note per distinct task
4. For each note, produce a JSON object. Fields depend on type:

   **idea / log / ref:**
   - \`type\` — one of: idea | log | ref
   - \`title\` — formatted based on type:
     - **idea:** \`idea - {descriptive title in ${locale}}\`
     - **ref:**  \`ref - {descriptive title in ${locale}}\`
     - **log:**  \`log - ${today}\`
   - \`tags\` — 1–4 relevant lowercase tags in ${locale}
   - \`date\` — today's date in YYYY-MM-DD
   - \`body\` — the note content as clean markdown (${locale}). Do NOT include any Obsidian [[wikilinks]] — plain text only.
   - \`source\` — (ref only) URL or citation

   **todo:**
   - \`type\` — todo
   - \`body\` — the task description as plain text, no markdown (${locale})
   - \`due\` — due date as YYYY-MM-DD if mentioned, otherwise omit this field entirely

  **Important points**
  - Ideas and refs may be enriched — however, do not add new information to logs or todos.
  - \`title\` cannot contain slashes or colons

5. Return ONLY a valid JSON array. No preamble, no explanation, no markdown fences.

## Today's date
${today}`;

  const req = new Request(API_ENDPOINT);
  req.method = "POST";
  req.headers = {
    "Content-Type":      "application/json",
    "x-api-key":         apiKey,
    "anthropic-version": "2023-06-01"
  };
  req.body = JSON.stringify({
    model:      API_MODEL,
    max_tokens: 4096,
    system:     systemPrompt,
    messages:   [{ role: "user", content: userInput }]
  });

  const res = await req.loadJSON();

  if (res.error) throw new Error(res.error.message);

  const text = res.content.find(b => b.type === "text")?.text ?? "";
  const clean = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  return JSON.parse(clean);
}

// ── File writers ─────────────────────────────────────────────

function writeNote(inboxDir, note) {
  const filename = `${note.title}.md`;
  const filePath = fm.joinPath(inboxDir, filename);

  let frontmatter = `---\ntype: ${note.type}\ndate: ${note.date}\n`;
  if (note.source) frontmatter += `source: ${note.source}\n`;
  frontmatter += `---\n`;

  const tags = note.tags.map(t => `#${t}`).join(" ");
  const content = `${frontmatter}${note.body.trimEnd()}\n\n${tags}\n`;

  fm.writeString(filePath, content);
}

function appendLog(archiveDir, note) {
  const filename = `${note.title}.md`;
  const filePath = fm.joinPath(archiveDir, filename);

  const time = currentHHMM();
  const entry = `\n## ${time}\n\n${note.body.trimEnd()}\n`;
  const newTags = normalizeTags(note.tags);

  if (fm.fileExists(filePath)) {
    const existing = fm.readString(filePath);
    const { fmCore, body, tags } = parseLogFile(existing);
    const merged = mergeTags(tags, newTags);
    fm.writeString(filePath, rebuildLogFile(fmCore, merged, body, entry));
  } else {
    const fmCore = `type: log\ndate: ${note.date}\n`;
    fm.writeString(filePath, rebuildLogFile(fmCore, newTags, "\n", entry));
  }
}

function appendTodo(vaultDir, note) {
  const filePath = fm.joinPath(vaultDir, "todo.md");
  const due = note.due ? ` 📅 ${note.due}` : "";
  const line = `- [ ] ${note.body}${due}\n`;

  if (fm.fileExists(filePath)) {
    let existing = fm.readString(filePath);

    if (existing.length > 0 && !existing.endsWith("\n")) {
      existing += "\n";
    }

    fm.writeString(filePath, existing + line);
  } else {
    fm.writeString(filePath, line);
  }
}

// ── Notification ─────────────────────────────────────────────

function buildSummary(counts) {
  const labels = {
    idea: ["idea", "ideas"],
    log:  ["log",  "logs"],
    ref:  ["ref",  "refs"],
    todo: ["todo", "todos"],
  };

  const typeLabel = (type, n) => {
    const [s, p] = labels[type];
    return n === 1 ? s : `${n} ${p}`;
  };

  const parts = ["idea", "log", "ref", "todo"]
    .filter(type => counts[type] > 0)
    .map(type => ({ type, n: counts[type], label: typeLabel(type, counts[type]) }));

  if (parts.length === 0) return "Nothing saved";

  if (parts.length === 1 && parts[0].n === 1) {
    return `Saved as ${parts[0].label}`;
  }

  if (parts.length === 1) {
    return `Saved ${parts[0].label}`;
  }

  return "Saved " + parts.map(p => typeLabel(p.type, p.n)).join(" + ");
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const input = args.shortcutParameter;
  if (!input || input.trim() === "") {
    Script.complete();
    return;
  }

  const apiKey    = Keychain.get("claude_api_key");
  const vaultDir  = bookmarkDir(VAULT_BOOKMARK);
  const inboxDir  = bookmarkDir(INBOX_BOOKMARK);
  const archiveDir = bookmarkDir(ARCHIVE_BOOKMARK);

  let notes;
  try {
    notes = await callModel(apiKey, input);
    console.log(JSON.stringify(notes));
  } catch (e) {
    const alert = new Alert();
    alert.title   = "Brain Dump failed";
    alert.message = e.message;
    alert.addAction("OK");
    await alert.present();
    Script.complete();
    return;
  }

  const counts = { idea: 0, log: 0, ref: 0, todo: 0 };

  for (const note of notes) {
    switch (note.type) {
      case "idea":
      case "ref":
        writeNote(inboxDir, note);
        counts[note.type]++;
        break;
      case "log":
        appendLog(archiveDir, note);  // logs go directly to archive
        counts.log++;
        break;
      case "todo":
        appendTodo(vaultDir, note);
        counts.todo++;
        break;
    }
  }

  const n = new Notification();
  n.title = buildSummary(counts);
  n.body  = "";
  n.schedule();

  Script.complete();
}

main();
