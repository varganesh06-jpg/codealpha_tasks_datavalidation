import { useState, useEffect, useRef } from "react";

// ============================================================
// CORE ENGINE — Validation, Hashing, Classification
// ============================================================

// Deterministic hash from object (FNV-1a variant)
function hashRecord(obj) {
  const str = JSON.stringify(obj, Object.keys(obj).sort());
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Levenshtein distance for fuzzy matching
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a.toLowerCase(), b.toLowerCase()) / maxLen;
}

// Field-level similarity score between two records
function recordSimilarity(newRec, existing) {
  const keys = Object.keys(newRec).filter(k => k !== "id" && k !== "timestamp");
  let total = 0;
  keys.forEach(k => {
    const a = String(newRec[k] ?? "");
    const b = String(existing[k] ?? "");
    total += similarity(a, b);
  });
  return keys.length ? total / keys.length : 0;
}

// Classify a new record against the database
function classifyRecord(newRec, db) {
  const hash = hashRecord(newRec);

  // 1. Exact duplicate (same hash)
  const exactMatch = db.find(r => r._hash === hash);
  if (exactMatch) {
    return { status: "DUPLICATE", confidence: 1.0, matchedId: exactMatch.id, reason: "Exact hash match — identical record already exists", hash };
  }

  // 2. Check key-field exact match (email/id fields)
  const keyField = ["email", "id", "phone", "username", "sku", "code"].find(k => newRec[k]);
  if (keyField) {
    const keyMatch = db.find(r => String(r[keyField]).toLowerCase() === String(newRec[keyField]).toLowerCase());
    if (keyMatch) {
      return { status: "DUPLICATE", confidence: 0.98, matchedId: keyMatch.id, reason: `Key field "${keyField}" already exists in database`, hash };
    }
  }

  // 3. Fuzzy / near-duplicate check
  let bestSim = 0, bestMatch = null;
  db.forEach(r => {
    const s = recordSimilarity(newRec, r);
    if (s > bestSim) { bestSim = s; bestMatch = r; }
  });

  if (bestSim >= 0.92) {
    return { status: "FALSE_POSITIVE", confidence: bestSim, matchedId: bestMatch.id, reason: `High similarity (${(bestSim*100).toFixed(1)}%) to existing record — likely near-duplicate`, hash };
  }
  if (bestSim >= 0.75) {
    return { status: "SUSPECT", confidence: bestSim, matchedId: bestMatch?.id, reason: `Moderate similarity (${(bestSim*100).toFixed(1)}%) — flagged for review`, hash };
  }

  // 4. Schema / data-quality checks
  const issues = validateFields(newRec);
  if (issues.length > 0) {
    return { status: "INVALID", confidence: 0, matchedId: null, reason: `Validation failed: ${issues.join("; ")}`, hash };
  }

  return { status: "UNIQUE", confidence: 1 - bestSim, matchedId: null, reason: "Record passed all checks — unique and valid", hash };
}

function validateFields(rec) {
  const issues = [];
  if (rec.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.email)) issues.push("Invalid email format");
  if (rec.phone && !/^\+?[\d\s\-()]{7,}$/.test(rec.phone)) issues.push("Invalid phone format");
  if (rec.age && (isNaN(rec.age) || rec.age < 0 || rec.age > 130)) issues.push("Age out of range");
  if (rec.name && rec.name.trim().length < 2) issues.push("Name too short");
  const emptyRequired = ["name","email"].filter(k => k in rec && !String(rec[k]).trim());
  if (emptyRequired.length) issues.push(`Empty required fields: ${emptyRequired.join(", ")}`);
  return issues;
}

