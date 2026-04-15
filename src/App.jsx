
// ============================================================
// MATRIZ McKINSEY — App Multiempresa con Supabase + Real-time
// ============================================================
// CONFIGURACIÓN: Reemplazá estos valores con los tuyos de Supabase
// Dashboard → Settings → API
// ============================================================

import { useState, useEffect, useRef, useCallback } from "react";

// ── CONFIGURACIÓN SUPABASE ──────────────────────────────────
// Reemplazá con tus credenciales reales de Supabase
const SUPABASE_URL = "https://jawuvexpnrzgschkhbom.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_FXjDmTEoZd9L9BpFbhjypA_eFeKVQMA";

// ── CONSTANTES ──────────────────────────────────────────────
const ADMIN_PASSWORD = "admin2024";

const COLORS = [
  "#e74c3c","#3498db","#2ecc71","#f39c12",
  "#9b59b6","#1abc9c","#e67e22","#e91e63",
  "#00bcd4","#ff5722","#607d8b","#795548",
];

const PHASES = {
  SETUP: "setup", VOTING: "voting",
  REVEAL: "reveal", DISCUSSION: "discussion", RESULTS: "results",
};
const PHASE_ORDER = ["setup","voting","reveal","discussion","results"];
const PHASE_LABELS = {
  setup:"Setup", voting:"Votación", reveal:"Revelación",
  discussion:"Discusión", results:"Resultados",
};

// ── HELPERS ──────────────────────────────────────────────────
function uid() { return Math.random().toString(36).slice(2,9); }
function emptyMatrix() {
  return Array(3).fill(null).map(() => Array(3).fill(null).map(() => []));
}
function defaultSession() {
  return {
    phase: PHASES.SETUP,
    votingOpen: false,
    businesses: [],
    participants: {},
    votes: {},
    consensusMatrix: emptyMatrix(),
    discussion: [],
  };
}

// ── SUPABASE CLIENT (sin librería, fetch puro) ────────────────
class SupabaseClient {
  constructor(url, key) {
    this.url = url;
    this.key = key;
    this.headers = {
      "Content-Type": "application/json",
      "apikey": key,
      "Authorization": `Bearer ${key}`,
    };
  }

  async query(table, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${this.url}/rest/v1/${table}?${qs}`, {
      headers: { ...this.headers, "Prefer": "return=representation" },
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async upsert(table, data) {
    const res = await fetch(`${this.url}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...this.headers, "Prefer": "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async update(table, match, data) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(match).map(([k,v])=>[k, `eq.${v}`]))
    ).toString();
    const res = await fetch(`${this.url}/rest/v1/${table}?${qs}`, {
      method: "PATCH",
      headers: { ...this.headers, "Prefer": "return=representation" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async delete(table, match) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(match).map(([k,v])=>[k, `eq.${v}`]))
    ).toString();
    const res = await fetch(`${this.url}/rest/v1/${table}?${qs}`, {
      method: "DELETE",
      headers: this.headers,
    });
    if (!res.ok) throw new Error(await res.text());
  }

  // Realtime via Server-Sent Events
  subscribe(table, filter, callback) {
    const params = new URLSearchParams({
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
    });
    const channel = `realtime:public:${table}${filter ? `:${filter}` : ""}`;
    // Supabase realtime v2 websocket approach simplified
    // For production use @supabase/supabase-js
    return { unsubscribe: () => {} };
  }
}

