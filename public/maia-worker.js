// Maia3 Web Worker — handles ONNX inference for human move prediction
// Message protocol:
//   Inbound:  { type: "init" }
//             { type: "predict", fen, eloSelf, eloOppo, legalMoves }
//   Outbound: { type: "status", message }
//             { type: "ready" }
//             { type: "prediction", fen, moves, winProb }
//             { type: "error", message }

// Derive base path from worker location (e.g. "/gambits/maia-worker.js" -> "/gambits/")
const BASE = self.location.pathname.replace(/[^/]*$/, "")

importScripts(BASE + "ort/ort.wasm.min.js")

// Configure ORT WASM paths
ort.env.wasm.wasmPaths = BASE + "ort/"

let session = null

// ─── Move dictionaries (generated, not loaded from JSON) ───

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"]
const PROMOS = ["q", "r", "b", "n"]

// Build forward (uci→index) and reverse (index→uci) mappings
const uciToIndex = {}
const indexToUci = {}

// Indices 0-4095: all src*64+dst combinations
for (let src = 0; src < 64; src++) {
  for (let dst = 0; dst < 64; dst++) {
    const idx = src * 64 + dst
    const srcFile = FILES[src % 8]
    const srcRank = Math.floor(src / 8) + 1
    const dstFile = FILES[dst % 8]
    const dstRank = Math.floor(dst / 8) + 1
    const uci = srcFile + srcRank + dstFile + dstRank
    uciToIndex[uci] = idx
    indexToUci[idx] = uci
  }
}

// Indices 4096-4351: promotions (srcFile on rank7 → dstFile on rank8, with piece)
for (let srcF = 0; srcF < 8; srcF++) {
  for (let dstF = 0; dstF < 8; dstF++) {
    for (let p = 0; p < 4; p++) {
      const idx = 4096 + srcF * 32 + dstF * 4 + p
      const uci = FILES[srcF] + "7" + FILES[dstF] + "8" + PROMOS[p]
      uciToIndex[uci] = idx
      indexToUci[idx] = uci
    }
  }
}

// ─── FEN mirroring (for black-to-move positions) ───

function swapCase(ch) {
  return ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()
}

function mirrorFEN(fen) {
  const parts = fen.split(" ")
  // Reverse ranks and swap piece colors
  const ranks = parts[0].split("/")
  const mirrored = ranks.reverse().map(rank =>
    rank.split("").map(ch => /[a-zA-Z]/.test(ch) ? swapCase(ch) : ch).join("")
  ).join("/")
  // Swap active color
  const color = "w"
  // Swap castling rights
  let castling = parts[2]
  if (castling !== "-") {
    castling = castling.split("").map(ch => swapCase(ch)).join("")
  }
  // Mirror en passant
  let ep = parts[3]
  if (ep !== "-") {
    const epRank = parseInt(ep[1])
    ep = ep[0] + (9 - epRank)
  }
  return [mirrored, color, castling, ep, parts[4], parts[5]].join(" ")
}

function mirrorUci(uci) {
  const flipRank = r => String(9 - parseInt(r))
  let result = uci[0] + flipRank(uci[1]) + uci[2] + flipRank(uci[3])
  if (uci.length === 5) result += uci[4]
  return result
}

// ─── Board encoding ───

const PIECE_TO_CHANNEL = {
  P: 0, N: 1, B: 2, R: 3, Q: 4, K: 5,
  p: 6, n: 7, b: 8, r: 9, q: 10, k: 11,
}

function boardToMaia3Tokens(fen) {
  const tokens = new Float32Array(64 * 12)
  const placement = fen.split(" ")[0]
  const ranks = placement.split("/")
  // FEN lists rank 8 first, rank 1 last
  for (let r = 0; r < 8; r++) {
    const rank = ranks[r]
    const rankIdx = 7 - r // rank 8 = index 7, rank 1 = index 0
    let file = 0
    for (const ch of rank) {
      if (ch >= "1" && ch <= "8") {
        file += parseInt(ch)
      } else {
        const sq = rankIdx * 8 + file
        const channel = PIECE_TO_CHANNEL[ch]
        if (channel !== undefined) {
          tokens[sq * 12 + channel] = 1.0
        }
        file++
      }
    }
  }
  return tokens
}

// ─── Softmax ───

