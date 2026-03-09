import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import { StringDecoder } from "string_decoder"

// UTF-8 encoding reference:
//   U+0000..U+007F    1 byte   0xxxxxxx
//   U+0080..U+07FF    2 bytes  110xxxxx 10xxxxxx
//   U+0800..U+FFFF    3 bytes  1110xxxx 10xxxxxx 10xxxxxx
//   U+10000..U+10FFFF 4 bytes  11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
//
// Continuation bytes (0x80..0xBF) are never valid as a leading byte.
// When Buffer.toString("utf8") encounters an incomplete sequence at the
// end of a chunk, it emits U+FFFD (replacement character) for each
// orphaned byte. StringDecoder buffers incomplete trailing sequences
// across write() calls and only emits them once complete.

const EMDASH = "—" // U+2014, 3 bytes: 0xE2 0x80 0x94
const EMDASH_BYTES = [0xe2, 0x80, 0x94] as const
const PARTY = "🎉" // U+1F389, 4 bytes: 0xF0 0x9F 0x8E 0x89
const PARTY_BYTES = [0xf0, 0x9f, 0x8e, 0x89] as const
const CJK_WATER = "水" // U+6C34, 3 bytes: 0xE6 0xB0 0xB4
const CJK_WATER_BYTES = [0xe6, 0xb0, 0xb4] as const

describe("utf8 corruption: mechanism", () => {
  test("Buffer.toString() corrupts emdash split at byte offset 1", () => {
    const buf = Buffer.from(EMDASH)
    expect(buf.length).toBe(3)

    const chunk1 = buf.subarray(0, 1) // 0xE2 (leading byte, incomplete)
    const chunk2 = buf.subarray(1) // 0x80 0x94 (continuation bytes, no leader)

    const result = chunk1.toString() + chunk2.toString()
    expect(result).not.toBe(EMDASH)
    expect(result).toContain("\uFFFD")
  })

  test("Buffer.toString() corrupts emdash split at byte offset 2", () => {
    const buf = Buffer.from(EMDASH)
    const chunk1 = buf.subarray(0, 2) // 0xE2 0x80 (leading + 1 continuation, still incomplete)
    const chunk2 = buf.subarray(2) // 0x94 (lone continuation byte)

    const result = chunk1.toString() + chunk2.toString()
    expect(result).not.toBe(EMDASH)
    expect(result).toContain("\uFFFD")
  })

  test("Buffer.toString() corrupts 4-byte emoji at all 3 split points", () => {
    const buf = Buffer.from(PARTY)
    expect(buf.length).toBe(4)

    for (let split = 1; split < 4; split++) {
      const chunk1 = buf.subarray(0, split)
      const chunk2 = buf.subarray(split)
      const result = chunk1.toString() + chunk2.toString()
      expect(result).not.toBe(PARTY)
      expect(result).toContain("\uFFFD")
    }
  })

  test("Buffer.toString() corrupts CJK character split mid-sequence", () => {
    const buf = Buffer.from(CJK_WATER)
    expect(buf.length).toBe(3)

    for (let split = 1; split < 3; split++) {
      const result = buf.subarray(0, split).toString() + buf.subarray(split).toString()
      expect(result).not.toBe(CJK_WATER)
      expect(result).toContain("\uFFFD")
    }
  })

  test("Buffer.toString() corrupts mixed multi-byte in realistic context", () => {
    // "cleanup — Standard" with split landing inside the emdash
    const full = Buffer.from("cleanup \u2014 Standard")
    // Split after "cleanup " (8 bytes) + first byte of emdash
    const chunk1 = full.subarray(0, 9)
    const chunk2 = full.subarray(9)

    const result = chunk1.toString() + chunk2.toString()
    expect(result).toContain("\uFFFD")
    expect(result).not.toContain(EMDASH)
  })
})