// ============================================================
// SAMPLE DATA
// ============================================================
const INITIAL_DB = [
  { id: "R001", name: "Alice Johnson", email: "alice@example.com", phone: "+1-555-0101", age: 29, dept: "Engineering", _hash: "" },
  { id: "R002", name: "Bob Martinez",  email: "bob@example.com",   phone: "+1-555-0102", age: 34, dept: "Marketing",   _hash: "" },
  { id: "R003", name: "Carol White",   email: "carol@example.com", phone: "+1-555-0103", age: 27, dept: "Finance",     _hash: "" },
  { id: "R004", name: "David Kim",     email: "david@example.com", phone: "+1-555-0104", age: 42, dept: "Engineering", _hash: "" },
  { id: "R005", name: "Eva Chen",      email: "eva@example.com",   phone: "+1-555-0105", age: 31, dept: "HR",          _hash: "" },
];
INITIAL_DB.forEach(r => { const { _hash, ...rest } = r; r._hash = hashRecord(rest); });

const PRESET_TESTS = [
  { label: "✅ Unique record",        data: { name: "Frank Nguyen",  email: "frank@example.com",  phone: "+1-555-0106", age: 38, dept: "Legal" } },
  { label: "🔴 Exact duplicate",      data: { name: "Alice Johnson", email: "alice@example.com",  phone: "+1-555-0101", age: 29, dept: "Engineering" } },
  { label: "🟠 Key-field duplicate",  data: { name: "Alice J.",      email: "alice@example.com",  phone: "+1-555-9999", age: 30, dept: "Design" } },
  { label: "🟡 Near-duplicate",       data: { name: "Bob Martínez",  email: "bob2@example.com",   phone: "+1-555-0102", age: 34, dept: "Marketing" } },
  { label: "🔵 Suspect similarity",   data: { name: "Carol Whi te",  email: "cwhite@example.com", phone: "+1-555-0999", age: 27, dept: "Finance" } },
  { label: "⚠️  Invalid email",       data: { name: "Grace Lee",     email: "not-an-email",       phone: "+1-555-0200", age: 25, dept: "Design" } },
];

// ============================================================
// STATUS CONFIG
// ============================================================
const STATUS_META = {
  UNIQUE:        { color: "#00e5a0", bg: "#00e5a011", icon: "✓", label: "UNIQUE",        action: "APPENDED TO DB" },
  DUPLICATE:     { color: "#ff4466", bg: "#ff446611", icon: "✕", label: "DUPLICATE",     action: "REJECTED" },
  FALSE_POSITIVE:{ color: "#ff9f1c", bg: "#ff9f1c11", icon: "◈", label: "FALSE POSITIVE", action: "BLOCKED" },
  SUSPECT:       { color: "#a78bfa", bg: "#a78bfa11", icon: "?", label: "SUSPECT",        action: "FLAGGED" },
  INVALID:       { color: "#64748b", bg: "#64748b11", icon: "!", label: "INVALID",        action: "REJECTED" },
};

