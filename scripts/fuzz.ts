// Fuzz harness: mechanical adversaries for the three invariants everything
// else rests on. Deterministic (seeded PRNG) — failures print a repro seed.
//
//   1. Reader/printer round-trip: read(print(x)) ≡ x for arbitrary sexps
//   2. Fold determinism: any op sequence → state; close → reopen (refold)
//      → identical state; force rollover → live state + belief chains intact
//   3. Torn-write recovery: any proper prefix of a final event line is
//      quarantined on open, never corrupts, never loses durable events
//
// Budget via env: FUZZ_EXPRS (default 3000), FUZZ_SEQS (25), FUZZ_TORN (12).

import * as fs from "node:fs";
import { read, print, sym, Sexp } from "../src/sexp.js";
import { Store } from "../src/store.js";
import { hashEmbedder } from "../src/embed.js";

// ---------- seeded PRNG (mulberry32) ----------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];
const int = (r: () => number, max: number) => Math.floor(r() * max);

let failures = 0;
const fail = (msg: string) => {
  console.error(`  ✗ ${msg}`);
  failures++;
};

// ---------- 1. reader/printer round-trip ----------

const NASTY = ['\\', '"', "n", "\n", "(", ")", ";", "'", "`", ",", " ", "⛧", "é", "\t", "\\n", '\\"', "\\\\"];
const WORDS = ["acme", "invoice", "warehouse", "recall", "vendor", "x"];

function genString(r: () => number): string {
  let s = "";
  const len = int(r, 12);
  for (let i = 0; i < len; i++) s += r() < 0.4 ? pick(r, NASTY) : pick(r, WORDS);
  return s;
}

function genAtom(r: () => number): Sexp {
  const roll = r();
  if (roll < 0.3) return genString(r);
  if (roll < 0.5) return int(r, 1e9) - 5e8; // ints incl. negatives
  if (roll < 0.6) return (r() - 0.5) * 1e6; // floats
  if (roll < 0.7) return r() < 0.5;
  return sym(pick(r, ["remember", "postgres", "a-b_c?", "x1", "supersedes", "λ"]));
}

function genSexp(r: () => number, depth: number): Sexp {
  if (depth <= 0 || r() < 0.35) return genAtom(r);
  return Array.from({ length: int(r, 5) }, () => genSexp(r, depth - 1));
}

function fuzzReader(iterations: number): void {
  console.log(`— reader/printer round-trip (${iterations} exprs) —`);
  let bad = 0;
  for (let seed = 1; seed <= iterations; seed++) {
    const r = rng(seed);
    const x = genSexp(r, 5);
    const printed = print(x);
    try {
      const reprinted = print(read(printed));
      if (reprinted !== printed) {
        if (bad++ < 3) fail(`seed ${seed}: round-trip mismatch\n    ${printed}\n    ${reprinted}`);
      }
    } catch (e: any) {
      if (bad++ < 3) fail(`seed ${seed}: read threw on own print output: ${e.message}\n    ${printed}`);
    }
  }
  if (bad === 0) console.log(`  ✓ all ${iterations} round-trips exact`);
  else fail(`${bad} total round-trip failures`);
}

// ---------- 2. fold determinism + rollover invariants ----------

const DIR = "fuzz-tmp";

function stateOf(s: Store, ids: string[]): string {
  return JSON.stringify({
    stats: s.stats(),
    episodes: ids.map((id) => {
      const e = s.get(id);
      return e ? [e.id, e.kind, e.text, e.forgotten, print(e.provenance ?? [])] : null;
    }),
    traces: ids.map((id) => s.trace(id) ?? null),
  });
}

function liveStateOf(s: Store, ids: string[]): string {
  return JSON.stringify({
    live: ids
      .map((id) => s.get(id))
      .filter((e) => e && !e.forgotten)
      .map((e) => [e!.id, e!.kind, e!.text]),
    chains: ids
      .map((id) => s.get(id))
      .filter((e) => e && !e.forgotten && e.kind === "fact")
      .map((e) => [e!.id, s.history(e!.id).map((h) => [h.id, h.forgotten])]),
  });
}