describe("utf8 corruption: StringDecoder fix", () => {
  test("StringDecoder handles emdash split across 2 chunks", () => {
    const buf = Buffer.from(EMDASH)

    for (let split = 1; split < 3; split++) {
      const decoder = new StringDecoder("utf8")
      let result = ""
      result += decoder.write(buf.subarray(0, split))
      result += decoder.write(buf.subarray(split))
      result += decoder.end()
      expect(result).toBe(EMDASH)
      expect(result).not.toContain("\uFFFD")
    }
  })

  test("StringDecoder handles 4-byte emoji split at every boundary", () => {
    const buf = Buffer.from(PARTY)

    for (let split = 1; split < 4; split++) {
      const decoder = new StringDecoder("utf8")
      let result = ""
      result += decoder.write(buf.subarray(0, split))
      result += decoder.write(buf.subarray(split))
      result += decoder.end()
      expect(result).toBe(PARTY)
    }
  })

  test("StringDecoder handles consecutive multi-byte chars split mid-sequence", () => {
    // Three em-dashes: 9 bytes total, split at every possible boundary
    const text = EMDASH + EMDASH + EMDASH
    const buf = Buffer.from(text)
    expect(buf.length).toBe(9)

    for (let split = 1; split < 9; split++) {
      const decoder = new StringDecoder("utf8")
      let result = ""
      result += decoder.write(buf.subarray(0, split))
      result += decoder.write(buf.subarray(split))
      result += decoder.end()
      expect(result).toBe(text)
    }
  })

  test("StringDecoder handles interleaved ASCII and multi-byte", () => {
    const text = "hello " + EMDASH + " world " + PARTY + " end"
    const buf = Buffer.from(text)

    // Split into 1-byte chunks (worst case)
    const decoder = new StringDecoder("utf8")
    let result = ""
    for (let i = 0; i < buf.length; i++) {
      result += decoder.write(buf.subarray(i, i + 1))
    }
    result += decoder.end()
    expect(result).toBe(text)
  })

  test("StringDecoder handles 3 chunks splitting a single character", () => {
    // 4-byte emoji split into: [byte0], [byte1, byte2], [byte3]
    const buf = Buffer.from(PARTY)
    const decoder = new StringDecoder("utf8")
    let result = ""
    result += decoder.write(buf.subarray(0, 1))
    result += decoder.write(buf.subarray(1, 3))
    result += decoder.write(buf.subarray(3, 4))
    result += decoder.end()
    expect(result).toBe(PARTY)
  })

  test("StringDecoder handles empty chunks interspersed", () => {
    const buf = Buffer.from(EMDASH)
    const decoder = new StringDecoder("utf8")
    let result = ""
    result += decoder.write(buf.subarray(0, 1))
    result += decoder.write(Buffer.alloc(0)) // empty chunk
    result += decoder.write(buf.subarray(1, 2))
    result += decoder.write(Buffer.alloc(0)) // empty chunk
    result += decoder.write(buf.subarray(2, 3))
    result += decoder.end()
    expect(result).toBe(EMDASH)
  })
})

describe("utf8 corruption: decoder.end() flush", () => {
  test("end() emits replacement char for incomplete trailing sequence", () => {
    // Simulates: process killed mid-write, only first 2 of 3 emdash bytes delivered
    const decoder = new StringDecoder("utf8")
    const partial = Buffer.from(EMDASH_BYTES.slice(0, 2))
    const written = decoder.write(partial)
    expect(written).toBe("") // buffered, not emitted

    const flushed = decoder.end()
    expect(flushed).toBe("\uFFFD") // incomplete sequence becomes replacement char
  })

  test("end() emits replacement char for single orphaned leading byte", () => {
    const decoder = new StringDecoder("utf8")
    decoder.write(Buffer.from([0xe2])) // leading byte of 3-byte sequence
    expect(decoder.end()).toBe("\uFFFD")
  })

  test("end() is no-op for complete sequences", () => {
    const decoder = new StringDecoder("utf8")
    const result = decoder.write(Buffer.from(EMDASH))
    expect(result).toBe(EMDASH)
    expect(decoder.end()).toBe("")
  })

  test("end() on fresh decoder returns empty string", () => {
    const decoder = new StringDecoder("utf8")
    expect(decoder.end()).toBe("")
  })

  test("missing end() silently drops trailing incomplete bytes", () => {
    // bash.ts deliberately omits decoder.end() because it awaits "exit", not
    // "close". Calling end() on "exit" would flush incomplete bytes as U+FFFD,
    // which is worse than dropping them — especially when a background job may
    // still deliver the remaining bytes after "exit" fires.
    const decoder = new StringDecoder("utf8")
    const text = "hello " + EMDASH
    const buf = Buffer.from(text)

    // Deliver all but the last byte of the emdash
    let result = ""
    result += decoder.write(buf.subarray(0, buf.length - 1))
    // Process exits here — no decoder.end() call
    // The last incomplete emdash is silently swallowed
    expect(result).toBe("hello ") // emdash is missing entirely
    expect(result).not.toContain(EMDASH)
    expect(result).not.toContain("\uFFFD")
    // The data is just... gone. Neither correct nor visibly broken.
    // This is the lesser evil: silent drop vs. emitting U+FFFD.
  })
})