function softmax(logits) {
  const max = Math.max(...logits)
  const exps = logits.map(x => Math.exp(x - max))
  const sum = exps.reduce((a, b) => a + b, 0)
  return exps.map(x => x / sum)
}

// ─── IndexedDB caching ───

const DB_NAME = "maia3-cache"
const STORE_NAME = "models"
const MODEL_KEY = "maia3-simplified"

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function getCachedModel() {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const req = tx.objectStore(STORE_NAME).get(MODEL_KEY)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

async function cacheModel(buffer) {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, "readwrite")
    tx.objectStore(STORE_NAME).put(buffer, MODEL_KEY)
  } catch { /* caching is best-effort */ }
}

// ─── Model loading and session creation ───

async function loadModel() {
  // Try cache first
  postMessage({ type: "status", message: "Checking cache..." })
  let buffer = await getCachedModel()

  if (!buffer) {
    postMessage({ type: "status", message: "Downloading Maia3 model..." })
    const response = await fetch(BASE + "maia3/maia3_simplified.onnx")
    if (!response.ok) throw new Error("Failed to download model: " + response.status)
    buffer = await response.arrayBuffer()
    await cacheModel(buffer)
  }

  postMessage({ type: "status", message: "Loading model..." })
  session = await ort.InferenceSession.create(buffer, {
    executionProviders: ["wasm"],
  })
  postMessage({ type: "ready" })
}

// ─── Inference ───

async function predict(fen, eloSelf, eloOppo, legalMoves, requestId) {
  if (!session) throw new Error("Model not loaded")
  if (legalMoves.length === 0) {
    postMessage({ type: "prediction", fen, moves: [], winProb: { w: 0, d: 0, l: 0 }, requestId })
    return
  }

  // Mirror if black to move
  const isBlack = fen.split(" ")[1] === "b"
  const encodeFen = isBlack ? mirrorFEN(fen) : fen
  const encodeMoves = isBlack ? legalMoves.map(mirrorUci) : legalMoves

  // Encode board
  const tokens = boardToMaia3Tokens(encodeFen)

  // Create tensors
  const tokensTensor = new ort.Tensor("float32", tokens, [1, 64, 12])
  const eloSelfTensor = new ort.Tensor("float32", new Float32Array([eloSelf]), [1])
  const eloOppoTensor = new ort.Tensor("float32", new Float32Array([eloOppo]), [1])

  // Run inference
  const result = await session.run({
    tokens: tokensTensor,
    elo_self: eloSelfTensor,
    elo_oppo: eloOppoTensor,
  })

  const moveLogits = result.logits_move.data
  const valueLogits = result.logits_value.data

  // Extract logits for legal moves only
  const legalIndices = []
  const legalLogits = []
  for (const uci of encodeMoves) {
    const idx = uciToIndex[uci]
    if (idx !== undefined) {
      legalIndices.push({ idx, uci })
      legalLogits.push(moveLogits[idx])
    }
  }

  if (legalLogits.length === 0) {
    postMessage({ type: "prediction", fen, moves: [], winProb: { w: 0, d: 0, l: 0 }, requestId })
    return
  }

  // Softmax over legal moves
  const probs = softmax(legalLogits)

  // Build results, un-mirror if needed
  const moves = legalIndices.map((entry, i) => ({
    uci: isBlack ? mirrorUci(entry.uci) : entry.uci,
    probability: probs[i],
  })).sort((a, b) => b.probability - a.probability)

  // Win/draw/loss from value head (always from white's perspective after mirroring)
  const vProbs = softmax(Array.from(valueLogits))
  // valueLogits order: [loss, draw, win] from side-to-move perspective
  // After mirroring, side-to-move is always white
  const winProb = isBlack
    ? { w: vProbs[0], d: vProbs[1], l: vProbs[2] } // flip: model's "loss" = white's "win"
    : { w: vProbs[2], d: vProbs[1], l: vProbs[0] }

  postMessage({ type: "prediction", fen, moves, winProb, requestId })
}

// ─── Message handler ───

onmessage = async (e) => {
  const msg = e.data
  try {
    switch (msg.type) {
      case "init":
        await loadModel()
        break
      case "predict":
        await predict(msg.fen, msg.eloSelf, msg.eloOppo, msg.legalMoves, msg.requestId)
        break
    }
  } catch (err) {
    postMessage({ type: "error", message: err.message || String(err) })
  }
}
