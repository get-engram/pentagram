// Pluggable consolidation summarizers. Consolidation's event shape (a `fact`
// with provenance) is fixed; only the compression function varies:
//
//   extractiveSummarizer — dumb, offline, deterministic. The fallback.
//   claudeSummarizer     — shells out to the `claude` CLI in headless mode
//                          (claude -p). No SDK, no API key handling here; uses
//                          whatever auth the CLI already has. Real compression.

// node:child_process is imported dynamically inside the claude-CLI paths so
// this module stays loadable on non-node runtimes (Workers use extractive).
export type Summarizer = (texts: string[]) => Promise<string>;

const MAX_CHARS = 800;

export const extractiveSummarizer: Summarizer = async (texts) =>
  (`consolidated from ${texts.length} episodes: ` + texts.join(" | ")).slice(0, MAX_CHARS);

export function claudeSummarizer(model = "haiku"): Summarizer {
  return async (texts) => {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      const prompt =
        "Consolidate these related memory episodes into ONE dense factual sentence " +
        "(max 60 words). Preserve concrete names, numbers, and dates. " +
        "Reply with only the sentence, no preamble.\n\n" +
        texts.map((t) => `- ${t}`).join("\n");
      execFile(
        "claude",
        ["-p", prompt, "--model", model],
        { timeout: 120_000, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) return reject(new Error(`claude summarizer failed: ${err.message}`));
          const out = stdout.trim().slice(0, MAX_CHARS);
          out ? resolve(out) : reject(new Error("claude summarizer returned empty output"));
        },
      );
    });
  };
}

/** claudeSummarizer if the claude CLI is on PATH, else extractive. */
export async function bestSummarizer(): Promise<Summarizer> {
  try {
    const { execFile } = await import("node:child_process");
    return await new Promise((resolve) => {
      execFile("claude", ["--version"], { timeout: 10_000 }, (err) =>
        resolve(err ? extractiveSummarizer : claudeSummarizer()),
      );
    });
  } catch {
    return extractiveSummarizer;
  }
}