const db = new SupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── FALLBACK LOCAL STORAGE ────────────────────────────────────
const localStore = {
  get: (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ── HOOK: sesión persistida ───────────────────────────────────
function useSession(companyId, sessionId) {
  const [session, setSessionLocal] = useState(null);
  const [loading, setLoading] = useState(true);
  const storageKey = `mckinsey_${companyId}_${sessionId}`;
  const pollRef = useRef(null);

  const persist = useCallback(async (newSession) => {
    setSessionLocal(newSession);
    localStore.set(storageKey, newSession);
    try {
      await db.upsert("mckinsey_sessions", {
        id: sessionId,
        company_id: companyId,
        data: newSession,
        updated_at: new Date().toISOString(),
      });
    } catch (e) {
      console.warn("Supabase save failed, using local:", e.message);
    }
  }, [companyId, sessionId, storageKey]);

  const fetchSession = useCallback(async () => {
    try {
      const rows = await db.query("mckinsey_sessions", {
        id: `eq.${sessionId}`,
        company_id: `eq.${companyId}`,
        select: "data,updated_at",
      });
      if (rows && rows[0]) {
        const remote = rows[0].data;
        setSessionLocal(remote);
        localStore.set(storageKey, remote);
        return remote;
      }
    } catch (e) {
      console.warn("Supabase fetch failed, using local:", e.message);
    }
    const local = localStore.get(storageKey);
    if (local) { setSessionLocal(local); return local; }
    const fresh = defaultSession();
    setSessionLocal(fresh);
    return fresh;
  }, [companyId, sessionId, storageKey]);

  useEffect(() => {
    setLoading(true);
    fetchSession().finally(() => setLoading(false));
    // Poll cada 3 segundos para simular realtime sin librería
    pollRef.current = setInterval(fetchSession, 3000);
    return () => clearInterval(pollRef.current);
  }, [fetchSession]);

  return { session, persist, loading };
}

// ── TOUCH DRAG GLOBAL STATE ──────────────────────────────────
// Usamos una variable global para pasar el item que se está arrastrando
// entre eventos de touch en distintos elementos del DOM
let _touchDragData = null;

// ── COMPONENTE: Card de negocio ───────────────────────────────
function BizCard({ business, color, small }) {
  return (
    <div style={{
      background: color || "var(--color-background-primary)",
      border: `2px solid ${color ? "rgba(0,0,0,.18)" : "var(--color-border-secondary)"}`,
      borderRadius: 8,
      padding: small ? "3px 8px" : "6px 12px",
      fontSize: small ? 11 : 13,
      fontWeight: 600,
      color: color ? "#fff" : "var(--color-text-primary)",
      cursor: "grab",
      userSelect: "none",
      WebkitUserSelect: "none",
      boxShadow: "0 2px 6px rgba(0,0,0,.13)",
      whiteSpace: "nowrap",
      maxWidth: small ? 90 : 130,
      overflow: "hidden",
      textOverflow: "ellipsis",
      touchAction: "none",
    }}>
      {business.name}
    </div>
  );
}

// ── COMPONENTE: MatrixBoard ───────────────────────────────────
function MatrixBoard({ matrix, onDrop, renderCell, readOnly }) {
  const [dragOver, setDragOver] = useState(null);
  const rowLabels = ["Alto", "Medio", "Bajo"];
  const colLabels = ["Débil", "Media", "Fuerte"];
  const cellBg = (r, c) => {
    // VERDE: Alto/Fuerte, Alto/Media, Medio/Fuerte
    if ((r===0&&c===2)||(r===0&&c===1)||(r===1&&c===2)) return "#c8e6c9";
    // AMARILLO: Alto/Débil, Medio/Media, Bajo/Fuerte
    if ((r===0&&c===0)||(r===1&&c===1)||(r===2&&c===2)) return "#fff9c4";
    // ROJO: Medio/Débil, Bajo/Débil, Bajo/Media
    if ((r===1&&c===0)||(r===2&&c===0)||(r===2&&c===1)) return "#ffcdd2";
    return "#f7f7f7";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>

      {/* Título eje X */}
      <div style={{ display: "flex", marginLeft: 92 }}>
        <div style={{ flex: 1, textAlign: "center", fontSize: 11, fontWeight: 800, color: "#fff", background: "#1565c0", borderRadius: "8px 8px 0 0", padding: "5px 0", letterSpacing: 0.5 }}>
          ← Fortaleza competitiva →
        </div>
      </div>

      {/* Headers columnas */}
      <div style={{ display: "flex", marginLeft: 92 }}>
        {colLabels.map((l, i) => (
          <div key={l} style={{ flex: 1, textAlign: "center", fontSize: 11, color: "#1565c0", fontWeight: 700, padding: "5px 0", background: ["#e8f4f8","#d4eaf5","#bde0f0"][i] }}>{l}</div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "stretch" }}>

        {/* Título eje Y rotado */}
        <div style={{ width: 22, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <div style={{ transform: "rotate(-90deg)", whiteSpace: "nowrap", fontSize: 11, fontWeight: 800, color: "#fff", background: "#6a1b9a", padding: "4px 12px", borderRadius: 6, letterSpacing: 0.5 }}>
            ← Atractivo del mercado →
          </div>
        </div>

        {/* Labels filas */}
        <div style={{ display: "flex", flexDirection: "column", width: 68, gap: 2, marginLeft: 2 }}>
          {rowLabels.map(l => (
            <div key={l} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#6a1b9a", background: "#f3e5f5", borderRadius: 6, minHeight: 88 }}>{l}</div>
          ))}
        </div>

        {/* Celdas */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", flex: 1, gap: 2, marginLeft: 2 }}>
          {matrix.map((row, r) => row.map((cell, c) => {
            const key = `${r}-${c}`;
            return (
              <div
                key={key}
                onDragOver={e => { if (!readOnly) { e.preventDefault(); setDragOver(key); } }}
                onDragLeave={() => setDragOver(null)}
                onDrop={e => { setDragOver(null); if (!readOnly) onDrop(e, r, c); }}
                onTouchEnd={e => {
                  if (readOnly || !_touchDragData) return;
                  e.preventDefault();
                  onDrop(null, r, c);
                  setDragOver(null);
                }}
                style={{
                  background: dragOver === key ? "#b3d9ff" : cellBg(r, c),
                  borderRadius: 6, minHeight: 88, padding: 6,
                  display: "flex", flexWrap: "wrap", gap: 4, alignContent: "flex-start",
                  border: dragOver === key ? "2px dashed #2196f3" : "2px solid transparent",
                  transition: "background .15s",
                }}
              >
                {renderCell(r, c, cell)}
              </div>
            );
          }))}
        </div>
      </div>
    </div>
  );
}

// ── PANEL: Votación ───────────────────────────────────────────
function VotingPanel({ session, persist, role, colorMap, readOnly }) {
  const [dragging, setDragging] = useState(null);
  const ghostRef = useRef(null);
  const mat = session.votes[role] ? JSON.parse(JSON.stringify(session.votes[role])) : emptyMatrix();
  const placed = mat.flat(2).map(b => b.id);
  const unplaced = session.businesses.filter(b => !placed.includes(b.id));
  const color = colorMap[role];
  const canDrag = !readOnly && session.votingOpen;

  // ── Ghost element para touch drag ─────────────────────────
  useEffect(() => {
    const ghost = document.createElement("div");
    ghost.style.cssText = "position:fixed;pointerEvents:none;zIndex:9999;background:" + color + ";color:#fff;padding:4px 10px;borderRadius:8px;fontSize:13px;fontWeight:700;opacity:0.85;display:none;transform:translate(-50%,-50%)";
    document.body.appendChild(ghost);
    ghostRef.current = ghost;
    return () => document.body.removeChild(ghost);
  }, [color]);

  const showGhost = (text, x, y) => {
    const g = ghostRef.current;
    if (!g) return;
    g.textContent = text;
    g.style.display = "block";
    g.style.left = x + "px";
    g.style.top = y + "px";
  };

  const hideGhost = () => {
    if (ghostRef.current) ghostRef.current.style.display = "none";
  };

  // ── Touch handlers ─────────────────────────────────────────
  const onTouchStart = (biz, fromCell) => e => {
    if (!canDrag) return;
    e.stopPropagation();
    _touchDragData = { biz, fromCell };
    setDragging({ biz, fromCell });
    const t = e.touches[0];
    showGhost(biz.name, t.clientX, t.clientY);
  };

  const onTouchMove = e => {
    if (!_touchDragData) return;
    e.preventDefault();
    const t = e.touches[0];
    showGhost(_touchDragData.biz.name, t.clientX, t.clientY);
  };

  const onTouchEnd = (fromUnplaced) => e => {
    if (!_touchDragData) return;
    hideGhost();
    // Si suelta sobre zona "sin ubicar" y venía de una celda → quitar
    if (fromUnplaced && _touchDragData.fromCell) {
      const d = _touchDragData;
      _touchDragData = null;
      setDragging(null);
      const nm = JSON.parse(JSON.stringify(mat));
      const [fr, fc] = d.fromCell;
      nm[fr][fc] = nm[fr][fc].filter(b => b.id !== d.biz.id);
      persist({ ...session, votes: { ...session.votes, [role]: nm } });
      return;
    }
    _touchDragData = null;
    setDragging(null);
  };

  // ── Drop handlers (mouse + touch) ─────────────────────────
  const handleDrop = (e, r, c) => {
    if (e) e.preventDefault();
    const d = dragging || _touchDragData;
    if (!d || !canDrag) return;
    const nm = JSON.parse(JSON.stringify(mat));
    if (d.fromCell) { const [fr, fc] = d.fromCell; nm[fr][fc] = nm[fr][fc].filter(b => b.id !== d.biz.id); }
    nm[r][c].push(d.biz);
    persist({ ...session, votes: { ...session.votes, [role]: nm } });
    setDragging(null);
    _touchDragData = null;
    hideGhost();
  };

  const handleDropUnplaced = e => {
    if (e) e.preventDefault();
    const d = dragging || _touchDragData;
    if (!d || !d.fromCell || !canDrag) return;
    const nm = JSON.parse(JSON.stringify(mat));
    const [fr, fc] = d.fromCell;
    nm[fr][fc] = nm[fr][fc].filter(b => b.id !== d.biz.id);
    persist({ ...session, votes: { ...session.votes, [role]: nm } });
    setDragging(null);
    _touchDragData = null;
    hideGhost();
  };

  return (
    <div onTouchMove={onTouchMove}>
      <div style={{ marginBottom: 14, padding: "10px 16px", background: "#e8f5e9", borderRadius: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ width: 12, height: 12, borderRadius: "50%", background: color }} />
        <span style={{ fontWeight: 700, fontSize: 14 }}>{session.participants[role]?.name || session.participants[role]?.label}</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#666" }}>{placed.length}/{session.businesses.length} ubicados</span>
        {!session.votingOpen && <span style={{ fontSize: 12, background: "#ffcdd2", color: "#c62828", padding: "2px 10px", borderRadius: 20, fontWeight: 700 }}>🔒 Cerrada</span>}
      </div>

      <div
        onDragOver={e => e.preventDefault()}
        onDrop={handleDropUnplaced}
        onTouchEnd={onTouchEnd(true)}
        style={{ minHeight: 52, padding: 10, background: "#fafafa", borderRadius: 10, border: "2px dashed #ddd", marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "#aaa", fontWeight: 700, marginRight: 4 }}>SIN UBICAR:</span>
        {unplaced.length === 0
          ? <span style={{ fontSize: 12, color: "#4caf50", fontWeight: 700 }}>✓ Todos ubicados</span>
          : unplaced.map(b => (
            <div key={b.id}
              draggable={canDrag}
              onDragStart={e => { if (canDrag) { setDragging({ biz: b, fromCell: null }); e.dataTransfer.effectAllowed = "move"; } }}
              onDragEnd={() => setDragging(null)}
              onTouchStart={onTouchStart(b, null)}
              onTouchEnd={onTouchEnd(false)}
              style={{ touchAction: "none" }}
            >
              <BizCard business={b} color={color} />
            </div>
          ))
        }
      </div>

      <MatrixBoard matrix={mat} onDrop={handleDrop} readOnly={!canDrag}
        renderCell={(r, c, cell) => cell.map(b => (
          <div key={b.id}
            draggable={canDrag}
            onDragStart={e => { if (canDrag) { setDragging({ biz: b, fromCell: [r, c] }); e.dataTransfer.effectAllowed = "move"; } }}
            onDragEnd={() => setDragging(null)}
            onTouchStart={onTouchStart(b, [r, c])}
            onTouchEnd={onTouchEnd(false)}
            style={{ touchAction: "none" }}
          >
            <BizCard business={b} color={color} small />
          </div>
        ))}
      />
      {canDrag && <p style={{ textAlign: "center", fontSize: 12, color: "#888", marginTop: 10 }}>Arrastrá cada tarjeta a la celda correspondiente en la matriz</p>}
    </div>
  );
}

// ── PANEL: Reveal ─────────────────────────────────────────────
function RevealPanel({ session, colorMap }) {
  const pids = Object.keys(session.participants);
  const combined = emptyMatrix();
  pids.forEach(pid => {
    const mat = session.votes[pid] || emptyMatrix();
    mat.forEach((row, r) => row.forEach((cell, c) => cell.forEach(b => combined[r][c].push({ ...b, pid }))));
  });
  return (
    <div>
      <div style={{ marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
        {pids.map(pid => (
          <div key={pid} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", background: "var(--color-background-primary)", borderRadius: 20, boxShadow: "0 1px 4px rgba(0,0,0,.1)" }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: colorMap[pid] }} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>{session.participants[pid].name || session.participants[pid].label}</span>
          </div>
        ))}
      </div>
      <MatrixBoard matrix={combined} onDrop={() => {}} readOnly
        renderCell={(r, c, cell) => cell.map((b, i) => <div key={i}><BizCard business={b} color={colorMap[b.pid]} small /></div>)}
      />
    </div>
  );
}

// ── PANEL: Discussion ─────────────────────────────────────────
function DiscussionPanel({ session, persist, role, colorMap, isAdmin }) {
  const [dragging, setDragging] = useState(null);
  const [msg, setMsg] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const chatRef = useRef(null);
  const ghostRef = useRef(null);
  const consMat = session.consensusMatrix;
  const placed = consMat.flat(2).map(b => b.id);
  const unplaced = session.businesses.filter(b => !placed.includes(b.id));

  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [session.discussion]);

  useEffect(() => {
    if (!isAdmin) return;
    const ghost = document.createElement("div");
    ghost.style.cssText = "position:fixed;pointer-events:none;z-index:9999;background:#37474f;color:#fff;padding:4px 10px;border-radius:8px;font-size:13px;font-weight:700;opacity:0.85;display:none;transform:translate(-50%,-50%)";
    document.body.appendChild(ghost);
    ghostRef.current = ghost;
    return () => document.body.removeChild(ghost);
  }, [isAdmin]);

  const showGhost = (text, x, y) => { if (ghostRef.current) { ghostRef.current.textContent = text; ghostRef.current.style.display = "block"; ghostRef.current.style.left = x + "px"; ghostRef.current.style.top = y + "px"; } };
  const hideGhost = () => { if (ghostRef.current) ghostRef.current.style.display = "none"; };

  const onTouchStart = (biz, fromCell) => e => {
    if (!isAdmin) return;
    e.stopPropagation();
    _touchDragData = { biz, fromCell };
    setDragging({ biz, fromCell });
    const t = e.touches[0];
    showGhost(biz.name, t.clientX, t.clientY);
  };

  const onTouchMove = e => {
    if (!_touchDragData) return;
    e.preventDefault();
    const t = e.touches[0];
    showGhost(_touchDragData.biz.name, t.clientX, t.clientY);
  };

  const onTouchEnd = e => {
    hideGhost();
    _touchDragData = null;
    setDragging(null);
  };

  const handleDrop = (e, r, c) => {
    if (e) e.preventDefault();
    const d = dragging || _touchDragData;
    if (!d || !isAdmin) return;
    const nm = consMat.map(row => row.map(cell => [...cell]));
    if (d.fromCell) { const [fr, fc] = d.fromCell; nm[fr][fc] = nm[fr][fc].filter(b => b.id !== d.biz.id); }
    nm[r][c].push(d.biz);
    persist({ ...session, consensusMatrix: nm });
    setDragging(null);
    _touchDragData = null;
    hideGhost();
  };

  const handleDropUnplaced = e => {
    if (e) e.preventDefault();
    const d = dragging || _touchDragData;
    if (!d || !d.fromCell || !isAdmin) return;
    const nm = consMat.map(row => row.map(cell => [...cell]));
    const [fr, fc] = d.fromCell;
    nm[fr][fc] = nm[fr][fc].filter(b => b.id !== d.biz.id);
    persist({ ...session, consensusMatrix: nm });
    setDragging(null);
    _touchDragData = null;
    hideGhost();
  };

  const sendMsg = () => {
    if (!msg.trim()) return;
    const name = isAdmin ? "Admin" : (session.participants[role]?.name || session.participants[role]?.label);
    const color = isAdmin ? "#6a1b9a" : colorMap[role];
    persist({ ...session, discussion: [...session.discussion, { id: uid(), name, color, text: msg.trim(), time: new Date().toLocaleTimeString("es-AR") }] });
    setMsg("");
  };

  const askAI = async () => {
    setAiLoading(true);
    try {
      const rows = ["Alto","Medio","Bajo"], cols = ["Débil","Media","Fuerte"];
      const matrixSummary = consMat.map((row, r) =>
        row.map((cell, c) => cell.length ? `${rows[r]}/${cols[c]}: ${cell.map(b=>b.name).join(", ")}` : null)
          .filter(Boolean)
      ).flat().join("; ");
      const pids = Object.keys(session.participants);
      const votesSummary = pids.map(pid => {
        const mat = session.votes[pid] || emptyMatrix();
        const items = mat.map((row, r) => row.map((cell, c) => cell.length ? `${cell.map(b=>b.name).join(",")}→${rows[r]}/${cols[c]}` : null).filter(Boolean)).flat();
        return `${session.participants[pid].label}: ${items.join("; ")}`;
      }).join(" | ");

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: "Sos un experto en estrategia empresarial. Analizá la Matriz McKinsey (GE-McKinsey) con los datos provistos y dá insights concisos en español.",
          messages: [{
            role: "user",
            content: `Analizá esta sesión de Matriz McKinsey:\n\nNegocios: ${session.businesses.map(b=>b.name).join(", ")}\n\nPosiciones votadas: ${votesSummary}\n\nConsensuo actual: ${matrixSummary || "Sin consenso aún"}\n\nDá insights estratégicos breves (3-4 puntos) sobre los negocios y sus posiciones.`,
          }],
        }),
      });
      const data = await res.json();
      const text = data.content?.find(c => c.type === "text")?.text || "No se pudo generar análisis.";
      persist({ ...session, discussion: [...session.discussion, { id: uid(), name: "🤖 IA McKinsey", color: "#00796b", text, time: new Date().toLocaleTimeString("es-AR") }] });
    } catch (e) {
      persist({ ...session, discussion: [...session.discussion, { id: uid(), name: "🤖 IA", color: "#f44336", text: "Error al consultar IA: " + e.message, time: new Date().toLocaleTimeString("es-AR") }] });
    }
    setAiLoading(false);
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 20 }}>
      <div>
        <div style={{ marginBottom: 10, padding: "8px 14px", background: isAdmin ? "#fff3e0" : "#e8f5e9", borderRadius: 8, fontSize: 13, fontWeight: 700, color: isAdmin ? "#e65100" : "#2e7d32" }}>
          {isAdmin ? "💬 Definí la posición consensuada (solo admin puede mover)" : "💬 Seguí la discusión en el chat"}
        </div>
        <div
          onDragOver={e => e.preventDefault()}
          onDrop={handleDropUnplaced}
          onTouchEnd={e => { if (_touchDragData && _touchDragData.fromCell) handleDropUnplaced(e); else onTouchEnd(e); }}
          style={{ minHeight: 48, padding: 8, background: "#fafafa", border: "2px dashed #ddd", borderRadius: 10, marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#aaa", fontWeight: 700 }}>SIN UBICAR:</span>
          {unplaced.length === 0
            ? <span style={{ fontSize: 12, color: "#4caf50", fontWeight: 700 }}>✓ Todos ubicados</span>
            : unplaced.map(b => (
              <div key={b.id}
                draggable={isAdmin}
                onDragStart={e => { if (isAdmin) { setDragging({ biz: b, fromCell: null }); e.dataTransfer.effectAllowed = "move"; } }}
                onDragEnd={() => setDragging(null)}
                onTouchStart={onTouchStart(b, null)}
                onTouchEnd={onTouchEnd}
                style={{ touchAction: "none" }}
              >
                <BizCard business={b} color="#546e7a" />
              </div>
            ))
          }
        </div>
        <div onTouchMove={onTouchMove}>
        <MatrixBoard matrix={consMat} onDrop={isAdmin ? handleDrop : () => {}} readOnly={!isAdmin}
          renderCell={(r, c, cell) => cell.map((b, i) => (
            <div key={i}
              draggable={isAdmin}
              onDragStart={e => { if (isAdmin) { setDragging({ biz: b, fromCell: [r, c] }); e.dataTransfer.effectAllowed = "move"; } }}
              onDragEnd={() => setDragging(null)}
              onTouchStart={onTouchStart(b, [r, c])}
              onTouchEnd={onTouchEnd}
              style={{ touchAction: "none" }}
            >
              <BizCard business={b} color="#37474f" small />
            </div>
          ))}
        />
        </div>
      </div>

      {/* Chat */}
      <div style={{ background: "var(--color-background-primary)", borderRadius: 12, boxShadow: "0 2px 8px rgba(0,0,0,.1)", display: "flex", flexDirection: "column", height: 520 }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid #eee", fontWeight: 700, color: "#333", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>💬 Discusión</span>
          <button onClick={askAI} disabled={aiLoading} style={{ padding: "4px 10px", background: "#00796b", color: "#fff", border: "none", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: aiLoading ? "wait" : "pointer" }}>
            {aiLoading ? "⏳ Analizando..." : "🤖 Pedir análisis IA"}
          </button>
        </div>
        <div ref={chatRef} style={{ flex: 1, overflowY: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {session.discussion.length === 0 && <p style={{ color: "#bbb", fontSize: 12, textAlign: "center", marginTop: 20 }}>Empezá la discusión...</p>}
          {session.discussion.map(d => (
            <div key={d.id} style={{ padding: "6px 10px", background: "#f5f5f5", borderRadius: 8, borderLeft: `3px solid ${d.color}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: d.color }}>{d.name} <span style={{ color: "#aaa", fontWeight: 400 }}>{d.time}</span></div>
              <div style={{ fontSize: 13, color: "#333", marginTop: 2, whiteSpace: "pre-wrap" }}>{d.text}</div>
            </div>
          ))}
        </div>
        <div style={{ padding: 10, borderTop: "1px solid #eee", display: "flex", gap: 6 }}>
          <input value={msg} onChange={e => setMsg(e.target.value)} onKeyDown={e => e.key === "Enter" && sendMsg()}
            placeholder="Escribí un comentario..."
            style={{ flex: 1, padding: "7px 10px", borderRadius: 8, border: "1px solid #ddd", fontSize: 13 }}
          />
          <button onClick={sendMsg} style={{ padding: "7px 12px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer" }}>→</button>
        </div>
      </div>
    </div>
  );
}

// ── HELPERS DE DESVÍO ─────────────────────────────────────────
// Distancia euclidiana entre dos posiciones (r,c) en la matriz 3x3
function distancia(p1, p2) {
  if (!p1 || !p2) return null;
  return Math.sqrt(Math.pow(p1.r - p2.r, 2) + Math.pow(p1.c - p2.c, 2));
}
// Desvío máximo posible en una grilla 3x3 = diagonal = sqrt(8) ≈ 2.83
const MAX_DIST = Math.sqrt(8);

// Convierte distancia a porcentaje de desvío (0% = idéntico, 100% = máximo desvío)
function pctDesvio(dist) {
  if (dist === null) return null;
  return Math.round((dist / MAX_DIST) * 100);
}

// Color semáforo según % de desvío
function colorDesvio(pct) {
  if (pct === null) return "#aaa";
  if (pct <= 20) return "#2e7d32";   // verde — muy alineado
  if (pct <= 45) return "#f57c00";   // naranja — desvío moderado
  return "#c62828";                   // rojo — desvío alto
}

function labelDesvio(pct) {
  if (pct === null) return "Sin datos";
  if (pct <= 20) return "Muy alineado";
  if (pct <= 45) return "Desvío moderado";
  return "Desvío alto";
}

// Barra visual de desvío
function BarraDesvio({ pct, color }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ background: "#eee", borderRadius: 20, height: 8, overflow: "hidden" }}>
        <div style={{ width: `${pct ?? 0}%`, background: color, height: "100%", borderRadius: 20, transition: "width .4s" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#aaa", marginTop: 2 }}>
        <span>0%</span><span>50%</span><span>100%</span>
      </div>
    </div>
  );
}

// ── GENERADOR DE PDF ─────────────────────────────────────────
function generarPDF(session, colorMap, desvioIndividual, desvioGrupo, desvioConsensoDetalle, desvioConsensoPct, avgMatrix, avgExacto) {
  const pids = Object.keys(session.participants);
  const rowL = ["Alto","Medio","Bajo"], colL = ["Débil","Media","Fuerte"];

  const cellColor = (r,c) => {
    // VERDE: Alto/Fuerte, Alto/Media, Medio/Fuerte
    if((r===0&&c===2)||(r===0&&c===1)||(r===1&&c===2)) return "#c8e6c9";
    // AMARILLO: Alto/Débil, Medio/Media, Bajo/Fuerte
    if((r===0&&c===0)||(r===1&&c===1)||(r===2&&c===2)) return "#fff9c4";
    // ROJO: Medio/Débil, Bajo/Débil, Bajo/Media
    if((r===1&&c===0)||(r===2&&c===0)||(r===2&&c===1)) return "#ffcdd2";
    return "#f0f0f0";
  };

  const matrizHTML = (mat, titulo, color) => {
    const filas = mat.map((row,r) => {
      const celdas = row.map((cell,c) => {
        const nombres = cell.map(b=>b.name).join(", ") || "";
        return `<td style="background:${cellColor(r,c)};border:1px solid #ccc;padding:6px 4px;font-size:10px;vertical-align:top;min-width:60px">${nombres}</td>`;
      }).join("");
      return `<tr><td style="background:#f0ece8;border:1px solid #ccc;padding:4px 6px;font-size:10px;font-weight:700;white-space:nowrap">${rowL[r]}</td>${celdas}</tr>`;
    }).join("");
    return `
      <div style="margin-bottom:16px">
        <div style="font-weight:700;font-size:13px;color:${color};margin-bottom:6px;text-align:center">${titulo}</div>
        <table style="border-collapse:collapse;width:100%">
          <thead><tr>
            <th style="background:#f0ece8;border:1px solid #ccc;padding:4px;font-size:10px;width:50px"></th>
            ${colL.map(l=>`<th style="background:#d4eaf5;border:1px solid #ccc;padding:4px;font-size:10px">${l}</th>`).join("")}
          </tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>`;
  };

  const barraHTML = (pct, color) => {
    const w = pct ?? 0;
    return `<div style="background:#eee;border-radius:4px;height:6px;margin:4px 0"><div style="width:${w}%;background:${color};height:6px;border-radius:4px"></div></div>`;
  };

  const colorD = pct => pct===null?"#aaa":pct<=20?"#2e7d32":pct<=45?"#f57c00":"#c62828";
  const labelD = pct => pct===null?"Sin datos":pct<=20?"Muy alineado":pct<=45?"Desvío moderado":"Desvío alto";

  // Votos individuales
  const seccionesIndividuales = pids.map(pid => {
    const p = session.participants[pid];
    const mat = session.votes[pid] || emptyMatrix();
    const color = colorMap[pid];
    const pct = desvioIndividual[pid];
    const cd = colorD(pct);

    const negocioRows = session.businesses.map(b => {
      let pos = null;
      mat.forEach((row,r)=>row.forEach((cell,c)=>{ if(cell.find(x=>x.id===b.id)) pos={r,c}; }));
      return `<tr>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:11px">${b.name}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:11px;text-align:center">${pos?`${rowL[pos.r]} / ${colL[pos.c]}`:"—"}</td>
      </tr>`;
    }).join("");

    return `
      <div style="page-break-inside:avoid;margin-bottom:24px;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden">
        <div style="background:${color};color:#fff;padding:10px 16px;font-weight:700;font-size:13px">
          ${p.name||p.label}
          ${pct!==null?`<span style="float:right;font-size:12px">${labelD(pct)} — ${pct}% desvío</span>`:""}
        </div>
        <div style="padding:14px;display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
          <div style="flex:1;min-width:200px">
            ${matrizHTML(mat,"Posición votada",color)}
          </div>
          <div style="min-width:180px">
            <div style="font-size:11px;font-weight:700;color:#555;margin-bottom:8px">NEGOCIOS UBICADOS</div>
            <table style="width:100%;border-collapse:collapse">
              <thead><tr>
                <th style="text-align:left;padding:4px 8px;font-size:11px;color:#888;border-bottom:1px solid #eee">Negocio</th>
                <th style="text-align:center;padding:4px 8px;font-size:11px;color:#888;border-bottom:1px solid #eee">Posición</th>
              </tr></thead>
              <tbody>${negocioRows}</tbody>
            </table>
            ${pct!==null?`
            <div style="margin-top:12px;padding:10px;background:#f9f9f9;border-radius:6px">
              <div style="font-size:11px;font-weight:700;color:#555;margin-bottom:4px">DESVÍO vs PROMEDIO</div>
              <div style="font-size:20px;font-weight:900;color:${cd}">${pct}%</div>
              <div style="font-size:11px;color:${cd};font-weight:700">${labelD(pct)}</div>
              ${barraHTML(pct,cd)}
            </div>`:""}
          </div>
        </div>
      </div>`;
  }).join("");

  // Sección consolidación
  const consRows = session.businesses.map(b => {
    const det = desvioConsensoDetalle[b.id];
    const avg = avgExacto[b.id];
    const avgRound = avg?{r:Math.round(avg.r),c:Math.round(avg.c)}:null;
    const cd = det?colorD(det.pct):"#aaa";
    return `<tr>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:11px;font-weight:600">${b.name}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:11px;color:#2e7d32">${det?`${rowL[det.cons.r]} / ${colL[det.cons.c]}`:"Sin ubicar"}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:11px;color:#1565c0">${avgRound?`${rowL[avgRound.r]} / ${colL[avgRound.c]}`:"—"}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:11px;color:${cd};font-weight:700">${det?`${det.pct}%`:"—"}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:11px;color:${cd}">${det?labelD(det.pct):"—"}</td>
    </tr>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Matriz McKinsey — Informe</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 24px; color: #333; font-size: 12px; }
    @media print {
      body { padding: 0; }
      .no-print { display: none !important; }
      @page { margin: 15mm; size: A4; }
    }
    h1 { color: #1a237e; font-size: 20px; margin: 0 0 4px; }
    h2 { color: #1a237e; font-size: 15px; margin: 20px 0 10px; border-bottom: 2px solid #1a237e; padding-bottom: 4px; }
    .header { background: linear-gradient(90deg,#1a237e,#283593); color: #fff; padding: 20px 24px; margin: -24px -24px 24px; }
    .header h1 { color: #fff; font-size: 22px; }
    .header p { color: rgba(255,255,255,.8); margin: 4px 0 0; font-size: 13px; }
    .indicador-global { display: inline-block; padding: 10px 20px; border-radius: 8px; margin: 0 8px 8px 0; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Matriz McKinsey — Informe de Resultados</h1>
    <p>Generado el ${new Date().toLocaleDateString("es-AR")} a las ${new Date().toLocaleTimeString("es-AR")}</p>
    <p>${pids.length} participantes · ${session.businesses.length} negocios</p>
  </div>

  <button class="no-print" onclick="window.print()" style="background:#1a237e;color:#fff;border:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;margin-bottom:20px">
    🖨️ Imprimir / Guardar PDF
  </button>

  <!-- INDICADORES GLOBALES -->
  <h2>Indicadores Globales</h2>
  <div>
    ${desvioGrupo!==null?`<div class="indicador-global" style="background:${colorD(desvioGrupo)}18;border:1px solid ${colorD(desvioGrupo)}40">
      <div style="font-size:28px;font-weight:900;color:${colorD(desvioGrupo)}">${desvioGrupo}%</div>
      <div style="font-size:11px;font-weight:700;color:#555">Desvío promedio del grupo</div>
      <div style="font-size:11px;color:${colorD(desvioGrupo)}">${labelD(desvioGrupo)}</div>
    </div>`:""}
    ${desvioConsensoPct!==null?`<div class="indicador-global" style="background:${colorD(desvioConsensoPct)}18;border:1px solid ${colorD(desvioConsensoPct)}40">
      <div style="font-size:28px;font-weight:900;color:${colorD(desvioConsensoPct)}">${desvioConsensoPct}%</div>
      <div style="font-size:11px;font-weight:700;color:#555">Desvío consenso vs promedio</div>
      <div style="font-size:11px;color:${colorD(desvioConsensoPct)}">${labelD(desvioConsensoPct)}</div>
    </div>`:""}
  </div>

  <!-- VOTOS INDIVIDUALES -->
  <h2>Votos por Participante</h2>
  ${seccionesIndividuales}

  <!-- CONSOLIDACIÓN -->
  <h2>Consolidación Final</h2>
  <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:20px">
    <div style="flex:1;min-width:220px">${matrizHTML(session.consensusMatrix,"✅ Matriz Consensuada","#2e7d32")}</div>
    <div style="flex:1;min-width:220px">${matrizHTML(avgMatrix,"📊 Matriz Promedio","#1565c0")}</div>
  </div>

  <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
    <thead>
      <tr style="background:#1a237e;color:#fff">
        <th style="padding:8px;text-align:left;font-size:12px">Negocio</th>
        <th style="padding:8px;text-align:center;font-size:12px">Consenso</th>
        <th style="padding:8px;text-align:center;font-size:12px">Promedio votos</th>
        <th style="padding:8px;text-align:center;font-size:12px">Desvío</th>
        <th style="padding:8px;text-align:center;font-size:12px">Diagnóstico</th>
      </tr>
    </thead>
    <tbody>${consRows}</tbody>
  </table>

  <!-- DISCUSIÓN -->
  ${session.discussion.length>0?`
  <h2>Registro de Discusión</h2>
  <div style="border:1px solid #e0e0e0;border-radius:8px;overflow:hidden">
    ${session.discussion.map(d=>`
    <div style="padding:8px 12px;border-bottom:1px solid #eee;border-left:3px solid ${d.color}">
      <span style="font-weight:700;font-size:11px;color:${d.color}">${d.name}</span>
      <span style="font-size:10px;color:#aaa;margin-left:8px">${d.time}</span>
      <div style="font-size:12px;margin-top:2px">${d.text}</div>
    </div>`).join("")}
  </div>`:""}
</body>
</html>`;

  const w = window.open("","_blank");
  w.document.write(html);
  w.document.close();
}

// ── PANEL: Results ────────────────────────────────────────────
function ResultsPanel({ session, colorMap }) {
  const pids = Object.keys(session.participants);
  const rowL = ["Alto","Medio","Bajo"], colL = ["Débil","Media","Fuerte"];

  // Calcular posición promedio por negocio
  const avgPos = {};
  session.businesses.forEach(b => { avgPos[b.id] = { r: 0, c: 0, count: 0 }; });
  pids.forEach(pid => {
    const mat = session.votes[pid] || emptyMatrix();
    mat.forEach((row, r) => row.forEach((cell, c) => cell.forEach(b => {
      avgPos[b.id].r += r; avgPos[b.id].c += c; avgPos[b.id].count++;
    })));
  });

  // Posición promedio exacta (sin redondear, para cálculo de desvíos)
  const avgExacto = {};
  session.businesses.forEach(b => {
    const a = avgPos[b.id];
    avgExacto[b.id] = a.count > 0 ? { r: a.r / a.count, c: a.c / a.count } : null;
  });

  // Matriz promedio redondeada (para mostrar)
  const avgMatrix = emptyMatrix();
  session.businesses.forEach(b => {
    const a = avgPos[b.id];
    if (a.count > 0) { const r = Math.round(a.r / a.count), c = Math.round(a.c / a.count); avgMatrix[r][c].push(b); }
  });

  // ── INDICADOR 1: Desvío individual vs promedio ────────────────
  // Para cada participante: promedio de distancias de sus votos al promedio grupal
  const desvioIndividual = {};
  pids.forEach(pid => {
    const mat = session.votes[pid] || emptyMatrix();
    let totalDist = 0, count = 0;
    session.businesses.forEach(b => {
      const avg = avgExacto[b.id];
      if (!avg) return;
      // Posición votada por este participante
      let voted = null;
      mat.forEach((row, r) => row.forEach((cell, c) => { if (cell.find(x => x.id === b.id)) voted = { r, c }; }));
      if (voted) { totalDist += distancia(voted, avg); count++; }
    });
    desvioIndividual[pid] = count > 0 ? pctDesvio(totalDist / count) : null;
  });

  // Desvío global del grupo (promedio de todos los individuales)
  const desviosValidos = Object.values(desvioIndividual).filter(v => v !== null);
  const desvioGrupo = desviosValidos.length > 0 ? Math.round(desviosValidos.reduce((a,b) => a+b, 0) / desviosValidos.length) : null;

  // ── INDICADOR 2: Desvío consenso vs promedio ──────────────────
  let totalDistConsensus = 0, countConsensus = 0;
  const desvioConsensoDetalle = {};
  session.businesses.forEach(b => {
    const avg = avgExacto[b.id];
    if (!avg) return;
    let cons = null;
    session.consensusMatrix.forEach((row, r) => row.forEach((cell, c) => { if (cell.find(x => x.id === b.id)) cons = { r, c }; }));
    if (cons) {
      const d = distancia(cons, avg);
      totalDistConsensus += d;
      countConsensus++;
      desvioConsensoDetalle[b.id] = { pct: pctDesvio(d), cons, avg };
    } else {
      desvioConsensoDetalle[b.id] = null;
    }
  });
  const desvioConsensoPct = countConsensus > 0 ? pctDesvio(totalDistConsensus / countConsensus) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

      {/* ── MATRICES ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <div>
          <h3 style={{ textAlign: "center", color: "#1b5e20", margin: "0 0 12px", fontSize: 15 }}>✅ Matriz Consensuada</h3>
          <MatrixBoard matrix={session.consensusMatrix} onDrop={() => {}} readOnly
            renderCell={(r, c, cell) => cell.map((b, i) => <div key={i}><BizCard business={b} color="#2e7d32" small /></div>)}
          />
        </div>
        <div>
          <h3 style={{ textAlign: "center", color: "#1565c0", margin: "0 0 12px", fontSize: 15 }}>📊 Matriz Promedio de votos</h3>
          <MatrixBoard matrix={avgMatrix} onDrop={() => {}} readOnly
            renderCell={(r, c, cell) => cell.map((b, i) => <div key={i}><BizCard business={b} color="#1565c0" small /></div>)}
          />
        </div>
      </div>

      {/* ── INDICADOR 1: Desvío individual vs promedio ── */}
      <div style={{ background: "#fff", borderRadius: 14, padding: 22, boxShadow: "0 2px 8px rgba(0,0,0,.07)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
          <span style={{ fontSize: 20 }}>📐</span>
          <div>
            <h3 style={{ margin: 0, fontSize: 15, color: "#333" }}>Desvío individual vs matriz promedio</h3>
            <p style={{ margin: 0, fontSize: 12, color: "#888" }}>Qué tan lejos votó cada participante respecto al promedio del grupo (0% = idéntico, 100% = máximo desvío)</p>
          </div>
          {desvioGrupo !== null && (
            <div style={{ marginLeft: "auto", textAlign: "center", background: colorDesvio(desvioGrupo) + "18", borderRadius: 12, padding: "8px 16px", border: `1px solid ${colorDesvio(desvioGrupo)}40` }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: colorDesvio(desvioGrupo) }}>{desvioGrupo}%</div>
              <div style={{ fontSize: 11, color: "#666", fontWeight: 700 }}>Desvío promedio del grupo</div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {pids.map(pid => {
            const p = session.participants[pid];
            const pct = desvioIndividual[pid];
            const color = colorDesvio(pct);
            return (
              <div key={pid} style={{ background: "#fafafa", borderRadius: 10, padding: "12px 16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: colorMap[pid], flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{p.name || p.label}</span>
                  {pct !== null ? (
                    <>
                      <span style={{ fontSize: 20, fontWeight: 900, color }}>{pct}%</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color, background: color + "18", padding: "2px 10px", borderRadius: 20 }}>{labelDesvio(pct)}</span>
                    </>
                  ) : (
                    <span style={{ fontSize: 12, color: "#aaa" }}>Sin votos</span>
                  )}
                </div>
                <BarraDesvio pct={pct} color={color} />
              </div>
            );
          })}
        </div>
      </div>

      {/* ── INDICADOR 2: Desvío consenso vs promedio ── */}
      <div style={{ background: "#fff", borderRadius: 14, padding: 22, boxShadow: "0 2px 8px rgba(0,0,0,.07)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
          <span style={{ fontSize: 20 }}>🎯</span>
          <div>
            <h3 style={{ margin: 0, fontSize: 15, color: "#333" }}>Desvío del acuerdo final vs matriz promedio</h3>
            <p style={{ margin: 0, fontSize: 12, color: "#888" }}>Qué tan lejos quedó el consenso respecto al promedio matemático de los votos</p>
          </div>
          {desvioConsensoPct !== null && (
            <div style={{ marginLeft: "auto", textAlign: "center", background: colorDesvio(desvioConsensoPct) + "18", borderRadius: 12, padding: "8px 16px", border: `1px solid ${colorDesvio(desvioConsensoPct)}40` }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: colorDesvio(desvioConsensoPct) }}>{desvioConsensoPct}%</div>
              <div style={{ fontSize: 11, color: "#666", fontWeight: 700 }}>Desvío global del consenso</div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {session.businesses.map(b => {
            const det = desvioConsensoDetalle[b.id];
            const avg = avgExacto[b.id];
            const avgRound = avg ? { r: Math.round(avg.r), c: Math.round(avg.c) } : null;
            if (!det) return (
              <div key={b.id} style={{ background: "#f5f5f5", borderRadius: 10, padding: "12px 14px", minWidth: 180 }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{b.name}</div>
                <div style={{ fontSize: 12, color: "#aaa" }}>Sin datos de consenso</div>
              </div>
            );
            const color = colorDesvio(det.pct);
            return (
              <div key={b.id} style={{ background: "#fafafa", borderRadius: 10, padding: "12px 14px", minWidth: 180, flex: "1 1 180px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{b.name}</span>
                  <span style={{ fontSize: 18, fontWeight: 900, color }}>{det.pct}%</span>
                </div>
                <div style={{ fontSize: 11, color: "#666", marginBottom: 4 }}>
                  <span style={{ color: "#2e7d32" }}>✅ Consenso: {rowL[det.cons.r]} / {colL[det.cons.c]}</span><br />
                  <span style={{ color: "#1565c0" }}>📊 Promedio: {avgRound ? `${rowL[avgRound.r]} / ${colL[avgRound.c]}` : "—"}</span>
                </div>
                <BarraDesvio pct={det.pct} color={color} />
                <div style={{ fontSize: 11, fontWeight: 700, color, marginTop: 4 }}>{labelDesvio(det.pct)}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── COMPARACIÓN POR NEGOCIO ── */}
      <div style={{ background: "#fff", borderRadius: 14, padding: 22, boxShadow: "0 2px 8px rgba(0,0,0,.07)" }}>
        <h3 style={{ margin: "0 0 14px", color: "#333", fontSize: 15 }}>🔍 Comparación por negocio</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {session.businesses.map(b => {
            const cp = session.consensusMatrix.flatMap((row, r) => row.flatMap((cell, c) => cell.find(x => x.id === b.id) ? [{ r, c }] : []))[0];
            const ap = avgMatrix.flatMap((row, r) => row.flatMap((cell, c) => cell.find(x => x.id === b.id) ? [{ r, c }] : []))[0];
            const same = cp && ap && cp.r === ap.r && cp.c === ap.c;
            return (
              <div key={b.id} style={{ padding: "10px 14px", borderRadius: 10, background: same ? "#e8f5e9" : "#fff8e1", border: `1px solid ${same ? "#a5d6a7" : "#ffe082"}`, minWidth: 160 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{b.name}</div>
                <div style={{ fontSize: 12, color: "#555" }}>
                  <span style={{ color: "#2e7d32" }}>✅ {cp ? `${rowL[cp.r]} / ${colL[cp.c]}` : "Sin ubicar"}</span><br />
                  <span style={{ color: "#1565c0" }}>📊 {ap ? `${rowL[ap.r]} / ${colL[ap.c]}` : "Sin votos"}</span>
                </div>
                <div style={{ fontSize: 11, marginTop: 4, fontWeight: 700, color: same ? "#4caf50" : "#f57c00" }}>
                  {same ? "✓ Coinciden" : "⚠ Difieren"}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── BOTÓN EXPORTAR PDF ── */}
      <div style={{ textAlign: "center", padding: "8px 0 16px" }}>
        <button
          onClick={() => generarPDF(session, colorMap, desvioIndividual, desvioGrupo, desvioConsensoDetalle, desvioConsensoPct, avgMatrix, avgExacto)}
          style={{ padding: "14px 36px", background: "#1a237e", color: "#fff", border: "none", borderRadius: 12, fontWeight: 700, fontSize: 16, cursor: "pointer", boxShadow: "0 4px 12px rgba(26,35,126,.3)" }}>
          📄 Exportar informe PDF
        </button>
        <p style={{ fontSize: 12, color: "#aaa", marginTop: 8 }}>
          Se abre una nueva pestaña — usá Ctrl+P o el botón para guardar como PDF
        </p>
      </div>

    </div>
  );
}

// ── PANTALLA: Login / Selección empresa ───────────────────────
function LoginScreen({ onLogin }) {
  const [mode, setMode] = useState("select");
  const [companyName, setCompanyName] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [participantName, setParticipantName] = useState("");
  const [adminPass, setAdminPass] = useState("");
  const [err, setErr] = useState("");
  const [companies, setCompanies] = useState([]);

  useEffect(() => {
    const saved = localStore.get("mckinsey_companies") || [];
    setCompanies(saved);
    fetch(`${SUPABASE_URL}/rest/v1/mckinsey_companies?select=id,name,created_at&order=created_at.desc&limit=50`, {
      headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}` }
    })
      .then(r => r.json())
      .then(rows => {
        if (Array.isArray(rows) && rows.length > 0) {
          setCompanies(rows);
          localStore.set("mckinsey_companies", rows);
        }
      }).catch(() => {});
  }, []);

  const createCompany = async () => {
    const name = companyName.trim();
    if (!name) { setErr("Ingresá un nombre para la empresa"); return; }
    if (adminPass !== ADMIN_PASSWORD) { setErr("Contraseña de admin incorrecta"); return; }
    const id = uid() + uid();
    const company = { id, name, created_at: new Date().toISOString() };
    try { await db.upsert("mckinsey_companies", company); } catch {}
    const updated = [company, ...companies];
    setCompanies(updated);
    localStore.set("mckinsey_companies", updated);
    onLogin({ companyId: id, companyName: name, role: "admin" });
  };

  const joinAsAdmin = (cid, cname) => {
    if (adminPass !== ADMIN_PASSWORD) { setErr("Contraseña de admin incorrecta"); return; }
    onLogin({ companyId: cid, companyName: cname, role: "admin" });
  };

  const joinAsParticipant = (cid, cname) => {
    const name = participantName.trim();
    if (!name) { setErr("Ingresá tu nombre"); return; }
    onLogin({ companyId: cid, companyName: cname, role: "participant", name });
  };

  const selectedCompany = companies.find(c => c.id === companyId);

  return (
    <div style={{ minHeight:"100vh", background:"linear-gradient(135deg,#0d1b4b 0%,#1a3a8f 50%,#0d3b6e 100%)", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Georgia','Times New Roman',serif" }}>
      <div style={{ width:"100%", maxWidth:480, padding:"0 16px" }}>
        <div style={{ textAlign:"center", marginBottom:32 }}>
          <div style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", width:64, height:64, borderRadius:16, background:"rgba(255,255,255,.15)", marginBottom:16, fontSize:32, border:"1px solid rgba(255,255,255,.25)" }}>⬡</div>
          <h1 style={{ color:"#fff", fontSize:28, fontWeight:400, margin:"0 0 6px", letterSpacing:-0.5 }}>Matriz McKinsey</h1>
          <p style={{ color:"rgba(255,255,255,.6)", fontSize:14, margin:0 }}>Plataforma colaborativa de estrategia empresarial</p>
        </div>
        <div style={{ background:"rgba(255,255,255,.97)", borderRadius:18, padding:32, boxShadow:"0 20px 60px rgba(0,0,0,.35)" }}>

          {mode === "select" && (
            <>
              <h2 style={{ margin:"0 0 20px", fontSize:18, fontWeight:600, color:"#1a237e" }}>Seleccioná tu empresa</h2>
              {companies.length === 0
                ? <p style={{ color:"#888", fontSize:14, textAlign:"center", padding:"16px 0" }}>No hay empresas registradas aún.</p>
                : <div style={{ maxHeight:200, overflowY:"auto", marginBottom:16 }}>
                    {companies.map(c => (
                      <div key={c.id} onClick={() => { setCompanyId(c.id); setMode("join"); setErr(""); }}
                        style={{ padding:"10px 14px", borderRadius:10, background:"#f5f7ff", border:"1px solid #dde4ff", marginBottom:8, cursor:"pointer", display:"flex", alignItems:"center", gap:10 }}
                        onMouseEnter={e=>e.currentTarget.style.background="#e8edff"}
                        onMouseLeave={e=>e.currentTarget.style.background="#f5f7ff"}>
                        <span style={{ fontSize:18 }}>🏢</span>
                        <span style={{ fontWeight:600, fontSize:14, color:"#1a237e", flex:1 }}>{c.name}</span>
                        <span style={{ fontSize:11, color:"#888" }}>{new Date(c.created_at).toLocaleDateString("es-AR")}</span>
                      </div>
                    ))}
                  </div>
              }
              <button onClick={() => { setMode("create"); setErr(""); }}
                style={{ width:"100%", padding:"11px", background:"#1a237e", color:"#fff", border:"none", borderRadius:10, fontWeight:700, fontSize:14, cursor:"pointer" }}>
                + Nueva empresa
              </button>
              {err && <p style={{ color:"#e53935", fontSize:12, marginTop:10, textAlign:"center" }}>{err}</p>}
            </>
          )}

          {mode === "create" && (
            <>
              <button onClick={() => setMode("select")} style={{ background:"none", border:"none", color:"#1a237e", cursor:"pointer", fontSize:13, padding:0, marginBottom:16 }}>← Volver</button>
              <h2 style={{ margin:"0 0 20px", fontSize:18, fontWeight:600, color:"#1a237e" }}>Crear nueva empresa</h2>
              <div style={{ marginBottom:14 }}>
                <label style={{ fontSize:12, fontWeight:700, color:"#444", display:"block", marginBottom:4 }}>NOMBRE DE LA EMPRESA</label>
                <input value={companyName} onChange={e=>setCompanyName(e.target.value)}
                  placeholder="Ej: Grupo Alfa SA"
                  style={{ width:"100%", padding:"9px 12px", borderRadius:8, border:"1px solid #ddd", fontSize:14, boxSizing:"border-box" }}/>
              </div>
              <div style={{ marginBottom:18 }}>
                <label style={{ fontSize:12, fontWeight:700, color:"#444", display:"block", marginBottom:4 }}>CONTRASEÑA DE ADMINISTRADOR</label>
                <input type="password" value={adminPass} onChange={e=>setAdminPass(e.target.value)}
                  placeholder="Contraseña admin"
                  style={{ width:"100%", padding:"9px 12px", borderRadius:8, border:"1px solid #ddd", fontSize:14, boxSizing:"border-box" }}/>
              </div>
              <button onClick={createCompany}
                style={{ width:"100%", padding:"11px", background:"#2e7d32", color:"#fff", border:"none", borderRadius:10, fontWeight:700, fontSize:14, cursor:"pointer" }}>
                Crear empresa y continuar como Admin
              </button>
              {err && <p style={{ color:"#e53935", fontSize:12, marginTop:10, textAlign:"center" }}>{err}</p>}
            </>
          )}

          {mode === "join" && (
            <>
              <button onClick={() => { setMode("select"); setErr(""); }} style={{ background:"none", border:"none", color:"#1a237e", cursor:"pointer", fontSize:13, padding:0, marginBottom:16 }}>← Volver</button>
              <h2 style={{ margin:"0 0 6px", fontSize:18, fontWeight:600, color:"#1a237e" }}>{selectedCompany?.name || "Empresa"}</h2>
              <p style={{ margin:"0 0 20px", fontSize:13, color:"#666" }}>Elegí cómo querés ingresar</p>
              <div style={{ background:"#f5f7ff", borderRadius:12, padding:16, marginBottom:14 }}>
                <div style={{ fontWeight:700, fontSize:12, color:"#1a237e", marginBottom:10 }}>👤 INGRESAR COMO PARTICIPANTE</div>
                <input value={participantName} onChange={e=>setParticipantName(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&joinAsParticipant(companyId, selectedCompany?.name)}
                  placeholder="Tu nombre completo"
                  style={{ width:"100%", padding:"8px 10px", borderRadius:8, border:"1px solid #dde", fontSize:13, marginBottom:8, boxSizing:"border-box" }}/>
                <button onClick={()=>joinAsParticipant(companyId, selectedCompany?.name)}
                  style={{ width:"100%", padding:"9px", background:"#1976d2", color:"#fff", border:"none", borderRadius:8, fontWeight:700, fontSize:13, cursor:"pointer" }}>
                  Ingresar
                </button>
              </div>
              <div style={{ background:"#fdf0ff", borderRadius:12, padding:16 }}>
                <div style={{ fontWeight:700, fontSize:12, color:"#6a1b9a", marginBottom:10 }}>🔐 INGRESAR COMO ADMINISTRADOR</div>
                <input type="password" value={adminPass} onChange={e=>setAdminPass(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&joinAsAdmin(companyId, selectedCompany?.name)}
                  placeholder="Contraseña admin"
                  style={{ width:"100%", padding:"8px 10px", borderRadius:8, border:"1px solid #e8d0f5", fontSize:13, marginBottom:8, boxSizing:"border-box" }}/>
                <button onClick={()=>joinAsAdmin(companyId, selectedCompany?.name)}
                  style={{ width:"100%", padding:"9px", background:"#6a1b9a", color:"#fff", border:"none", borderRadius:8, fontWeight:700, fontSize:13, cursor:"pointer" }}>
                  Ingresar como Admin
                </button>
              </div>
              {err && <p style={{ color:"#e53935", fontSize:12, marginTop:10, textAlign:"center" }}>{err}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── PANEL: Setup ─────────────────────────────────────────────
function SetupPanel({ session, persist, colorMap }) {
  const [bizInput, setBizInput] = useState("");
  const [partInput, setPartInput] = useState("");
  const pids = Object.keys(session.participants);

  const addBiz = () => {
    const v = bizInput.trim(); if (!v) return;
    persist({ ...session, businesses: [...session.businesses, { id: uid(), name: v }] });
    setBizInput("");
  };
  const addPart = () => {
    const v = partInput.trim(); if (!v) return;
    const pid = uid();
    persist({ ...session, participants: { ...session.participants, [pid]: { label: v, name: "" } } });
    setPartInput("");
  };
  const startVoting = () => {
    const iv = {};
    Object.keys(session.participants).forEach(pid => { iv[pid] = emptyMatrix(); });
    persist({ ...session, phase: PHASES.VOTING, votingOpen: true, votes: iv });
  };

  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:20 }}>
      <div style={{ background:"var(--color-background-primary)", borderRadius:12, padding:20, boxShadow:"0 2px 8px rgba(0,0,0,.07)" }}>
        <h3 style={{ margin:"0 0 14px", color:"#1a237e", fontSize:16 }}>📦 Negocios / Unidades</h3>
        <div style={{ display:"flex", gap:8, marginBottom:12 }}>
          <input value={bizInput} onChange={e=>setBizInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addBiz()}
            placeholder="Nombre del negocio..."
            style={{ flex:1, padding:"8px 10px", borderRadius:8, border:"1px solid #ddd", fontSize:13 }}/>
          <button onClick={addBiz} style={{ padding:"8px 14px", background:"#1976d2", color:"#fff", border:"none", borderRadius:8, fontWeight:700, cursor:"pointer" }}>+</button>
        </div>
        <div style={{ maxHeight:280, overflowY:"auto" }}>
          {session.businesses.map(b => (
            <div key={b.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 10px", background:"#f5f5f5", borderRadius:8, marginBottom:6 }}>
              <span style={{ flex:1, fontSize:13, fontWeight:600 }}>{b.name}</span>
              <button onClick={()=>persist({ ...session, businesses:session.businesses.filter(x=>x.id!==b.id) })}
                style={{ background:"none", border:"none", color:"#e53935", cursor:"pointer", fontWeight:700, fontSize:16 }}>×</button>
            </div>
          ))}
          {session.businesses.length===0 && <p style={{ color:"#aaa", textAlign:"center", fontSize:13 }}>Sin negocios</p>}
        </div>
      </div>
      <div style={{ background:"var(--color-background-primary)", borderRadius:12, padding:20, boxShadow:"0 2px 8px rgba(0,0,0,.07)" }}>
        <h3 style={{ margin:"0 0 14px", color:"#1a237e", fontSize:16 }}>👥 Participantes</h3>
        <div style={{ display:"flex", gap:8, marginBottom:12 }}>
          <input value={partInput} onChange={e=>setPartInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addPart()}
            placeholder="Nombre del participante..."
            style={{ flex:1, padding:"8px 10px", borderRadius:8, border:"1px solid #ddd", fontSize:13 }}/>
          <button onClick={addPart} style={{ padding:"8px 14px", background:"#1976d2", color:"#fff", border:"none", borderRadius:8, fontWeight:700, cursor:"pointer" }}>+</button>
        </div>
        <div style={{ maxHeight:280, overflowY:"auto" }}>
          {pids.map(pid => {
            const p = session.participants[pid];
            return (
              <div key={pid} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 10px", background:"#f5f5f5", borderRadius:8, marginBottom:6 }}>
                <div style={{ width:10, height:10, borderRadius:"50%", background:colorMap[pid], flexShrink:0 }}/>
                <span style={{ flex:1, fontSize:13, fontWeight:600 }}>{p.label}</span>
                <button onClick={()=>{ const ps={...session.participants}; delete ps[pid]; persist({...session,participants:ps}); }}
                  style={{ background:"none", border:"none", color:"#e53935", cursor:"pointer", fontWeight:700, fontSize:16 }}>×</button>
              </div>
            );
          })}
          {pids.length===0 && <p style={{ color:"#aaa", textAlign:"center", fontSize:13 }}>Sin participantes</p>}
        </div>
      </div>
      <div style={{ gridColumn:"1/-1", textAlign:"center" }}>
        <button onClick={startVoting} disabled={session.businesses.length===0||pids.length===0}
          style={{ padding:"13px 36px", fontSize:16, fontWeight:700, background:session.businesses.length>0&&pids.length>0?"#2e7d32":"#ccc", color:"#fff", border:"none", borderRadius:12, cursor:session.businesses.length>0&&pids.length>0?"pointer":"not-allowed" }}>
          ▶ Iniciar Votación
        </button>
      </div>
    </div>
  );
}

// ── POPOVER: Códigos ──────────────────────────────────────────
function CodesPopover({ participants, colorMap }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ padding: "5px 12px", background: "rgba(255,255,255,.2)", color: "#fff", border: "1px solid rgba(255,255,255,.4)", borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
        🔑 Códigos
      </button>
      {open && (
        <div style={{ position: "absolute", top: 38, right: 0, background: "#fff", borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,.2)", padding: 16, minWidth: 250, zIndex: 999 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: "#333", marginBottom: 10 }}>Códigos de participantes</div>
          {Object.keys(participants).map(pid => {
            const p = participants[pid];
            return (
              <div key={pid} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8, background: "#f5f5f5", marginBottom: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: colorMap[pid], flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{p.name || p.label}</span>
                <span style={{ fontSize: 14, background: "#e3f2fd", color: "#1565c0", padding: "3px 10px", borderRadius: 20, fontWeight: 900, letterSpacing: 2 }}>{p.code}</span>
              </div>
            );
          })}
          <button onClick={() => setOpen(false)}
            style={{ marginTop: 6, width: "100%", padding: "6px", background: "#f0f0f0", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, color: "#555" }}>
            Cerrar
          </button>
        </div>
      )}
    </div>
  );
}

// ── APP PRINCIPAL ─────────────────────────────────────────────
export default function App() {
  const [loginInfo, setLoginInfo] = useState(null); // { companyId, companyName, role, name?, code? }
  const [resolvedRole, setResolvedRole] = useState(null); // "admin" | pid
  const [loginErr, setLoginErr] = useState("");

  const companyId = loginInfo?.companyId || "default";
  const sessionId = `session_${companyId}`;
  const { session, persist, loading } = useSession(companyId, sessionId);

  // Resolver participante por nombre una vez que la sesión carga
  useEffect(() => {
    if (!loginInfo || !session) return;
    if (loginInfo.role === "admin") {
      setResolvedRole("admin");
      return;
    }
    if (loginInfo.role === "participant") {
      const pids = Object.keys(session.participants);
      // Buscar por nombre exacto (case-insensitive)
      const pid = pids.find(k =>
        (session.participants[k].name || session.participants[k].label)
          .toLowerCase() === loginInfo.name.toLowerCase()
      );
      if (!pid) { setLoginErr(`No se encontró "${loginInfo.name}" en la lista de participantes. Pedile al admin que te agregue.`); setLoginInfo(null); return; }
      // Guardar nombre si aún no estaba confirmado
      if (!session.participants[pid].name) {
        persist({ ...session, participants: { ...session.participants, [pid]: { ...session.participants[pid], name: loginInfo.name } } });
      }
      setResolvedRole(pid);
    }
  }, [loginInfo, session]);

  if (!loginInfo || (loginInfo.role === "participant" && !resolvedRole)) {
    return <LoginScreen onLogin={(info) => { setLoginErr(""); setLoginInfo(info); setResolvedRole(null); }} />;
  }

  if (loading || !session) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f0f2f5", fontFamily: "'Segoe UI',sans-serif" }}>
        <div style={{ textAlign: "center", color: "#666" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
          <p>Cargando sesión...</p>
        </div>
      </div>
    );
  }

  const isAdmin = resolvedRole === "admin";
  const pids = Object.keys(session.participants);
  const colorMap = {};
  pids.forEach((pid, i) => { colorMap[pid] = COLORS[i % COLORS.length]; });
  const phaseIdx = PHASE_ORDER.indexOf(session.phase);

  const renderContent = () => {
    if (isAdmin) {
      if (session.phase === PHASES.SETUP) return <SetupPanel session={session} persist={persist} colorMap={colorMap} />;
      if (session.phase === PHASES.VOTING) return (
        <div>
          <div style={{ marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 10 }}>
            {pids.map(pid => {
              const mat = session.votes[pid] || emptyMatrix();
              const placed = mat.flat(2).length;
              return (
                <div key={pid} style={{ padding: "6px 14px", background: "var(--color-background-primary)", borderRadius: 10, boxShadow: "0 1px 4px rgba(0,0,0,.1)", display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: colorMap[pid] }} />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{session.participants[pid].name || session.participants[pid].label}</span>
                  <span style={{ fontSize: 12, color: "#888" }}>{placed}/{session.businesses.length}</span>
                </div>
              );
            })}
          </div>
          <p style={{ textAlign: "center", color: "#666", padding: 20, fontSize: 14 }}>
            {session.votingOpen ? "Los participantes están votando." : "La votación está cerrada."}
          </p>
        </div>
      );
      if (session.phase === PHASES.REVEAL) return <RevealPanel session={session} colorMap={colorMap} />;
      if (session.phase === PHASES.DISCUSSION) return <DiscussionPanel session={session} persist={persist} role={resolvedRole} colorMap={colorMap} isAdmin />;
      if (session.phase === PHASES.RESULTS) return <ResultsPanel session={session} colorMap={colorMap} />;
    } else {
      if (session.phase === PHASES.SETUP) return <div style={{ textAlign: "center", padding: 48, color: "#888" }}>⏳ Esperando que el administrador configure la sesión...</div>;
      if (session.phase === PHASES.VOTING) return <VotingPanel session={session} persist={persist} role={resolvedRole} colorMap={colorMap} readOnly={false} />;
      if (session.phase === PHASES.REVEAL) return (
        <div>
          <div style={{ marginBottom: 14, padding: "10px 16px", background: "#fff3e0", borderRadius: 10, fontSize: 13, color: "#e65100", fontWeight: 700 }}>
            ⏳ El administrador está revisando todos los tableros...
          </div>
          <VotingPanel session={session} persist={persist} role={resolvedRole} colorMap={colorMap} readOnly />
        </div>
      );
      if (session.phase === PHASES.DISCUSSION) return <DiscussionPanel session={session} persist={persist} role={resolvedRole} colorMap={colorMap} isAdmin={false} />;
      if (session.phase === PHASES.RESULTS) return <ResultsPanel session={session} colorMap={colorMap} />;
    }
  };

  return (
    <div style={{ fontFamily: "'Segoe UI', sans-serif", minHeight: "100vh", background: "#f0f2f5" }}>
      {/* Header */}
      <div style={{ background: "linear-gradient(90deg,#1a237e,#283593)", padding: "12px 24px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ color: "#fff", fontWeight: 900, fontSize: 18 }}>⬡ Matriz McKinsey</span>
        <span style={{ color: "rgba(255,255,255,.5)", fontSize: 13 }}>·</span>
        <span style={{ color: "rgba(255,255,255,.8)", fontSize: 13, fontWeight: 600 }}>{loginInfo.companyName}</span>

        {/* Phase stepper */}
        <div style={{ display: "flex", gap: 0, marginLeft: 8 }}>
          {PHASE_ORDER.map((p, i) => (
            <div key={p} style={{ display: "flex", alignItems: "center" }}>
              <div style={{
                padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700,
                background: i === phaseIdx ? "#fff" : i < phaseIdx ? "rgba(255,255,255,.3)" : "rgba(255,255,255,.1)",
                color: i === phaseIdx ? "#1a237e" : "#fff",
              }}>
                {PHASE_LABELS[p]}
              </div>
              {i < PHASE_ORDER.length - 1 && <div style={{ width: 10, height: 2, background: "rgba(255,255,255,.3)" }} />}
            </div>
          ))}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
          {isAdmin && <span style={{ color: "rgba(255,255,255,.5)", fontSize: 11, background: "rgba(255,255,255,.1)", padding: "3px 10px", borderRadius: 20 }}>👑 Admin</span>}
          <span style={{ color: "rgba(255,255,255,.7)", fontSize: 12 }}>
            {isAdmin ? "👑 Admin" : (session.participants[resolvedRole]?.name || session.participants[resolvedRole]?.label || "")}
          </span>
          <button onClick={() => { setLoginInfo(null); setResolvedRole(null); }}
            style={{ padding: "4px 12px", background: "rgba(255,255,255,.15)", color: "#fff", border: "1px solid rgba(255,255,255,.3)", borderRadius: 8, cursor: "pointer", fontSize: 12 }}>
            Salir
          </button>
        </div>
      </div>

      {/* Admin controls */}
      {isAdmin && session.phase !== PHASES.SETUP && (
        <div style={{ background: "var(--color-background-primary)", margin: "16px 24px 0", borderRadius: 12, padding: "12px 16px", boxShadow: "0 2px 8px rgba(0,0,0,.07)", display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {PHASE_ORDER.map((p, i) => (
              <button key={p} onClick={() => persist({ ...session, phase: p })}
                style={{
                  padding: "6px 14px", borderRadius: 20, border: "none", fontWeight: 700, fontSize: 12, cursor: "pointer",
                  background: session.phase === p ? "#1a237e" : i < phaseIdx ? "#e3f2fd" : "#f5f5f5",
                  color: session.phase === p ? "#fff" : i < phaseIdx ? "#1565c0" : "#888",
                }}>
                {PHASE_LABELS[p]}
              </button>
            ))}
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(session.phase === PHASES.VOTING || session.phase === PHASES.REVEAL) && (
              <button onClick={() => persist({ ...session, votingOpen: !session.votingOpen })}
                style={{ padding: "6px 14px", borderRadius: 8, border: "none", fontWeight: 700, fontSize: 12, cursor: "pointer", background: session.votingOpen ? "#ffcdd2" : "#c8e6c9", color: session.votingOpen ? "#c62828" : "#2e7d32" }}>
                {session.votingOpen ? "🔒 Cerrar votación" : "🔓 Abrir votación"}
              </button>
            )}
            <button
              onClick={() => { if (window.confirm("¿Reiniciar toda la sesión? Se perderán todos los datos.")) persist(defaultSession()); }}
              style={{ padding: "6px 14px", borderRadius: 8, border: "none", fontWeight: 700, fontSize: 12, cursor: "pointer", background: "#ffebee", color: "#c62828" }}>
              🗑 Reiniciar
            </button>
          </div>
        </div>
      )}

      {loginErr && (
        <div style={{ margin: "12px 24px 0", padding: "10px 16px", background: "#ffebee", borderRadius: 10, color: "#c62828", fontSize: 14, fontWeight: 600 }}>
          ⚠ {loginErr}
        </div>
      )}

      <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
        {renderContent()}
      </div>
    </div>
  );
}
