
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
    if (r === 0 && c === 2) return "#c8e6c9";
    if ((r === 0 && c === 1) || (r === 1 && c === 2)) return "#fff9c4";
    if (r === 2 && c === 0) return "#ffcdd2";
    if (r === 1 && c === 1) return "#ffe0b2";
    return "#f7f7f7";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", marginLeft: 68 }}>
        {colLabels.map((l, i) => (
          <div key={l} style={{
            flex: 1, textAlign: "center", fontSize: 11, color: "#555",
            fontWeight: 700, padding: "5px 0",
            background: ["#e8f4f8","#d4eaf5","#bde0f0"][i],
            borderRadius: i === 0 ? "6px 0 0 0" : i === 2 ? "0 6px 0 0" : 0,
          }}>{l}</div>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "stretch" }}>
        <div style={{ display: "flex", flexDirection: "column", width: 68, gap: 2 }}>
          {rowLabels.map(l => (
            <div key={l} style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, fontWeight: 700, color: "#666",
              background: "#f0ece8", borderRadius: 6, minHeight: 88,
            }}>{l}</div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", flex: 1, gap: 2 }}>
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
      <div style={{ marginLeft: 68, fontSize: 10, color: "#aaa", textAlign: "center", padding: "2px 0" }}>
        ← Fortaleza competitiva →
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
  const [selected, setSelected] = useState(null);
  const [msg, setMsg] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const chatRef = useRef(null);
  const consMat = session.consensusMatrix;
  const placed = consMat.flat(2).map(b => b.id);
  const unplaced = session.businesses.filter(b => !placed.includes(b.id));

  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [session.discussion]);

  const placeInCell = (r, c) => {
    if (!selected || !isAdmin) return;
    const nm = consMat.map(row => row.map(cell => [...cell]));
    if (selected.fromCell) { const [fr, fc] = selected.fromCell; nm[fr][fc] = nm[fr][fc].filter(b => b.id !== selected.biz.id); }
    nm[r][c].push(selected.biz);
    persist({ ...session, consensusMatrix: nm });
    setSelected(null);
  };

  const handleDrop = (e, r, c) => { placeInCell(r, c); };

  const handleDropUnplaced = e => {
    if (!selected || !selected.fromCell || !isAdmin) return;
    const nm = consMat.map(row => row.map(cell => [...cell]));
    const [fr, fc] = selected.fromCell;
    nm[fr][fc] = nm[fr][fc].filter(b => b.id !== selected.biz.id);
    persist({ ...session, consensusMatrix: nm });
    setSelected(null);
  };

  const selectBiz = (biz, fromCell = null) => {
    if (!isAdmin) return;
    if (selected && selected.biz.id === biz.id) { setSelected(null); return; }
    setSelected({ biz, fromCell });
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
        {isAdmin && selected && (
          <div style={{ marginBottom: 8, padding: "6px 12px", background: "#e3f2fd", borderRadius: 8, fontSize: 13, fontWeight: 700, color: "#1565c0", textAlign: "center" }}>
            "{selected.biz.name}" seleccionado — tocá el cuadrante destino
          </div>
        )}
        <div
          onClick={() => { if (selected && selected.fromCell) handleDropUnplaced(); }}
          style={{ minHeight: 48, padding: 8, background: selected && selected.fromCell ? "#e3f2fd" : "#fafafa", border: `2px dashed ${selected && selected.fromCell ? "#1976d2" : "#ddd"}`, borderRadius: 10, marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", cursor: selected && selected.fromCell ? "pointer" : "default" }}>
          <span style={{ fontSize: 11, color: "#aaa", fontWeight: 700 }}>SIN UBICAR:</span>
          {unplaced.length === 0
            ? <span style={{ fontSize: 12, color: "#4caf50", fontWeight: 700 }}>✓ Todos ubicados</span>
            : unplaced.map(b => (
              <div key={b.id}
                draggable={isAdmin}
                onDragStart={e => { if (isAdmin) { selectBiz(b, null); e.dataTransfer.effectAllowed = "move"; } }}
                onClick={e => { e.stopPropagation(); selectBiz(b, null); }}
              >
                <BizCard business={b} color="#546e7a" selected={selected?.biz.id === b.id} />
              </div>
            ))
          }
        </div>
        <MatrixBoard matrix={consMat} onDrop={isAdmin ? handleDrop : () => {}} readOnly={!isAdmin} selected={isAdmin ? selected : null}
          renderCell={(r, c, cell) => cell.map((b, i) => (
            <div key={i}
              draggable={isAdmin}
              onDragStart={e => { if (isAdmin) { selectBiz(b, [r, c]); e.dataTransfer.effectAllowed = "move"; } }}
              onClick={e => {
                e.stopPropagation();
                if (!isAdmin) return;
                if (selected && selected.biz.id !== b.id) { placeInCell(r, c); }
                else { selectBiz(b, [r, c]); }
              }}
            >
              <BizCard business={b} color="#37474f" small selected={selected?.biz.id === b.id} />
            </div>
          ))}
        />
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

      {/* ── COMPARACIÓN POR NEGOCIO (existente) ── */}
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