describe("utf8 corruption: shared decoder interleaving", () => {
  test("shared decoder corrupts when stderr interleaves mid-character", () => {
    // A single StringDecoder used for both stdout and stderr will corrupt
    // output when stderr bytes arrive while the decoder is buffering an
    // incomplete multi-byte sequence from stdout.
    const shared = new StringDecoder("utf8")
    let output = ""

    // stdout: first 2 bytes of em-dash (decoder buffers, waiting for byte 3)
    output += shared.write(Buffer.from([0xe2, 0x80]))
    // stderr: ASCII arrives — decoder sees non-continuation bytes, flushes
    // the buffered 0xE2 0x80 as U+FFFD
    output += shared.write(Buffer.from("error"))
    // stdout: final byte of em-dash — now an orphan continuation byte, U+FFFD
    output += shared.write(Buffer.from([0x94]))
    output += shared.end()

    expect(output).toContain("\uFFFD")
    expect(output).not.toContain(EMDASH)
  })

  test("separate decoders prevent interleaving corruption", () => {
    const stdoutDec = new StringDecoder("utf8")
    const stderrDec = new StringDecoder("utf8")
    let output = ""

    output += stdoutDec.write(Buffer.from([0xe2, 0x80]))
    output += stderrDec.write(Buffer.from("error"))
    output += stdoutDec.write(Buffer.from([0x94]))
    output += stdoutDec.end()
    output += stderrDec.end()

    expect(output).toContain(EMDASH)
    expect(output).toContain("error")
    expect(output).not.toContain("\uFFFD")
  })
})

describe("utf8 corruption: exit vs close timing", () => {
  test("exit fires before close when background job holds pipe open", async () => {
    // A forked child inherits the parent's stdout fd. When the parent exits,
    // Node.js emits "exit" immediately, but "close" waits for the pipe to
    // drain — including output from the background child.
    const py = [
      "import os, time",
      "if os.fork() == 0:",
      "    time.sleep(0.3)",
      "    os.write(1, b'bg\\n')",
      "    os._exit(0)",
      "os.write(1, b'fg\\n')",
      "os._exit(0)",
    ].join("\n")

    const events: string[] = []

    await new Promise<void>((resolve) => {
      const proc = spawn("python3", ["-c", py])
      proc.stdout!.on("data", () => {})
      proc.once("exit", () => events.push("exit"))
      proc.once("close", () => {
        events.push("close")
        resolve()
      })
    })

    expect(events).toEqual(["exit", "close"])
  }, 5000)

  test("decoder.end() on exit produces U+FFFD when background job completes the char", async () => {
    // Parent writes first 2 bytes of em-dash, background child writes byte 3.
    // If we call decoder.end() on "exit", the buffered bytes are flushed as
    // U+FFFD before the background child's data arrives.
    const py = [
      "import os, time",
      "if os.fork() == 0:",
      "    time.sleep(0.3)",
      "    os.write(1, bytes([0x94, 0x0A]))",
      "    os._exit(0)",
      "os.write(1, b'hello ' + bytes([0xE2, 0x80]))",
      "os._exit(0)",
    ].join("\n")

    const result = await new Promise<string>((resolve) => {
      const decoder = new StringDecoder("utf8")
      let output = ""
      const proc = spawn("python3", ["-c", py])
      proc.stdout!.on("data", (chunk: Buffer) => {
        output += decoder.write(chunk)
      })
      proc.once("exit", () => {
        // This is what bash.ts used to do — flush on exit
        output += decoder.end()
      })
      proc.once("close", () => resolve(output))
    })

    // decoder.end() on exit flushed the incomplete em-dash as U+FFFD
    expect(result).toContain("\uFFFD")
    expect(result).not.toContain(EMDASH)
  }, 5000)

  test("decoder.end() on close reconstructs the character correctly", async () => {
    // Same scenario, but end() is called on "close" — after all data is in.
    const py = [
      "import os, time",
      "if os.fork() == 0:",
      "    time.sleep(0.3)",
      "    os.write(1, bytes([0x94, 0x0A]))",
      "    os._exit(0)",
      "os.write(1, b'hello ' + bytes([0xE2, 0x80]))",
      "os._exit(0)",
    ].join("\n")

    const result = await new Promise<string>((resolve) => {
      const decoder = new StringDecoder("utf8")
      let output = ""
      const proc = spawn("python3", ["-c", py])
      proc.stdout!.on("data", (chunk: Buffer) => {
        output += decoder.write(chunk)
      })
      proc.once("close", () => {
        output += decoder.end()
        resolve(output)
      })
    })

    // close waits for pipe drain, so all bytes arrive before end()
    expect(result).toContain(EMDASH)
    expect(result).not.toContain("\uFFFD")
  }, 5000)
})