async function fuzzStore(sequences: number, opsPerSeq: number): Promise<void> {
  console.log(`— fold determinism (${sequences} sequences × ${opsPerSeq} ops) —`);
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  for (let seq = 1; seq <= sequences; seq++) {
    const r = rng(seq * 7919);
    const path = `${DIR}/seq-${seq}.pgram`;
    let clock = 1_700_000_000_000;
    const tick = () => (clock += int(r, 3_600_000) + 1);
    const stub = async (texts: string[]) => `stub summary of ${texts.length}`;

    let s = await Store.open(path, hashEmbedder, stub);
    const ids: string[] = [];
    const factIds: string[] = [];

    for (let op = 0; op < opsPerSeq; op++) {
      const roll = r();
      try {
        if (roll < 0.35) {
          ids.push(await s.remember(genString(r) || "x", tick()));
        } else if (roll < 0.5 && ids.length) {
          await s.recall(genString(r) || "x", 1 + int(r, 4), tick());
        } else if (roll < 0.6 && ids.length > 1) {
          s.link(pick(r, ids), pick(r, ["about", "mentions", "caused"]), pick(r, ids));
        } else if (roll < 0.72) {
          const prov: Sexp[] = r() < 0.5 ? [] : [[sym("postgres"), genString(r) || "ref", int(r, 1e6)]];
          const f = await s.assertFact(genString(r) || "fact", prov, tick());
          ids.push(f); factIds.push(f);
        } else if (roll < 0.8 && factIds.length) {
          const head = factIds.find((id) => !s.get(id)!.forgotten);
          if (head) {
            const nf = await s.revise(head, genString(r) || "revised", [], tick());
            ids.push(nf); factIds.push(nf);
          }
        } else if (roll < 0.87) {
          ids.push(await s.entity(pick(r, WORDS), pick(r, ["org", "person"]), tick()));
        } else if (roll < 0.94) {
          s.decay(tick());
        } else {
          await s.consolidate({ now: tick(), minAgeHours: 1, threshold: 0.98 });
        }
      } catch (e: any) {
        // Guard-rail throws (already-superseded etc.) are legal outcomes;
        // anything else is a finding.
        if (!/already superseded|cannot revise|must be/.test(e.message)) {
          fail(`seq ${seq} op ${op}: unexpected throw: ${e.message}`);
          break;
        }
      }
    }

    const before = stateOf(s, ids);
    const liveBefore = liveStateOf(s, ids);
    s.close();

    s = await Store.open(path, hashEmbedder, stub);
    if (stateOf(s, ids) !== before) fail(`seq ${seq}: refold state diverges from pre-close state`);
    s.close();

    // Force rollover: live memories and belief chains must survive verbatim.
    s = await Store.open(path, hashEmbedder, stub, { maxLogBytes: 1 });
    if (liveStateOf(s, ids) !== liveBefore) fail(`seq ${seq}: rollover changed live state or belief chains`);
    s.close();
    // And the snapshot itself must refold cleanly.
    s = await Store.open(path, hashEmbedder, stub);
    if (liveStateOf(s, ids) !== liveBefore) fail(`seq ${seq}: post-rollover refold diverges`);
    s.close();
  }
  console.log(`  ✓ ${sequences} sequences: refold + rollover invariants hold`);
  fs.rmSync(DIR, { recursive: true, force: true });
}

// ---------- 3. torn-write recovery ----------

async function fuzzTorn(cases: number): Promise<void> {
  console.log(`— torn-write recovery (${cases} cases) —`);
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  for (let c = 1; c <= cases; c++) {
    const r = rng(c * 104729);
    const path = `${DIR}/torn-${c}.pgram`;
    let s = await Store.open(path, hashEmbedder);
    const kept = await s.remember("durable memory " + genString(r), 1_700_000_000_000);
    await s.remember("second durable " + genString(r), 1_700_000_100_000);
    s.close();

    const intact = fs.readFileSync(path, "utf8");
    const tornLine = print([sym("episode"), "tornid", 1_700_000_200_000, genString(r) || "torn"]);
    const cut = 1 + int(r, tornLine.length - 1); // proper prefix, never full line
    fs.appendFileSync(path, tornLine.slice(0, cut));

    try {
      s = await Store.open(path, hashEmbedder);
      if (!s.get(kept)) fail(`case ${c}: durable event lost during recovery`);
      if (s.get("tornid")) fail(`case ${c}: torn (non-durable) event resurrected`);
      if (s.stats().episodes !== 2) fail(`case ${c}: episode count wrong after recovery`);
      s.close();
      if (fs.readFileSync(path, "utf8") !== intact) fail(`case ${c}: recovery did not restore intact log`);
      const torn = fs.readdirSync(DIR).filter((f) => f.includes(`torn-${c}.pgram.torn-`));
      if (torn.length !== 1) fail(`case ${c}: torn bytes not quarantined`);
    } catch (e: any) {
      fail(`case ${c}: open threw on torn log: ${e.message}`);
    }
  }
  console.log(`  ✓ ${cases} torn-write cases recovered`);
  fs.rmSync(DIR, { recursive: true, force: true });
}

// ---------- run ----------

await (async () => {
  fuzzReader(Number(process.env.FUZZ_EXPRS ?? 3000));
  await fuzzStore(Number(process.env.FUZZ_SEQS ?? 25), 40);
  await fuzzTorn(Number(process.env.FUZZ_TORN ?? 12));
  if (failures) {
    console.error(`\n${failures} fuzz failure(s)`);
    process.exit(1);
  }
  console.log("\nfuzz clean ⛧");
})();
