import React, { useEffect, useRef, useCallback, useState } from "react"
import { Chess } from "chess.js"

const BASE = import.meta.env.BASE_URL // "/gambits/" in production, "/" in dev

const BOARD_SIZE = 480
const SQ = BOARD_SIZE / 8
const LIGHT_SQ = "#f0d9b5"
const DARK_SQ = "#b58863"
const HIGHLIGHT_COLOR = "rgba(255, 255, 0, 0.4)"
const LEGAL_DOT_COLOR = "rgba(0, 0, 0, 0.25)"
const ARROW_COLORS = ["rgba(0, 180, 0, 0.6)", "rgba(200, 180, 0, 0.5)", "rgba(200, 120, 0, 0.4)"]
const PIECE_CHARS = {
  K: "\u2654", Q: "\u2655", R: "\u2656", B: "\u2657", N: "\u2658", P: "\u2659",
  k: "\u265A", q: "\u265B", r: "\u265C", b: "\u265D", n: "\u265E", p: "\u265F",
}

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"]
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"]

function squareToCoords(sq, flipped) {
  const file = FILES.indexOf(sq[0])
  const rank = RANKS.indexOf(sq[1])
  const x = flipped ? (7 - file) * SQ : file * SQ
  const y = flipped ? (7 - rank) * SQ : rank * SQ
  return { x, y }
}

function coordsToSquare(cx, cy, flipped) {
  const file = flipped ? 7 - Math.floor(cx / SQ) : Math.floor(cx / SQ)
  const rank = flipped ? 7 - Math.floor(cy / SQ) : Math.floor(cy / SQ)
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null
  return FILES[file] + RANKS[rank]
}

function parseUciMove(uci) {
  if (!uci || uci.length < 4) return null
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined }
}

function formatEval(score) {
  if (score.mate !== undefined) return `M${score.mate}`
  return (score.cp >= 0 ? "+" : "") + (score.cp / 100).toFixed(1)
}

// Create a stockfish worker using the single-threaded build in public/
function createEngine(onMessage) {
  const worker = new Worker(BASE + "stockfish.js")
  worker.onmessage = (e) => onMessage(e.data)
  worker.postMessage("uci")
  return worker
}

function sendToEngine(worker, cmd) {
  if (worker) worker.postMessage(cmd)
}