// ============================================================
// COMPONENT
// ============================================================
export default function DataDedupSystem() {
  const [db, setDb] = useState(INITIAL_DB);
  const [log, setLog] = useState([]);
  const [form, setForm] = useState({ name: "", email: "", phone: "", age: "", dept: "" });
  const [processing, setProcessing] = useState(false);
  const [activeTab, setActiveTab] = useState("submit");
  const [highlight, setHighlight] = useState(null);
  const [stats, setStats] = useState({ total: 0, unique: 0, duplicates: 0, falsePos: 0, suspects: 0, invalid: 0 });
  const logRef = useRef(null);

  useEffect(() => {
    const s = { total: log.length, unique: 0, duplicates: 0, falsePos: 0, suspects: 0, invalid: 0 };
    log.forEach(l => {
      if (l.result.status === "UNIQUE")         s.unique++;
      if (l.result.status === "DUPLICATE")      s.duplicates++;
      if (l.result.status === "FALSE_POSITIVE") s.falsePos++;
      if (l.result.status === "SUSPECT")        s.suspects++;
      if (l.result.status === "INVALID")        s.invalid++;
    });
    setStats(s);
  }, [log]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [log]);

  const submitRecord = async (rawData) => {
    setProcessing(true);
    await new Promise(r => setTimeout(r, 600)); // simulate async

    const result = classifyRecord(rawData, db);
    const entry = {
      id: `LOG-${Date.now()}`,
      ts: new Date().toISOString(),
      input: rawData,
      result,
    };

    if (result.status === "UNIQUE") {
      const newRec = { ...rawData, id: `R${String(db.length + 1).padStart(3,"0")}`, _hash: result.hash };
      setDb(prev => [...prev, newRec]);
      setHighlight(newRec.id);
      setTimeout(() => setHighlight(null), 3000);
    }

    setLog(prev => [entry, ...prev]);
    setProcessing(false);
    if (result.status === "UNIQUE") setActiveTab("database");
    return result;
  };

  const handleSubmit = () => {
    const data = { ...form };
    if (data.age) data.age = Number(data.age);
    submitRecord(data);
    setForm({ name: "", email: "", phone: "", age: "", dept: "" });
  };

  const loadPreset = (preset) => {
    setForm({
      name:  preset.data.name  || "",
      email: preset.data.email || "",
      phone: preset.data.phone || "",
      age:   preset.data.age   ? String(preset.data.age) : "",
      dept:  preset.data.dept  || "",
    });
    setActiveTab("submit");
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#080c14",
      color: "#e2e8f0",
      fontFamily: "'IBM Plex Mono', 'Fira Code', monospace",
      padding: "24px",
      boxSizing: "border-box",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Space+Grotesk:wght@400;600;700&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0f1624; }
        ::-webkit-scrollbar-thumb { background: #1e3a5f; border-radius: 2px; }
        input, select { outline: none; }
        input::placeholder { color: #334155; }
        @keyframes pulse-border { 0%,100% { box-shadow: 0 0 0 0 rgba(0,229,160,0.4); } 50% { box-shadow: 0 0 0 6px rgba(0,229,160,0); } }
        @keyframes slideIn { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }
        @keyframes scan { 0% { top: 0; } 100% { top: 100%; } }
        .btn-primary { background: #00e5a0; color: #080c14; border: none; cursor: pointer; padding: 10px 20px; font-family: inherit; font-size: 13px; font-weight: 600; border-radius: 6px; letter-spacing: 0.08em; transition: all 0.2s; }
        .btn-primary:hover { background: #00ffb3; transform: translateY(-1px); }
        .btn-primary:disabled { background: #1e3a5f; color: #334155; cursor: not-allowed; transform: none; }
        .tab { background: transparent; border: none; cursor: pointer; padding: 8px 16px; font-family: inherit; font-size: 12px; letter-spacing: 0.1em; color: #475569; border-bottom: 2px solid transparent; transition: all 0.2s; }
        .tab.active { color: #00e5a0; border-bottom-color: #00e5a0; }
        .tab:hover:not(.active) { color: #94a3b8; }
        .field { display: flex; flex-direction: column; gap: 6px; }
        .field label { font-size: 10px; letter-spacing: 0.15em; color: #475569; text-transform: uppercase; }
        .field input { background: #0f1624; border: 1px solid #1e2d45; color: #e2e8f0; padding: 9px 12px; font-family: inherit; font-size: 13px; border-radius: 6px; transition: border-color 0.2s; }
        .field input:focus { border-color: #00e5a0; }
        .preset-btn { background: #0f1624; border: 1px solid #1e2d45; color: #94a3b8; cursor: pointer; padding: 8px 12px; font-family: inherit; font-size: 11px; border-radius: 6px; text-align: left; transition: all 0.2s; line-height: 1.4; }
        .preset-btn:hover { border-color: #334155; color: #e2e8f0; background: #131d2e; }
        .log-entry { animation: slideIn 0.3s ease; border-left: 3px solid; padding: 12px 14px; border-radius: 0 8px 8px 0; margin-bottom: 8px; }
        .db-row { padding: 10px 14px; border-radius: 6px; font-size: 12px; transition: background 0.3s; display: grid; grid-template-columns: 60px 1fr 1fr 80px 80px 80px 100px; gap: 8px; align-items: center; }
        .db-row:hover { background: #0f1624; }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 10px; font-weight: 600; letter-spacing: 0.1em; }
      `}</style>

      {/* Header */}
      <div style={{ marginBottom: 28, display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#00e5a0", boxShadow: "0 0 8px #00e5a0", animation: "pulse-border 2s infinite" }} />
            <span style={{ fontSize: 10, letterSpacing: "0.2em", color: "#00e5a0", textTransform: "uppercase" }}>System Active</span>
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, letterSpacing: "-0.01em", color: "#f1f5f9" }}>
            Data Integrity & Deduplication Engine
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "#475569" }}>
            Real-time validation · Hash-based exact matching · Fuzzy similarity detection
          </p>
        </div>
        {/* Stats strip */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "DB Records", val: db.length, col: "#00e5a0" },
            { label: "Processed",  val: stats.total, col: "#64748b" },
            { label: "Unique",     val: stats.unique, col: "#00e5a0" },
            { label: "Blocked",    val: stats.duplicates + stats.falsePos, col: "#ff4466" },
            { label: "Flagged",    val: stats.suspects, col: "#a78bfa" },
          ].map(s => (
            <div key={s.label} style={{ textAlign: "center", background: "#0f1624", border: "1px solid #1e2d45", borderRadius: 8, padding: "10px 16px" }}>
              <div style={{ fontSize: 20, fontWeight: 600, color: s.col, lineHeight: 1 }}>{s.val}</div>
              <div style={{ fontSize: 10, color: "#475569", marginTop: 4, letterSpacing: "0.1em" }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Main grid */}
      <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 20 }}>

        {/* LEFT — Input Panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          {/* Workflow diagram */}
          <div style={{ background: "#0b1220", border: "1px solid #1e2d45", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 10, letterSpacing: "0.15em", color: "#475569", marginBottom: 14, textTransform: "uppercase" }}>Pipeline Flow</div>
            {[
              { step: "01", name: "Ingest", desc: "Receive raw record" },
              { step: "02", name: "Hash Check", desc: "Exact duplicate detection" },
              { step: "03", name: "Key Fields", desc: "Email/ID uniqueness" },
              { step: "04", name: "Fuzzy Match", desc: "Levenshtein similarity" },
              { step: "05", name: "Validate", desc: "Schema & field rules" },
              { step: "06", name: "Classify", desc: "UNIQUE → Append to DB" },
            ].map((s, i, arr) => (
              <div key={s.step} style={{ display: "flex", gap: 12, alignItems: "flex-start", paddingBottom: i < arr.length-1 ? 0 : 0 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#0f1624", border: "1px solid #1e3a5f", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#00e5a0", flexShrink: 0 }}>
                    {s.step}
                  </div>
                  {i < arr.length-1 && <div style={{ width: 1, height: 20, background: "#1e2d45" }} />}
                </div>
                <div style={{ paddingTop: 6 }}>
                  <div style={{ fontSize: 12, color: "#cbd5e1", fontWeight: 500 }}>{s.name}</div>
                  <div style={{ fontSize: 10, color: "#475569", marginTop: 1 }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Form / Presets */}
          <div style={{ background: "#0b1220", border: "1px solid #1e2d45", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ display: "flex", borderBottom: "1px solid #1e2d45", padding: "0 16px" }}>
              {[["submit","Submit Record"],["presets","Test Cases"]].map(([id,lbl]) => (
                <button key={id} className={`tab${activeTab===id?" active":""}`} onClick={() => setActiveTab(id)}>{lbl}</button>
              ))}
            </div>

            <div style={{ padding: 16 }}>
              {activeTab === "submit" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {[
                    ["name","Name","text","John Doe"],
                    ["email","Email","email","user@domain.com"],
                    ["phone","Phone","text","+1-555-0000"],
                    ["age","Age","number","30"],
                    ["dept","Department","text","Engineering"],
                  ].map(([k,lbl,t,ph]) => (
                    <div key={k} className="field">
                      <label>{lbl}</label>
                      <input type={t} placeholder={ph} value={form[k]}
                        onChange={e => setForm(p => ({ ...p, [k]: e.target.value }))} />
                    </div>
                  ))}
                  <button className="btn-primary" style={{ marginTop: 4, width: "100%" }}
                    disabled={processing || !form.name || !form.email}
                    onClick={handleSubmit}>
                    {processing ? "⟳  PROCESSING..." : "→  VALIDATE & SUBMIT"}
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <p style={{ fontSize: 11, color: "#475569", margin: "0 0 4px" }}>Click a test case to pre-fill the form:</p>
                  {PRESET_TESTS.map((p, i) => (
                    <button key={i} className="preset-btn" onClick={() => loadPreset(p)}>
                      {p.label}
                      <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>{p.data.name} · {p.data.email}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT — Tabs: Database + Audit Log */}
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          <div style={{ background: "#0b1220", border: "1px solid #1e2d45", borderRadius: 10, overflow: "hidden", flex: 1, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", borderBottom: "1px solid #1e2d45", padding: "0 16px", flexShrink: 0 }}>
              {[["database","Cloud Database"],["log","Audit Log"],["legend","Classification Guide"]].map(([id,lbl]) => (
                <button key={id} className={`tab${activeTab===id?" active":""}`} onClick={() => setActiveTab(id)}>{lbl}</button>
              ))}
            </div>

            {/* DATABASE TAB */}
            {activeTab === "database" && (
              <div style={{ flex: 1, overflow: "auto", padding: 16 }} ref={logRef}>
                <div style={{ fontSize: 11, color: "#475569", marginBottom: 12 }}>
                  {db.length} verified records · Only unique, validated entries stored
                </div>
                {/* Header */}
                <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 1fr 80px 80px 80px 100px", gap: 8, padding: "6px 14px", fontSize: 10, letterSpacing: "0.12em", color: "#334155", textTransform: "uppercase", borderBottom: "1px solid #1e2d45", marginBottom: 4 }}>
                  <span>ID</span><span>Name</span><span>Email</span><span>Phone</span><span>Age</span><span>Dept</span><span>Hash</span>
                </div>
                {db.map(r => (
                  <div key={r.id} className="db-row"
                    style={{ background: highlight === r.id ? "#00e5a00a" : "transparent", border: highlight === r.id ? "1px solid #00e5a033" : "1px solid transparent" }}>
                    <span style={{ color: "#00e5a0", fontSize: 11 }}>{r.id}</span>
                    <span style={{ fontSize: 12 }}>{r.name}</span>
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>{r.email}</span>
                    <span style={{ fontSize: 11, color: "#64748b" }}>{r.phone}</span>
                    <span style={{ fontSize: 12 }}>{r.age}</span>
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>{r.dept}</span>
                    <span style={{ fontSize: 10, color: "#334155", fontFamily: "monospace" }}>{r._hash}</span>
                  </div>
                ))}
              </div>
            )}

            {/* AUDIT LOG TAB */}
            {activeTab === "log" && (
              <div style={{ flex: 1, overflow: "auto", padding: 16 }} ref={logRef}>
                {log.length === 0 && (
                  <div style={{ textAlign: "center", color: "#334155", padding: "40px 0", fontSize: 13 }}>
                    No entries processed yet. Submit a record to begin.
                  </div>
                )}
                {log.map(entry => {
                  const meta = STATUS_META[entry.result.status];
                  return (
                    <div key={entry.id} className="log-entry"
                      style={{ borderLeftColor: meta.color, background: meta.bg }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ fontSize: 16, color: meta.color }}>{meta.icon}</span>
                          <span className="badge" style={{ background: meta.bg, color: meta.color, border: `1px solid ${meta.color}33` }}>
                            {meta.label}
                          </span>
                          <span style={{ fontSize: 11, color: "#64748b" }}>{meta.action}</span>
                        </div>
                        <span style={{ fontSize: 10, color: "#334155" }}>{new Date(entry.ts).toLocaleTimeString()}</span>
                      </div>
                      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6, lineHeight: 1.5 }}>
                        {entry.result.reason}
                      </div>
                      <div style={{ display: "flex", gap: 16, fontSize: 11, color: "#475569", flexWrap: "wrap" }}>
                        <span>Name: <span style={{ color: "#94a3b8" }}>{entry.input.name}</span></span>
                        <span>Email: <span style={{ color: "#94a3b8" }}>{entry.input.email}</span></span>
                        {entry.result.matchedId && <span>Matched: <span style={{ color: meta.color }}>{entry.result.matchedId}</span></span>}
                        <span>Hash: <span style={{ color: "#334155", fontFamily: "monospace" }}>{entry.result.hash}</span></span>
                        {entry.result.confidence < 1 && (
                          <span>Similarity: <span style={{ color: meta.color }}>{(entry.result.confidence * 100).toFixed(1)}%</span></span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* LEGEND TAB */}
            {activeTab === "legend" && (
              <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {Object.entries(STATUS_META).map(([status, meta]) => (
                    <div key={status} style={{ display: "flex", gap: 16, alignItems: "flex-start", padding: 14, borderRadius: 8, background: meta.bg, border: `1px solid ${meta.color}22` }}>
                      <div style={{ fontSize: 22, color: meta.color, width: 32, textAlign: "center", flexShrink: 0 }}>{meta.icon}</div>
                      <div>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 6 }}>
                          <span style={{ fontWeight: 600, color: meta.color, fontSize: 13, letterSpacing: "0.05em" }}>{meta.label}</span>
                          <span className="badge" style={{ background: "#0f1624", color: "#64748b", border: "1px solid #1e2d45", fontSize: 9 }}>{meta.action}</span>
                        </div>
                        <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.6 }}>
                          {status === "UNIQUE"         && "Record passed all validation checks. No hash match, no key-field collision, similarity below threshold. Appended to the cloud database."}
                          {status === "DUPLICATE"      && "Exact hash match OR key field (email/ID/phone) already exists. Record is an identical or field-level duplicate. Rejected."}
                          {status === "FALSE_POSITIVE" && "High fuzzy similarity (≥92%) to an existing record. Likely a near-duplicate with minor variations. Blocked to prevent data pollution."}
                          {status === "SUSPECT"        && "Moderate similarity (75–92%) detected. Flagged for human review — may be a legitimate variant or accidental duplicate."}
                          {status === "INVALID"        && "Record failed schema or field validation: malformed email, invalid phone, missing required fields, or out-of-range values. Rejected."}
                        </div>
                        <div style={{ marginTop: 8, fontSize: 11, color: "#475569" }}>
                          <strong style={{ color: "#334155" }}>Detection method:</strong>{" "}
                          {status === "UNIQUE"         && "All pipeline stages passed"}
                          {status === "DUPLICATE"      && "FNV-1a hash comparison + key-field exact match"}
                          {status === "FALSE_POSITIVE" && "Levenshtein field-level similarity scoring"}
                          {status === "SUSPECT"        && "Levenshtein field-level similarity scoring"}
                          {status === "INVALID"        && "Regex validation + range/presence checks"}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Algorithm section */}
                <div style={{ marginTop: 20, padding: 16, background: "#080c14", borderRadius: 8, border: "1px solid #1e2d45" }}>
                  <div style={{ fontSize: 10, letterSpacing: "0.15em", color: "#475569", marginBottom: 10, textTransform: "uppercase" }}>Core Algorithms</div>
                  <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.8 }}>
                    <div><span style={{ color: "#00e5a0" }}>Hash:</span> FNV-1a 32-bit on canonically sorted JSON — O(n) per record</div>
                    <div><span style={{ color: "#a78bfa" }}>Fuzzy:</span> Levenshtein edit distance, normalized per field, averaged across all fields</div>
                    <div><span style={{ color: "#ff9f1c" }}>Thresholds:</span> ≥0.92 → FALSE POSITIVE · 0.75–0.92 → SUSPECT · &lt;0.75 → passes</div>
                    <div><span style={{ color: "#64748b" }}>Complexity:</span> O(|db| × |fields| × |str|²) per submission — scales with db size</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
