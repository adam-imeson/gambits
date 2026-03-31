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

export default function App() {
  const canvasRef = useRef(null)
  const gameRef = useRef(null)
  const engineRef = useRef(null)
  const evalWorkerRef = useRef(null)
  const maiaWorkerRef = useRef(null)
  const analysisRef = useRef({ depth: 0, lines: [], fen: "", shallowEval: null })
  const maiaPredictionsRef = useRef({ fen: "", moves: [], winProb: null })
  const pendingEvalRef = useRef(null)
  const rafRef = useRef(null)
  const dragRef = useRef(null)

  const [fen, setFen] = useState("start")
  const [moveList, setMoveList] = useState([])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [selected, setSelected] = useState(null)
  const [flipped, setFlipped] = useState(false)
  const [engineReady, setEngineReady] = useState(false)
  const [evalDisplay, setEvalDisplay] = useState("")
  const [engineLines, setEngineLines] = useState([])
  const [engineDepth, setEngineDepth] = useState(0)
  const [maiaReady, setMaiaReady] = useState(false)
  const [maiaElo, setMaiaElo] = useState(1500)
  const [maiaPredictions, setMaiaPredictions] = useState([])
  const [maiaWinProb, setMaiaWinProb] = useState(null)
  const [maiaStatus, setMaiaStatus] = useState("Loading Maia3...")
  const [gambitThreshold, setGambitThreshold] = useState(100)
  const [maxDepth, setMaxDepth] = useState(16)
  const [gambitAlert, setGambitAlert] = useState(null)
  const [savedGambits, setSavedGambits] = useState([])

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

    // Second Stockfish instance for quick one-off evals (when Maia's move isn't in MultiPV)
    const evalWorker = createEngine((msg) => {
      if (msg === "uciok") sendToEngine(evalWorker, "isready")
      if (typeof msg === "string" && msg.startsWith("info") && msg.includes(" pv ")) {
        const pending = pendingEvalRef.current
        if (!pending) return
        const depthMatch = msg.match(/\bdepth (\d+)/)
        const scoreMatch = msg.match(/\bscore (cp|mate) (-?\d+)/)
        if (!depthMatch || !scoreMatch) return
        const depth = parseInt(depthMatch[1])
        if (depth < 10) return
        const scoreType = scoreMatch[1]
        const scoreVal = parseInt(scoreMatch[2])
        const cp = scoreType === "mate"
          ? (scoreVal > 0 ? -10000 : 10000)
          : -scoreVal
        const currentFen = gameRef.current?.chess.fen()
        if (currentFen !== pending.fen) { pendingEvalRef.current = null; return }
        const disagreement = pending.bestCp - cp
        if (disagreement > gambitThreshold) {
          setGambitAlert({
            disagreement,
            stockfishBestEval: pending.bestCp,
            maiaTopSan: pending.maiaTop.san,
            maiaTopProb: pending.maiaTop.probability,
            maiaMoveCp: cp,
            stockfishDepth: analysisRef.current.depth,
            fen: pending.fen,
          })
        } else {
          setGambitAlert(null)
        }
        pendingEvalRef.current = null
        sendToEngine(evalWorker, "stop")
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
          handleMaiaPrediction(msg)
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

  const checkMaiaGambit = useCallback(() => {
    const strong = analysisRef.current
    const maia = maiaPredictionsRef.current

    if (strong.fen !== maia.fen || !strong.fen) { setGambitAlert(null); return }
    if (strong.depth < 8 || !maia.moves.length) return

    const stockfishBest = strong.lines[0]
    if (!stockfishBest) return

    const bestCp = stockfishBest.score.cp !== undefined
      ? stockfishBest.score.cp
      : (stockfishBest.score.mate > 0 ? 10000 : -10000)

    const maiaTop = maia.moves[0]
    const sfBestUci = stockfishBest.pv[0]

    if (maiaTop.uci === sfBestUci) { setGambitAlert(null); return }

    let maiaMoveCp = null
    for (const line of strong.lines) {
      if (line && line.pv[0] === maiaTop.uci) {
        maiaMoveCp = line.score.cp !== undefined
          ? line.score.cp
          : (line.score.mate > 0 ? 10000 : -10000)
        break
      }
    }

    if (maiaMoveCp === null) {
      const evalWorker = evalWorkerRef.current
      if (!evalWorker) return
      const tempChess = new Chess(strong.fen)
      const parsed = parseUciMove(maiaTop.uci)
      if (!parsed) return
      try {
        const move = tempChess.move(parsed)
        if (!move) return
      } catch { return }
      pendingEvalRef.current = { fen: strong.fen, maiaTop, bestCp }
      sendToEngine(evalWorker, "stop")
      sendToEngine(evalWorker, "position fen " + tempChess.fen())
      sendToEngine(evalWorker, "go depth 12")
      return
    }

    const disagreement = bestCp - maiaMoveCp

    if (disagreement > gambitThreshold) {
      setGambitAlert({
        disagreement,
        stockfishBestEval: bestCp,
        maiaTopSan: maiaTop.san,
        maiaTopProb: maiaTop.probability,
        maiaMoveCp,
        stockfishDepth: strong.depth,
        fen: strong.fen,
      })
    } else {
      setGambitAlert(null)
    }
  }, [gambitThreshold])

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
    checkMaiaGambit()
  }, [checkMaiaGambit])

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
      }
      setEngineDepth(depth)
      checkMaiaGambit()
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
    setGambitAlert(null)
    pendingEvalRef.current = null
    if (evalWorkerRef.current) sendToEngine(evalWorkerRef.current, "stop")
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

  const saveGambit = useCallback(() => {
    const g = gameRef.current
    if (!g || !gambitAlert) return
    const fenStr = g.chess.fen()
    const lastMove = g.historyIndex > 0 ? g.moveHistory[g.historyIndex]?.san : null
    const moveNum = Math.ceil(g.historyIndex / 2)
    const turnLabel = g.chess.turn() === "w" ? "Black" : "White"
    const label = `${turnLabel} ${moveNum}. ${lastMove || "?"} — human plays ${gambitAlert.maiaTopSan} (${(gambitAlert.disagreement / 100).toFixed(1)}p)`
    setSavedGambits(prev => [...prev, {
      fen: fenStr,
      move: lastMove,
      disagreement: gambitAlert.disagreement,
      strongLines: [...engineLines],
      maiaPredictions: [...maiaPredictions],
      label,
    }])
  }, [gambitAlert, engineLines, maiaPredictions])

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
      <h2 style={{ margin: "0 0 12px", fontSize: 18, color: "#fff" }}>Chess Gambit Generator</h2>

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
          <span style={{ color: evalDisplay.startsWith("-") ? "#e88" : evalDisplay.startsWith("+") ? "#8e8" : "#aaa", fontWeight: "bold", marginLeft: 4 }}>
            {evalDisplay}
          </span>
        </div>

        <div style={controlStyle}>
          <label style={labelStyle}>Maia Elo: {maiaElo}</label>
          <input type="range" min={1100} max={1900} step={50} value={maiaElo} onChange={e => setMaiaElo(parseInt(e.target.value))} style={sliderStyle} />
        </div>
        <div style={controlStyle}>
          <label style={labelStyle}>Gambit Threshold: {(gambitThreshold / 100).toFixed(1)} pawns</label>
          <input type="range" min={10} max={300} step={10} value={gambitThreshold} onChange={e => setGambitThreshold(parseInt(e.target.value))} style={sliderStyle} />
        </div>
        <div style={controlStyle}>
          <label style={labelStyle}>Max Search Depth: {maxDepth}</label>
          <input type="range" min={8} max={25} value={maxDepth} onChange={e => setMaxDepth(parseInt(e.target.value))} style={sliderStyle} />
        </div>
      </div>

      {/* Main layout */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {/* Board */}
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

        {/* Side panel */}
        <div style={{ width: 280, fontSize: 13 }}>
          {/* Engine lines */}
          <div style={{ marginBottom: 12, minHeight: 70 }}>
            <div style={{ color: "#888", marginBottom: 4, fontSize: 11, textTransform: "uppercase" }}>Strong Engine {engineDepth > 0 && <span style={{ color: "#666" }}>d{engineDepth}</span>}</div>
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

          {/* Gambit alert */}
          {gambitAlert && (
            <div style={{ marginBottom: 12, padding: "6px 8px", background: "#2a1a00", border: "1px solid #f80", borderRadius: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "#f80", fontWeight: "bold", fontSize: 12 }}>Gambit detected!</span>
                <button onClick={saveGambit} style={{ ...buttonStyle, background: "#363", borderColor: "#5a5", fontSize: 11 }}>Save</button>
              </div>
              <div style={{ fontSize: 11, color: "#ccc", marginTop: 4 }}>
                Human plays <span style={{ color: "#6b8", fontWeight: "bold" }}>{gambitAlert.maiaTopSan}</span>
                <span style={{ color: "#888" }}> ({(gambitAlert.maiaTopProb * 100).toFixed(0)}% likely)</span>
                {" "}instead of best move
              </div>
              <div style={{ fontSize: 11, color: "#ccc", marginTop: 2 }}>
                Eval gap: <span style={{ color: "#f80", fontWeight: "bold" }}>{(gambitAlert.disagreement / 100).toFixed(1)} pawns</span>
              </div>
            </div>
          )}

          {/* Saved gambits */}
          {savedGambits.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: "#888", marginBottom: 4, fontSize: 11, textTransform: "uppercase" }}>Saved Gambits</div>
              {savedGambits.map((gb, i) => (
                <div
                  key={i}
                  onClick={() => {
                    const g = gameRef.current
                    if (g) {
                      g.chess.load(gb.fen)
                      g.moveHistory = g.moveHistory.slice(0, g.historyIndex + 1)
                      g.moveHistory.push({ san: null, fen: gb.fen })
                      g.historyIndex = g.moveHistory.length - 1
                      g.selected = null
                      setFen(gb.fen)
                      setMoveList(g.moveHistory.map(h => h.san))
                      setHistoryIndex(g.historyIndex)
                      setSelected(null)
                    }
                  }}
                  style={{
                    padding: "4px 6px",
                    marginBottom: 3,
                    background: "#2a1a00",
                    border: "1px solid #553300",
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
          <div>
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
    </div>
  )
}