function GambitPane({ gb, highlighted, onClick, onSave, buttonStyle }) {
  return (
    <div
      style={{
        marginBottom: 5,
        padding: "5px 7px",
        background: highlighted ? "#2a2200" : "#2a1a00",
        border: highlighted ? "1px solid #f80" : "1px solid #553300",
        borderRadius: 3,
        fontSize: 11,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div onClick={onClick} style={{ cursor: "pointer", flex: 1 }}>
          <span style={{ color: "#f80", fontWeight: "bold" }}>{gb.gambitSan}</span>
          <span style={{ color: "#888" }}> → </span>
          <span style={{ color: "#e88" }}>{gb.responseSan}?</span>
          <span style={{ color: "#888" }}> ({(gb.responseProb * 100).toFixed(0)}%)</span>
          {gb.followUpSan && <>
            <span style={{ color: "#888" }}> → </span>
            <span style={{ color: "#8e8", fontWeight: "bold" }}>{gb.followUpSan}</span>
          </>}
        </div>
        <button onClick={onSave} style={{ ...buttonStyle, background: "#363", borderColor: "#5a5", fontSize: 10, padding: "2px 6px" }}>Save</button>
      </div>
      <div style={{ fontSize: 10, marginTop: 2, color: "#888" }}>
        <span style={{ color: gb.gambitDelta >= 0 ? "#8e8" : "#e88" }}>{gb.gambitDelta >= 0 ? "+" : ""}{(gb.gambitDelta / 100).toFixed(1)}p</span>
        <span style={{ color: "#555" }}>{" "}→{" "}</span>
        <span style={{ color: gb.blunderDelta >= 0 ? "#8e8" : "#e88" }}>{gb.blunderDelta >= 0 ? "+" : ""}{(gb.blunderDelta / 100).toFixed(1)}p</span>
        <span style={{ color: "#555" }}>{" "}→{" "}</span>
        <span style={{ color: "#8e8", fontWeight: "bold" }}>net +{(gb.netGain / 100).toFixed(1)}p</span>
        {gb.bestResponseSan && gb.bestResponseSan !== gb.responseSan && (
          <span style={{ color: "#666", marginLeft: 8 }}>
            best reply was <span style={{ color: "#888" }}>{gb.bestResponseSan}</span>
          </span>
        )}
      </div>
    </div>
  )
}

export default function App() {
  const canvasRef = useRef(null)
  const gameRef = useRef(null)
  const engineRef = useRef(null)
  const evalWorkerRef = useRef(null)
  const maiaWorkerRef = useRef(null)
  const analysisRef = useRef({ depth: 0, lines: [], fen: "", shallowEval: null })
  const maiaPredictionsRef = useRef({ fen: "", moves: [], winProb: null })
  const rafRef = useRef(null)
  const dragRef = useRef(null)
  const gambitSearchRef = useRef({ fen: null, cancelled: false })
  const maiaCallbacksRef = useRef(new Map()) // requestId -> callback
  const evalCallbackRef = useRef(null) // current eval callback

  const [fen, setFen] = useState("start")
  const [moveList, setMoveList] = useState([])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [selected, setSelected] = useState(null)
  const [flipped, setFlipped] = useState(false)
  const [engineReady, setEngineReady] = useState(false)
  const [evalDisplay, setEvalDisplay] = useState("")
  const [evalCp, setEvalCp] = useState(0)
  const [engineLines, setEngineLines] = useState([])
  const [engineDepth, setEngineDepth] = useState(0)
  const [maiaReady, setMaiaReady] = useState(false)
  const [maiaElo, setMaiaElo] = useState(1500)
  const [maiaPredictions, setMaiaPredictions] = useState([])
  const [maiaWinProb, setMaiaWinProb] = useState(null)
  const [maiaStatus, setMaiaStatus] = useState("Loading Maia3...")
  const [maxDepth, setMaxDepth] = useState(12)
  const [gambitResults, setGambitResults] = useState([])
  const [gambitSearching, setGambitSearching] = useState(false)
  const [savedGambits, setSavedGambits] = useState([])
  const [pinnedGambit, setPinnedGambit] = useState(null)
  const [selectedSavedIndex, setSelectedSavedIndex] = useState(null)

  // Init game
  useEffect(() => {
    const chess = new Chess()
    gameRef.current = {
      chess,
      selected: null,
      moveHistory: [{ san: null, fen: chess.fen() }],
      historyIndex: 0,
      flipped: false,
    }
    setFen(chess.fen())
  }, [])

  // Init Stockfish engine
  useEffect(() => {
    const engine = createEngine((msg) => {
      if (msg === "uciok") {
        sendToEngine(engine, "setoption name MultiPV value 3")
        sendToEngine(engine, "isready")
      }
      if (msg === "readyok") {
        setEngineReady(true)
      }
      if (typeof msg === "string" && msg.startsWith("info") && msg.includes(" pv ")) {
        parseAnalysisInfo(msg)
      }
    })
    engineRef.current = engine

    // Second Stockfish instance for gambit search evals
    const evalWorker = createEngine((msg) => {
      if (msg === "uciok") sendToEngine(evalWorker, "isready")
      if (typeof msg === "string" && msg.startsWith("info") && msg.includes(" pv ")) {
        const cb = evalCallbackRef.current
        if (!cb) return
        const depthMatch = msg.match(/\bdepth (\d+)/)
        const scoreMatch = msg.match(/\bscore (cp|mate) (-?\d+)/)
        if (!depthMatch || !scoreMatch) return
        const depth = parseInt(depthMatch[1])
        if (depth < cb.targetDepth) return
        const scoreType = scoreMatch[1]
        const scoreVal = parseInt(scoreMatch[2])
        const cp = scoreType === "mate"
          ? (scoreVal > 0 ? 10000 : -10000)
          : scoreVal
        evalCallbackRef.current = null
        sendToEngine(evalWorker, "stop")
        if (cb.wantPv) {
          const pvMatch = msg.match(/ pv (.+)/)
          const pv = pvMatch ? pvMatch[1].split(" ") : []
          cb.resolve({ cp, pv })
        } else {
          cb.resolve(cp)
        }
      }
    })
    evalWorkerRef.current = evalWorker

    return () => {
      if (engine) engine.terminate()
      if (evalWorker) evalWorker.terminate()
    }
  }, [])

  // Init Maia3 worker
  useEffect(() => {
    const worker = new Worker(BASE + "maia-worker.js")
    worker.onmessage = (e) => {
      const msg = e.data
      switch (msg.type) {
        case "status":
          setMaiaStatus(msg.message)
          break
        case "ready":
          setMaiaReady(true)
          setMaiaStatus("Maia3 ready")
          break
        case "prediction":
          if (msg.requestId && maiaCallbacksRef.current.has(msg.requestId)) {
            const cb = maiaCallbacksRef.current.get(msg.requestId)
            maiaCallbacksRef.current.delete(msg.requestId)
            cb(msg)
          } else {
            handleMaiaPrediction(msg)
          }
          break
        case "error":
          setMaiaStatus("Error: " + msg.message)
          break
      }
    }
    worker.postMessage({ type: "init" })
    maiaWorkerRef.current = worker

    return () => worker.terminate()
  }, [])

  // Promise-based helpers for gambit search
  const requestMaiaForGambit = useCallback((fenStr, eloSelf, legalMoves) => {
    return new Promise((resolve) => {
      const worker = maiaWorkerRef.current
      if (!worker) { resolve(null); return }
      const requestId = "gambit_" + Math.random().toString(36).slice(2)
      maiaCallbacksRef.current.set(requestId, resolve)
      worker.postMessage({
        type: "predict",
        fen: fenStr,
        eloSelf,
        eloOppo: eloSelf,
        legalMoves,
        requestId,
      })
    })
  }, [])

  const requestEvalForGambit = useCallback((fenStr, depth) => {
    return new Promise((resolve) => {
      const evalWorker = evalWorkerRef.current
      if (!evalWorker) { resolve(null); return }
      evalCallbackRef.current = { resolve, targetDepth: depth }
      sendToEngine(evalWorker, "stop")
      sendToEngine(evalWorker, "position fen " + fenStr)
      sendToEngine(evalWorker, "go depth " + depth)
    })
  }, [])

  const requestBestMoveForGambit = useCallback((fenStr, depth) => {
    return new Promise((resolve) => {
      const evalWorker = evalWorkerRef.current
      if (!evalWorker) { resolve(null); return }
      evalCallbackRef.current = { resolve, targetDepth: depth, wantPv: true }
      sendToEngine(evalWorker, "stop")
      sendToEngine(evalWorker, "position fen " + fenStr)
      sendToEngine(evalWorker, "go depth " + depth)
    })
  }, [])

  const runGambitSearch = useCallback((searchFen, e0, depth, elo) => {
    const search = gambitSearchRef.current
    search.fen = searchFen
    search.cancelled = false
    setGambitResults([])
    setGambitSearching(true)

    const chess = new Chess(searchFen)
    const legalMoves = chess.moves({ verbose: true })

    ;(async () => {
      for (const move of legalMoves) {
        if (search.cancelled || search.fen !== searchFen) break

        // Step 1: Play the candidate gambit move
        const afterGambit = new Chess(searchFen)
        const gambitMove = afterGambit.move({ from: move.from, to: move.to, promotion: move.promotion || "q" })
        if (!gambitMove) continue
        const fenAfterGambit = afterGambit.fen()

        // Step 2: Get Stockfish's best move for opponent (to annotate the blunder)
        // and get Maia prediction in parallel
        const opponentMoves = afterGambit.moves({ verbose: true })
        if (opponentMoves.length === 0) continue
        const opponentLegalUcis = opponentMoves.map(m => m.from + m.to + (m.promotion || ""))

        // Get Maia prediction for opponent's response
        const maiaPred = await requestMaiaForGambit(fenAfterGambit, elo, opponentLegalUcis)
        if (search.cancelled || search.fen !== searchFen) break
        if (!maiaPred || !maiaPred.moves || maiaPred.moves.length === 0) continue

        const topResponse = maiaPred.moves[0]

        // Step 3: Get Stockfish's best move for the opponent (what they should play)
        // This also gives us E1 (eval after gambit, from opponent's perspective)
        const bestForOpponent = await requestBestMoveForGambit(fenAfterGambit, depth)
        if (search.cancelled || search.fen !== searchFen) break
        if (!bestForOpponent) continue

        // E1 from gambiter's perspective (negate opponent's eval)
        const e1 = -bestForOpponent.cp

        // Convert Stockfish's best opponent move to SAN
        let bestResponseSan = null
        if (bestForOpponent.pv[0]) {
          const bestParsed = parseUciMove(bestForOpponent.pv[0])
          if (bestParsed) {
            try {
              const tempChess = new Chess(fenAfterGambit)
              const bestMove = tempChess.move(bestParsed)
              if (bestMove) bestResponseSan = bestMove.san
            } catch { /* skip */ }
          }
        }

        // Step 4: Play Maia's response (the blunder)
        const afterResponse = new Chess(fenAfterGambit)
        const parsed = parseUciMove(topResponse.uci)
        if (!parsed) continue
        let responseMove
        try {
          responseMove = afterResponse.move(parsed)
          if (!responseMove) continue
        } catch { continue }
        const fenAfterResponse = afterResponse.fen()

        // Step 5: Eval the position after the blunder + get our best follow-up
        const evalResult = await requestBestMoveForGambit(fenAfterResponse, depth)
        if (search.cancelled || search.fen !== searchFen) break
        if (!evalResult) continue

        const e2 = evalResult.cp

        // Convert our follow-up move to SAN
        let followUpSan = null
        if (evalResult.pv[0]) {
          const fuParsed = parseUciMove(evalResult.pv[0])
          if (fuParsed) {
            try {
              const tempChess = new Chess(fenAfterResponse)
              const fuMove = tempChess.move(fuParsed)
              if (fuMove) followUpSan = fuMove.san
            } catch { /* skip */ }
          }
        }

        // Good gambit: we end up better than before
        if (e2 > e0) {
          const netGain = e2 - e0
          const gambitDelta = e1 - e0  // cost of the sacrifice (negative)
          const blunderDelta = e2 - e1 // what the blunder gives back (positive)
          setGambitResults(prev => [...prev, {
            gambitSan: gambitMove.san,
            gambitFrom: move.from,
            gambitTo: move.to,
            gambitPromotion: move.promotion,
            responseSan: responseMove.san,
            responseProb: topResponse.probability,
            bestResponseSan,
            followUpSan,
            evalBefore: e0,
            evalAfter: e2,
            netGain,
            gambitDelta,
            blunderDelta,
            fen: searchFen,
          }])
        }
      }

      if (search.fen === searchFen) {
        setGambitSearching(false)
      }
    })()
  }, [requestMaiaForGambit, requestEvalForGambit, requestBestMoveForGambit])

  const handleMaiaPrediction = useCallback((msg) => {
    const g = gameRef.current
    if (!g || g.chess.fen() !== msg.fen) return

    const predictions = msg.moves.slice(0, 5).map(m => {
      const parsed = parseUciMove(m.uci)
      if (!parsed) return null
      try {
        const tempChess = new Chess(msg.fen)
        const move = tempChess.move(parsed)
        return move ? { uci: m.uci, san: move.san, probability: m.probability } : null
      } catch { return null }
    }).filter(Boolean)

    maiaPredictionsRef.current = { fen: msg.fen, moves: predictions, winProb: msg.winProb }
    setMaiaPredictions(predictions)
    setMaiaWinProb(msg.winProb)
  }, [])

  const requestMaiaPrediction = useCallback((fenStr) => {
    const worker = maiaWorkerRef.current
    const g = gameRef.current
    if (!worker || !maiaReady || !g) return

    const moves = g.chess.moves({ verbose: true })
    const legalMoves = moves.map(m => m.from + m.to + (m.promotion || ""))

    worker.postMessage({
      type: "predict",
      fen: fenStr,
      eloSelf: maiaElo,
      eloOppo: maiaElo,
      legalMoves,
    })
  }, [maiaReady, maiaElo])

  const parseAnalysisInfo = useCallback((msg) => {
    const a = analysisRef.current
    const depthMatch = msg.match(/\bdepth (\d+)/)
    const pvMatch = msg.match(/ pv (.+)/)
    const scoreMatch = msg.match(/\bscore (cp|mate) (-?\d+)/)
    const multipvMatch = msg.match(/\bmultipv (\d+)/)

    if (!depthMatch || !pvMatch || !scoreMatch) return

    const depth = parseInt(depthMatch[1])
    const pvMoves = pvMatch[1].split(" ")
    const scoreType = scoreMatch[1]
    const scoreVal = parseInt(scoreMatch[2])
    const pvIndex = multipvMatch ? parseInt(multipvMatch[1]) - 1 : 0
    const score = scoreType === "mate" ? { mate: scoreVal } : { cp: scoreVal }

    if (depth > a.depth || pvIndex === 0) {
      if (pvIndex === 0) a.depth = depth
      if (pvIndex === 0) a.lines = []
    }

    a.lines[pvIndex] = { score, pv: pvMoves, depth }

    if (pvIndex === 0 && depth === 3) {
      a.shallowEval = score.cp !== undefined ? score.cp : (score.mate > 0 ? 10000 : -10000)
    }

    if (pvIndex === 0) {
      const g = gameRef.current
      if (g) {
        const turn = g.chess.turn()
        const dispScore = { ...score }
        if (turn === "b" && dispScore.cp !== undefined) dispScore.cp = -dispScore.cp
        if (turn === "b" && dispScore.mate !== undefined) dispScore.mate = -dispScore.mate
        setEvalDisplay(formatEval(dispScore))
        setEvalCp(dispScore.cp !== undefined ? dispScore.cp : (dispScore.mate !== undefined ? (dispScore.mate > 0 ? 10000 : -10000) : 0))
      }
      setEngineDepth(depth)
    }

    const displayLines = a.lines.filter(Boolean).map((line, i) => {
      const g = gameRef.current
      if (!g) return null
      const turn = g.chess.turn()
      const dispScore = { ...line.score }
      if (turn === "b" && dispScore.cp !== undefined) dispScore.cp = -dispScore.cp
      if (turn === "b" && dispScore.mate !== undefined) dispScore.mate = -dispScore.mate

      const tempChess = new Chess(g.chess.fen())
      const sanMoves = []
      for (const uci of line.pv.slice(0, 6)) {
        const parsed = parseUciMove(uci)
        if (!parsed) break
        try {
          const move = tempChess.move(parsed)
          if (move) sanMoves.push(move.san)
          else break
        } catch { break }
      }

      return {
        score: formatEval(dispScore),
        moves: sanMoves.join(" "),
        firstMove: line.pv[0],
      }
    }).filter(Boolean)

    setEngineLines(displayLines)
  }, [])

  const startAnalysis = useCallback((fenStr) => {
    const engine = engineRef.current
    if (!engine || !engineReady) return
    analysisRef.current = { depth: 0, lines: [], fen: fenStr, shallowEval: null }

    // Cancel any in-progress gambit search
    gambitSearchRef.current.cancelled = true
    gambitSearchKeyRef.current = ""
    maiaCallbacksRef.current.clear()
    evalCallbackRef.current = null
    if (evalWorkerRef.current) sendToEngine(evalWorkerRef.current, "stop")

    setGambitResults([])
    setGambitSearching(false)

    sendToEngine(engine, "stop")
    sendToEngine(engine, "setoption name MultiPV value 3")
    sendToEngine(engine, "setoption name Skill Level value 20")
    sendToEngine(engine, "position fen " + fenStr)
    sendToEngine(engine, "go depth " + maxDepth)

    requestMaiaPrediction(fenStr)
  }, [engineReady, maxDepth, requestMaiaPrediction])

  useEffect(() => {
    if (fen !== "start" && engineReady) {
      startAnalysis(fen)
    }
  }, [fen, engineReady, startAnalysis])

  useEffect(() => {
    if (fen !== "start" && maiaReady) {
      requestMaiaPrediction(fen)
    }
  }, [maiaElo]) // eslint-disable-line react-hooks/exhaustive-deps

  // Trigger gambit search once main engine reaches depth 8
  // Re-runs when elo, minProb, or depth settings change
  const gambitSearchKeyRef = useRef("")
  useEffect(() => {
    if (engineDepth < 8 || !maiaReady) return
    const a = analysisRef.current
    if (!a.lines[0] || a.fen !== fen || fen === "start") return

    const searchKey = `${fen}|${maiaElo}|${maxDepth}`
    if (gambitSearchKeyRef.current === searchKey) return
    gambitSearchKeyRef.current = searchKey

    // Cancel any existing search before starting new one
    gambitSearchRef.current.cancelled = true

    const e0 = a.lines[0].score.cp !== undefined
      ? a.lines[0].score.cp
      : (a.lines[0].score.mate > 0 ? 10000 : -10000)

    runGambitSearch(fen, e0, maxDepth, maiaElo)
  }, [engineDepth, fen, maiaReady, maxDepth, maiaElo, runGambitSearch])

  const makeMove = useCallback((from, to, promotion) => {
    const g = gameRef.current
    if (!g) return false
    try {
      const move = g.chess.move({ from, to, promotion: promotion || "q" })
      if (!move) return false

      g.moveHistory = g.moveHistory.slice(0, g.historyIndex + 1)
      g.moveHistory.push({ san: move.san, fen: g.chess.fen() })
      g.historyIndex = g.moveHistory.length - 1
      g.selected = null

      setFen(g.chess.fen())
      setMoveList(g.moveHistory.map(h => h.san))
      setHistoryIndex(g.historyIndex)
      setSelected(null)

      return true
    } catch {
      return false
    }
  }, [])

  const navigateTo = useCallback((index) => {
    const g = gameRef.current
    if (!g || index < 0 || index >= g.moveHistory.length) return
    g.historyIndex = index
    g.chess.load(g.moveHistory[index].fen)
    g.selected = null
    setFen(g.chess.fen())
    setHistoryIndex(index)
    setSelected(null)
  }, [])

  const handleMouseDown = useCallback((e) => {
    const g = gameRef.current
    if (!g) return
    const rect = canvasRef.current.getBoundingClientRect()
    const scale = BOARD_SIZE / rect.width
    const mx = (e.clientX - rect.left) * scale
    const my = (e.clientY - rect.top) * scale
    const sq = coordsToSquare(mx, my, g.flipped)
    if (!sq) return

    const piece = g.chess.get(sq)

    if (g.selected) {
      if (makeMove(g.selected, sq)) return
      if (piece && piece.color === g.chess.turn()) {
        g.selected = sq
        setSelected(sq)
        dragRef.current = { piece: piece.color + piece.type, square: sq, x: mx, y: my }
        return
      }
      g.selected = null
      setSelected(null)
      return
    }

    if (piece && piece.color === g.chess.turn()) {
      g.selected = sq
      setSelected(sq)
      dragRef.current = { piece: piece.color + piece.type, square: sq, x: mx, y: my }
    }
  }, [makeMove])

  const handleMouseMove = useCallback((e) => {
    if (!dragRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const scale = BOARD_SIZE / rect.width
    dragRef.current.x = (e.clientX - rect.left) * scale
    dragRef.current.y = (e.clientY - rect.top) * scale
  }, [])

  const handleMouseUp = useCallback((e) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    const g = gameRef.current
    if (!g) return
    const rect = canvasRef.current.getBoundingClientRect()
    const scale = BOARD_SIZE / rect.width
    const mx = (e.clientX - rect.left) * scale
    const my = (e.clientY - rect.top) * scale
    const sq = coordsToSquare(mx, my, g.flipped)
    if (sq && sq !== drag.square) {
      if (makeMove(drag.square, sq)) return
    }
  }, [makeMove])

  useEffect(() => {
    const handler = (e) => {
      const g = gameRef.current
      if (!g) return
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        navigateTo(g.historyIndex - 1)
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        navigateTo(g.historyIndex + 1)
      } else if (e.key === "f" || e.key === "F") {
        setFlipped(f => {
          g.flipped = !f
          return !f
        })
      } else if (e.key === "Escape") {
        g.selected = null
        setSelected(null)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [navigateTo])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const g = gameRef.current
    if (!canvas || !g) return
    const ctx = canvas.getContext("2d")
    const analysis = analysisRef.current

    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const isLight = (rank + file) % 2 === 0
        ctx.fillStyle = isLight ? LIGHT_SQ : DARK_SQ
        const displayFile = g.flipped ? 7 - file : file
        const displayRank = g.flipped ? 7 - rank : rank
        ctx.fillRect(displayFile * SQ, displayRank * SQ, SQ, SQ)
      }
    }

    ctx.font = "bold 10px monospace"
    for (let i = 0; i < 8; i++) {
      const file = g.flipped ? 7 - i : i
      const rank = g.flipped ? 7 - i : i
      ctx.fillStyle = i % 2 === 0 ? DARK_SQ : LIGHT_SQ
      ctx.textAlign = "left"
      ctx.textBaseline = "bottom"
      ctx.fillText(FILES[file], i * SQ + 2, BOARD_SIZE - 2)
      ctx.fillStyle = i % 2 === 0 ? LIGHT_SQ : DARK_SQ
      ctx.textAlign = "left"
      ctx.textBaseline = "top"
      ctx.fillText(RANKS[rank], 2, i * SQ + 2)
    }

    if (g.selected) {
      const { x, y } = squareToCoords(g.selected, g.flipped)
      ctx.fillStyle = HIGHLIGHT_COLOR
      ctx.fillRect(x, y, SQ, SQ)
    }

    if (g.selected) {
      const moves = g.chess.moves({ square: g.selected, verbose: true })
      for (const move of moves) {
        const { x, y } = squareToCoords(move.to, g.flipped)
        const captured = g.chess.get(move.to)
        if (captured) {
          ctx.strokeStyle = LEGAL_DOT_COLOR
          ctx.lineWidth = 3
          ctx.beginPath()
          ctx.arc(x + SQ / 2, y + SQ / 2, SQ / 2 - 4, 0, Math.PI * 2)
          ctx.stroke()
        } else {
          ctx.fillStyle = LEGAL_DOT_COLOR
          ctx.beginPath()
          ctx.arc(x + SQ / 2, y + SQ / 2, SQ / 6, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }

    const board = g.chess.board()
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.font = `${SQ * 0.75}px serif`
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const piece = board[rank][file]
        if (!piece) continue
        const sq = FILES[file] + RANKS[rank]
        if (dragRef.current && dragRef.current.square === sq) continue
        const displayFile = g.flipped ? 7 - file : file
        const displayRank = g.flipped ? 7 - rank : rank
        const key = piece.color === "w" ? piece.type.toUpperCase() : piece.type.toLowerCase()
        ctx.fillStyle = piece.color === "w" ? "#fff" : "#000"
        ctx.strokeStyle = piece.color === "w" ? "#000" : "#fff"
        ctx.lineWidth = 1
        ctx.strokeText(PIECE_CHARS[key], displayFile * SQ + SQ / 2, displayRank * SQ + SQ / 2)
        ctx.fillText(PIECE_CHARS[key], displayFile * SQ + SQ / 2, displayRank * SQ + SQ / 2)
      }
    }

    if (analysis.lines.length > 0 && analysis.fen === g.chess.fen()) {
      for (let i = Math.min(analysis.lines.length, 3) - 1; i >= 0; i--) {
        const line = analysis.lines[i]
        if (!line || !line.pv[0]) continue
        const parsed = parseUciMove(line.pv[0])
        if (!parsed) continue
        const from = squareToCoords(parsed.from, g.flipped)
        const to = squareToCoords(parsed.to, g.flipped)
        drawArrow(ctx, from.x + SQ / 2, from.y + SQ / 2, to.x + SQ / 2, to.y + SQ / 2, ARROW_COLORS[i], i === 0 ? 6 : 4)
      }
    }

    if (dragRef.current) {
      const drag = dragRef.current
      const key = drag.piece[0] === "w" ? drag.piece[1].toUpperCase() : drag.piece[1].toLowerCase()
      ctx.fillStyle = drag.piece[0] === "w" ? "#fff" : "#000"
      ctx.strokeStyle = drag.piece[0] === "w" ? "#000" : "#fff"
      ctx.lineWidth = 1
      ctx.strokeText(PIECE_CHARS[key], drag.x, drag.y)
      ctx.fillText(PIECE_CHARS[key], drag.x, drag.y)
    }

    rafRef.current = requestAnimationFrame(draw)
  }, [])

  function drawArrow(ctx, x1, y1, x2, y2, color, width) {
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.hypot(dx, dy)
    if (len < 1) return
    const nx = dx / len
    const ny = dy / len
    const headLen = width * 3

    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = width
    ctx.lineCap = "round"

    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2 - nx * headLen, y2 - ny * headLen)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(x2, y2)
    ctx.lineTo(x2 - nx * headLen - ny * width * 1.5, y2 - ny * headLen + nx * width * 1.5)
    ctx.lineTo(x2 - nx * headLen + ny * width * 1.5, y2 - ny * headLen - nx * width * 1.5)
    ctx.closePath()
    ctx.fill()
  }

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw])

  const saveGambit = useCallback((gambit) => {
    const g = gameRef.current
    if (!g) return
    const moveNum = Math.ceil(g.historyIndex / 2)
    const turnLabel = g.chess.turn() === "w" ? "White" : "Black"
    const label = `${turnLabel} ${moveNum}. ${gambit.gambitSan} → ${gambit.responseSan} (${(gambit.responseProb * 100).toFixed(0)}%) net ${(gambit.netGain / 100).toFixed(1)}p`
    setSavedGambits(prev => [...prev, {
      ...gambit,
      label,
    }])
  }, [])

  const resetBoard = useCallback(() => {
    const g = gameRef.current
    if (!g) return
    g.chess.reset()
    g.moveHistory = [{ san: null, fen: g.chess.fen() }]
    g.historyIndex = 0
    g.selected = null
    setFen(g.chess.fen())
    setMoveList([{ san: null, fen: g.chess.fen() }].map(h => h.san))
    setHistoryIndex(0)
    setSelected(null)
  }, [])

  const controlStyle = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
    fontSize: 13,
    fontFamily: "monospace",
    color: "#ccc",
  }

  const buttonStyle = {
    padding: "4px 10px",
    background: "#333",
    border: "1px solid #555",
    borderRadius: 4,
    color: "#ccc",
    fontSize: 12,
    fontFamily: "monospace",
    cursor: "pointer",
  }

  const sliderStyle = {
    width: 120,
    accentColor: "#888",
  }

  const labelStyle = {
    display: "inline-block",
    minWidth: 240,
  }

  return (
    <div style={{ padding: "16px", fontFamily: "monospace", color: "#ccc", background: "#1a1a1a", minHeight: "100vh" }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 18, color: "#fff" }}>Bamboozle Lab</h2>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#888", maxWidth: 600, lineHeight: 1.5 }}>
        Play moves on the board and this tool will find bamboozles — moves where a human
        opponent (modeled by <a href="https://github.com/CSSLab/maia-chess" style={{ color: "#6b8" }}>Maia</a> at the Elo you set) is likely to respond poorly. A good bamboozle is
        a move where the expected human response leaves you better off than before you played it,
        whether it's an unsound sacrifice or simply a strong move that provokes errors.
      </p>

      {/* Controls */}
      <div style={{ marginBottom: 12 }}>
        <div style={controlStyle}>
          <button onClick={() => { const g = gameRef.current; if (g) { g.flipped = !g.flipped; setFlipped(f => !f) } }} style={buttonStyle}>
            Flip Board
          </button>
          <button onClick={resetBoard} style={buttonStyle}>Reset</button>
          <button onClick={() => navigateTo(historyIndex - 1)} style={buttonStyle}>&larr;</button>
          <button onClick={() => navigateTo(historyIndex + 1)} style={buttonStyle}>&rarr;</button>
          <span style={{ color: "#666", marginLeft: 8 }}>
            {engineReady ? `Depth: ${engineDepth}` : "Loading engine..."}
          </span>
        </div>

        <div style={controlStyle}>
          <label style={labelStyle}>Maia Elo: {maiaElo}</label>
          <input type="range" min={1100} max={1900} step={50} value={maiaElo} onChange={e => setMaiaElo(parseInt(e.target.value))} style={sliderStyle} />
        </div>
        <div style={controlStyle}>
          <label style={labelStyle}>Search Depth: {maxDepth} ply ({Math.floor(maxDepth / 2)} moves)</label>
          <input type="range" min={8} max={25} value={maxDepth} onChange={e => setMaxDepth(parseInt(e.target.value))} style={sliderStyle} />
        </div>
      </div>

      {/* Main layout */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {/* Board + eval bar */}
        <div style={{ display: "flex", gap: 8 }}>
          <canvas
            ref={canvasRef}
            width={BOARD_SIZE}
            height={BOARD_SIZE}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            style={{
              width: BOARD_SIZE,
              height: BOARD_SIZE,
              cursor: "pointer",
              borderRadius: 4,
              border: "2px solid #444",
            }}
          />
          {/* Eval bar */}
          {(() => {
            const whitePct = Math.max(2, Math.min(98, 50 + 50 * (2 / (1 + Math.exp(-evalCp / 200)) - 1)))
            const blackPct = 100 - whitePct
            return (
              <div style={{
                width: 24,
                height: BOARD_SIZE,
                borderRadius: 4,
                border: "2px solid #444",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                position: "relative",
              }}>
                <div style={{ height: `${flipped ? whitePct : blackPct}%`, background: flipped ? "#eee" : "#333", transition: "height 0.3s ease" }} />
                <div style={{ height: `${flipped ? blackPct : whitePct}%`, background: flipped ? "#333" : "#eee", transition: "height 0.3s ease" }} />
                <div style={{
                  position: "absolute",
                  top: "50%",
                  left: 0,
                  right: 0,
                  transform: "translateY(-50%)",
                  textAlign: "center",
                  fontSize: 9,
                  fontWeight: "bold",
                  fontFamily: "monospace",
                  color: whitePct > 50 ? "#333" : "#ccc",
                  lineHeight: 1,
                  pointerEvents: "none",
                }}>
                  {evalDisplay}
                </div>
              </div>
            )
          })()}
        </div>

        {/* Side panel */}
        <div style={{ width: 280, fontSize: 13 }}>
          {/* Engine lines */}
          <div style={{ marginBottom: 12, minHeight: 70 }}>
            <div style={{ color: "#888", marginBottom: 4, fontSize: 11, textTransform: "uppercase" }}>Stockfish {engineDepth > 0 && <span style={{ color: "#666" }}>d{engineDepth}</span>}</div>
            {engineLines.map((line, i) => (
              <div key={i} onClick={() => { const m = parseUciMove(line.firstMove); if (m) makeMove(m.from, m.to, m.promotion) }} style={{ marginBottom: 2, color: i === 0 ? "#ccc" : "#777", cursor: "pointer" }}>
                <span style={{ color: line.score.startsWith("-") ? "#e88" : line.score.startsWith("+") ? "#8e8" : "#aaa", fontWeight: "bold", marginRight: 6 }}>
                  {line.score}
                </span>
                {line.moves}
              </div>
            ))}
          </div>

          {/* Maia predictions */}
          <div style={{ marginBottom: 12, minHeight: 70 }}>
            <div style={{ color: "#6b8", marginBottom: 4, fontSize: 11, textTransform: "uppercase" }}>
              Maia3 ({maiaElo} Elo) {!maiaReady && <span style={{ color: "#888" }}>{maiaStatus}</span>}
            </div>
            {maiaPredictions.map((pred, i) => (
              <div key={i}
                onClick={() => { const m = parseUciMove(pred.uci); if (m) makeMove(m.from, m.to, m.promotion) }}
                style={{ marginBottom: 3, color: i === 0 ? "#ccc" : "#888", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
              >
                <span style={{ color: "#6b8", fontWeight: "bold", minWidth: 42, fontSize: 12 }}>
                  {(pred.probability * 100).toFixed(1)}%
                </span>
                <span style={{ minWidth: 40 }}>{pred.san}</span>
                <div style={{ flex: 1, height: 4, background: "#333", borderRadius: 2 }}>
                  <div style={{ width: `${pred.probability * 100}%`, height: "100%", background: i === 0 ? "#6b8" : "#465", borderRadius: 2 }} />
                </div>
              </div>
            ))}
            {maiaWinProb && (
              <div style={{ fontSize: 10, color: "#666", marginTop: 4 }}>
                W {(maiaWinProb.w * 100).toFixed(0)}% D {(maiaWinProb.d * 100).toFixed(0)}% L {(maiaWinProb.l * 100).toFixed(0)}%
              </div>
            )}
          </div>

          {/* Gambit search results */}
          <div style={{ marginBottom: 12, minHeight: 40 }}>
            <div style={{ color: "#f80", marginBottom: 4, fontSize: 11, textTransform: "uppercase" }}>
              Bamboozles {gambitSearching && <span style={{ color: "#888" }}>(searching...)</span>}
              {!gambitSearching && gambitResults.length === 0 && !pinnedGambit && engineDepth >= 8 && <span style={{ color: "#666" }}>(none found)</span>}
            </div>
            {/* Pinned gambit (persists across position changes) */}
            {pinnedGambit && (
              <GambitPane gb={pinnedGambit} highlighted onClick={() => { setPinnedGambit(null); setSelectedSavedIndex(null) }} onSave={() => saveGambit(pinnedGambit)} buttonStyle={buttonStyle} />
            )}
            {gambitResults.map((gb, i) => (
              <GambitPane key={i} gb={gb} onClick={() => { setPinnedGambit(gb); setSelectedSavedIndex(null); makeMove(gb.gambitFrom, gb.gambitTo, gb.gambitPromotion) }} onSave={() => saveGambit(gb)} buttonStyle={buttonStyle} />
            ))}
          </div>

        </div>
      </div>

      {/* Below board: Saved bamboozles and Move history */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 12, fontSize: 13 }}>
        {/* Saved bamboozles */}
        {savedGambits.length > 0 && (
          <div style={{ minWidth: 280 }}>
            <div style={{ color: "#888", marginBottom: 4, fontSize: 11, textTransform: "uppercase" }}>Saved Bamboozles</div>
            {savedGambits.map((gb, i) => (
              <div
                key={i}
                onClick={() => {
                  const g = gameRef.current
                  if (!g) return
                  setSelectedSavedIndex(i)
                  setPinnedGambit(gb)
                  const idx = g.moveHistory.findIndex(h => h.fen === gb.fen)
                  if (idx >= 0) {
                    navigateTo(idx)
                  } else {
                    g.chess.load(gb.fen)
                    g.moveHistory = [{ san: null, fen: gb.fen }]
                    g.historyIndex = 0
                    g.selected = null
                    setFen(gb.fen)
                    setMoveList([null])
                    setHistoryIndex(0)
                    setSelected(null)
                  }
                }}
                style={{
                  padding: "4px 6px",
                  marginBottom: 3,
                  background: selectedSavedIndex === i ? "#2a2200" : "#2a1a00",
                  border: selectedSavedIndex === i ? "1px solid #f80" : "1px solid #553300",
                  borderRadius: 3,
                  cursor: "pointer",
                  color: "#ddd",
                  fontSize: 11,
                }}
              >
                <span style={{ color: "#f80", fontWeight: "bold" }}>{gb.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Move history */}
        <div style={{ minWidth: 280 }}>
          <div style={{ color: "#888", marginBottom: 4, fontSize: 11, textTransform: "uppercase" }}>Moves</div>
          <div style={{ maxHeight: 200, overflowY: "auto", lineHeight: 1.8 }}>
            {moveList.slice(1).map((san, i) => {
              const moveNum = Math.floor(i / 2) + 1
              const isWhite = i % 2 === 0
              return (
                <span key={i}>
                  {isWhite && <span style={{ color: "#666" }}>{moveNum}. </span>}
                  <span
                    onClick={() => navigateTo(i + 1)}
                    style={{
                      cursor: "pointer",
                      color: i + 1 === historyIndex ? "#fff" : "#999",
                      fontWeight: i + 1 === historyIndex ? "bold" : "normal",
                      marginRight: 4,
                    }}
                  >
                    {san}
                  </span>
                </span>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
