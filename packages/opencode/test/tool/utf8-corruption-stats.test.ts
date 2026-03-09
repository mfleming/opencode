import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import { StringDecoder } from "string_decoder"

// These tests are statistical / probabilistic and involve real I/O.
// They're slow and non-deterministic, so they're gated behind UTF8_STATS=1.
// Run with: UTF8_STATS=1 bun test test/tool/utf8-corruption-stats.test.ts

const enabled = !!process.env.UTF8_STATS

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a string of approximately `length` bytes with em-dashes at `density` frequency */
function generate(length: number, density: number) {
  const words = "the quick brown fox jumps over lazy dog and some more words here".split(" ")
  let result = ""
  while (result.length < length) {
    result += words[Math.floor(Math.random() * words.length)] + " "
    if (Math.random() < density) result += "\u2014 " // em-dash
  }
  return result.slice(0, length)
}

/**
 * Simulate chunked reads of `text` using Buffer.toString() with randomized
 * chunk sizes centered around `pipeSize`.
 *
 * Returns true if any U+FFFD replacement characters appear in the result.
 */
function corruptsWith(text: string, pipeSize: number) {
  const buf = Buffer.from(text, "utf8")
  let offset = 0
  while (offset < buf.length) {
    const size = Math.max(1, Math.floor(pipeSize * (0.5 + Math.random())))
    const end = Math.min(offset + size, buf.length)
    // Check if this chunk boundary lands inside a multi-byte sequence.
    // A continuation byte (0x80..0xBF) at `end` means we split mid-character.
    if (end < buf.length) {
      const next = buf[end]!
      if (next >= 0x80 && next <= 0xbf) return true
    }
    offset = end
  }
  return false
}

/** Run multiple trials and return the corruption rate */
function measureCorruptionRate(length: number, density: number, pipeSize: number, trials: number) {
  let hits = 0
  for (let i = 0; i < trials; i++) {
    if (corruptsWith(generate(length, density), pipeSize)) hits++
  }
  return hits / trials
}

// ---------------------------------------------------------------------------
// Frequency tests (simulated chunk boundaries)
// ---------------------------------------------------------------------------

describe("utf8 corruption: frequency by output profile", () => {
  const TRIALS = 2000
  const PIPE = 8192 // common default pipe buffer size

  test.skipIf(!enabled)(
    "short ASCII-heavy output (<2KB, 2% Unicode) rarely corrupts",
    () => {
      const rate = measureCorruptionRate(1500, 0.02, PIPE, TRIALS)
      // Short output fits in 1 chunk most of the time, so corruption is near 0%.
      // Allow up to 1% to avoid flakiness — the point is it's much lower than long output.
      expect(rate).toBeLessThan(0.01)
    },
  )

  test.skipIf(!enabled)(
    "long Unicode-rich output (15KB, 8% Unicode) corrupts measurably",
    () => {
      const rate = measureCorruptionRate(15000, 0.08, PIPE, TRIALS)
      // With ~15KB and 8% em-dash density, corruption should be detectable (>1%).
      // In practice we measured ~3-5% in earlier experiments.
      expect(rate).toBeGreaterThan(0.01)
    },
  )

  test.skipIf(!enabled)(
    "corruption rate scales with output length and Unicode density",
    () => {
      const short = measureCorruptionRate(1500, 0.02, PIPE, TRIALS)
      const medium = measureCorruptionRate(15000, 0.08, PIPE, TRIALS)
      const long = measureCorruptionRate(50000, 0.05, PIPE, TRIALS)

      // Each step up should have a strictly higher corruption rate.
      // short ≈ 0%, medium ≈ 3-5%, long ≈ 8-12%
      expect(medium).toBeGreaterThan(short)
      expect(long).toBeGreaterThan(medium)
    },
  )
})

// ---------------------------------------------------------------------------
// Real pipe tests (actual child_process I/O)
// ---------------------------------------------------------------------------

describe("utf8 corruption: real pipe", () => {
  // We use python3 to write a large contiguous buffer to stdout.
  // The OS pipe delivers this in kernel-determined chunks, which may
  // split multi-byte UTF-8 sequences.
  //
  // Each block is 51 bytes: 47 ASCII 'A' + 3-byte emdash + 1 space.
  // 50,000 blocks = 2.55 MB. With ~50k em-dashes and kernel pipe chunks
  // of 4-64KB, the probability of at least one mid-character split is high.

  const PY_SCRIPT = [
    "import sys",
    "block = b'A' * 47 + bytes([0xE2, 0x80, 0x94]) + b' '",
    "sys.stdout.buffer.write(block * 50000)",
  ].join("; ")

  function spawnPipe(): Promise<{ broken: string; fixed: string }> {
    return new Promise((resolve, reject) => {
      let broken = ""
      let fixed = ""
      const decoder = new StringDecoder("utf8")

      const proc = spawn("python3", ["-c", PY_SCRIPT])
      proc.stdout!.on("data", (chunk: Buffer) => {
        broken += chunk.toString()
        fixed += decoder.write(chunk)
      })
      proc.on("close", () => {
        fixed += decoder.end()
        resolve({ broken, fixed })
      })
      proc.on("error", reject)
    })
  }

  test.skipIf(!enabled)(
    "large contiguous pipe write corrupts Buffer.toString()",
    async () => {
      // Run 20 trials. With 2.5MB of em-dash-containing output per trial,
      // at least one trial should produce corruption (we measured ~30% hit rate).
      let corrupted = 0
      for (let i = 0; i < 20; i++) {
        const { broken } = await spawnPipe()
        if (broken.includes("\uFFFD")) corrupted++
      }
      expect(corrupted).toBeGreaterThan(0)
    },
    60_000,
  )

  test.skipIf(!enabled)(
    "StringDecoder prevents corruption on same pipe data",
    async () => {
      // Even if Buffer.toString() corrupts, StringDecoder must never produce U+FFFD
      // (unless the source data itself is malformed, which our python script is not).
      for (let i = 0; i < 20; i++) {
        const { fixed } = await spawnPipe()
        expect(fixed).not.toContain("\uFFFD")
      }
    },
    60_000,
  )
})
