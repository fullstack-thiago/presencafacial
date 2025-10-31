// FILE: src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import "./styles.css";
import logo from '/src/assets/logo_saude.png';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- HARD-CODED SINGLE USER (determinada no código) ---
const HARDCODED_USER = {
  username: "admin",
  password: "senha123", // troque conforme quiser
  name: "R.R.",
};

export default function App() {
  // --- routes / app state ---
  const [route, setRoute] = useState("login"); // 'login','dashboard','register','attendance','history'
  const [loadingModels, setLoadingModels] = useState(true);
  const [faceapi, setFaceapi] = useState(null);
  const [faceapiLoaded, setFaceapiLoaded] = useState(false);

  const [user, setUser] = useState(null); // agora controlado por login real

  // Login form
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  // Entities
  const [companies, setCompanies] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [selectedCompany, setSelectedCompany] = useState(null); // keep as string or uuid

  // Camera / attendance
  const attendanceInterval = useRef(null); // kept for compatibility
  const recognitionRaf = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null); // overlay canvas
  const streamRef = useRef(null); // ← usar ref para stream para cleanup seguro
  const [facingMode, setFacingMode] = useState("environment");
  const [statusMsg, setStatusMsg] = useState("");

  // Register form
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("");
  const [capturedDescriptors, setCapturedDescriptors] = useState([]);
  const [consent, setConsent] = useState(false); // consentimento LGPD simples

  // History
  const [attendances, setAttendances] = useState([]);

  // LIVE match list and overlay toggle
  const [recentMatches, setRecentMatches] = useState([]); // small live list
  const [showOverlay, setShowOverlay] = useState(true);

  // Fullscreen camera app mode
  const [cameraFullscreen, setCameraFullscreen] = useState(false);

  // Auto recognition toggle (new)
  const [autoRecognitionEnabled, setAutoRecognitionEnabled] = useState(true);

  // CONFIG (made faster)
  const DEDUP_MS = 5 * 60 * 1000; // 5 minutos para evitar duplicação de presença
  const DETECTION_INTERVAL_MS = 800; // intervalo padrão (mais rápido)
  const MATCH_THRESHOLD = 0.55; // face matcher threshold (ajustável)

  // lastSeen local to avoid hammering DB when same person is in frame repeatedly
  const lastSeenRef = useRef({}); // { [employeeId]: timestamp }

  // guards
  const recognitionRunningRef = useRef(false);
  const isProcessingRef = useRef(false);

  // small cached matcher & map so detector isn't rebuilt each frame
  const faceMatcherRef = useRef(null);
  const idNameMapRef = useRef({});

  // ---------- load face-api dynamically and models ----------
  useEffect(() => {
    let mounted = true;
    async function loadFaceApiAndModels() {
      try {
        const f = await import("face-api.js");
        if (!mounted) return;
        setFaceapi(f);
        const MODEL_URL = "/models"; // coloque os arquivos de modelos em public/models
        setLoadingModels(true);
        await f.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await f.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        await f.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
        setFaceapiLoaded(true);
        setLoadingModels(false);
        setStatusMsg("Modelos prontos");
      } catch (err) {
        console.error("Erro carregando face-api", err);
        setStatusMsg("Erro carregando modelos: " + String(err));
        setLoadingModels(false);
      }
    }

    loadFaceApiAndModels();

    fetchCompanies();

    return () => {
      mounted = false;
      stopRecognitionLoop();
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-open camera when switching facingMode or route that uses camera
  useEffect(() => {
    if (!videoRef.current) return;
    if (route === "register" || route === "attendance") {
      const t = setTimeout(() => {
        openCamera();
      }, 300);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facingMode, route]);

  // If user toggles auto-recognition while fullscreen, start/stop accordingly
  useEffect(() => {
    if (!cameraFullscreen) return;
    if (autoRecognitionEnabled) {
      // start recognition if camera is open
      if (videoRef.current && streamRef.current) {
        prepareFaceMatcherAndStart();
      }
    } else {
      stopRecognitionLoop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRecognitionEnabled, cameraFullscreen]);

  // ---------- Supabase helpers ----------
  async function fetchCompanies() {
    const { data, error } = await supabase.from("companies").select("*").order("name");
    if (error) {
      console.error("fetchCompanies", error);
      setStatusMsg("Erro carregando empresas");
      return;
    }
    setCompanies(data || []);
  }

  async function fetchEmployees(companyId) {
    if (!companyId) {
      setEmployees([]);
      return;
    }
    const { data, error } = await supabase.from("employees").select("*").eq("company_id", String(companyId));
    if (error) {
      console.error("fetchEmployees", error);
      setStatusMsg("Erro carregando funcionários");
      return;
    }
    setEmployees(data || []);
  }

  async function fetchAttendances(filters = {}) {
    try {
      let q = supabase
        .from("attendances")
        .select("*,employees!inner(name)")
        .order("attended_at", { ascending: false })
        .limit(1000);
      if (filters.company_id) q = q.eq("company_id", String(filters.company_id));
      if (filters.employee_id) q = q.eq("employee_id", String(filters.employee_id));
      const { data, error } = await q;
      if (error) {
        console.error(error);
      } else {
        setAttendances(data || []);
      }
    } catch (err) {
      console.error("Erro fetchAttendances", err);
    }
  }

  // ---------- login handling (single hard-coded user) ----------
  function handleLogin(e) {
    e && e.preventDefault && e.preventDefault();
    if (loginUsername === HARDCODED_USER.username && loginPassword === HARDCODED_USER.password) {
      setUser({ name: HARDCODED_USER.name, username: HARDCODED_USER.username });
      setLoginPassword("");
      setLoginUsername("");
      setRoute("dashboard");
      setStatusMsg("Usuário autenticado");
    } else {
      alert("Usuário ou senha inválidos");
    }
  }

  function handleLogout() {
    stopRecognitionLoop();
    stopCamera();
    setUser(null);
    setRoute("login");
    setStatusMsg("");
  }

  // ---------- camera helpers ----------
  async function openCamera() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatusMsg("getUserMedia não suportado neste navegador");
        return;
      }

      // stop existing stream safely
      if (streamRef.current) {
        try {
          streamRef.current.getTracks().forEach((t) => t.stop());
        } catch (e) {}
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
      }

      const constraints = { video: { facingMode } };
      const s = await navigator.mediaDevices.getUserMedia(constraints);

      if (!videoRef.current) {
        s.getTracks().forEach((t) => t.stop());
        setStatusMsg("Vídeo não disponível");
        return;
      }

      videoRef.current.srcObject = s;
      await videoRef.current.play().catch(() => {});
      streamRef.current = s;
      setStatusMsg("Câmera aberta");

      // resize canvas to match video using devicePixelRatio for crispness
      setTimeout(() => {
        const canvas = canvasRef.current;
        const v = videoRef.current;
        if (canvas && v) {
          const ratio = window.devicePixelRatio || 1;
          canvas.width = (v.videoWidth || v.clientWidth) * ratio;
          canvas.height = (v.videoHeight || v.clientHeight) * ratio;
          canvas.style.width = "100vw";
          canvas.style.height = "100vh";
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        }
      }, 400);

      // auto-start recognition when camera opens and fullscreen active + toggle enabled
      if (cameraFullscreen && autoRecognitionEnabled) {
        if (!selectedCompany) {
          setStatusMsg('Selecione a empresa antes de abrir a câmera');
        } else {
          await prepareFaceMatcherAndStart();
        }
      }
    } catch (err) {
      console.error("Erro abrir câmera", err);
      setStatusMsg("Erro ao abrir câmera: " + String(err));
    }
  }

  function stopCamera() {
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch (e) {
        console.error('Erro ao parar tracks', e);
      }
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  function switchFacing() {
    setFacingMode((prev) => (prev === "user" ? "environment" : "user"));
  }

  // ---------- registration capture ----------
  async function captureDescriptorFromVideo() {
    if (!faceapiLoaded || !faceapi) {
      setStatusMsg("Modelos não carregados ainda");
      return null;
    }
    if (!videoRef.current) {
      setStatusMsg("Vídeo não disponível");
      return null;
    }
    try {
      const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.5 });
      const detection = await faceapi
        .detectSingleFace(videoRef.current, options)
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (!detection) return null;
      return Array.from(detection.descriptor);
    } catch (err) {
      console.error("Erro detectar rosto", err);
      return null;
    }
  }

  async function handleCaptureForRegister() {
    setStatusMsg("Capturando...");
    const desc = await captureDescriptorFromVideo();
    if (!desc) {
      setStatusMsg("Nenhum rosto detectado. Tente novamente.");
      return;
    }
    setCapturedDescriptors((prev) => {
      const updated = [...prev, desc];
      setStatusMsg("Captura realizada. Total: " + updated.length);
      return updated;
    });
  }

  async function saveNewEmployee() {
    if (!selectedCompany) {
      alert("Selecione uma empresa");
      return;
    }
    if (!newName) {
      alert("Nome é obrigatório");
      return;
    }
    if (capturedDescriptors.length === 0) {
      alert("Capte ao menos 1 foto");
      return;
    }
    if (!consent) {
      alert("Consentimento obrigatório para armazenar dados biométricos");
      return;
    }

    const payload = {
      company_id: String(selectedCompany),
      name: newName,
      role: newRole,
      descriptors: capturedDescriptors,
      photos: [],
    };

    try {
      const { data, error } = await supabase.from("employees").insert([payload]).select();
      if (error) {
        console.error(error);
        alert("Erro ao salvar funcionário");
        return;
      }
      alert("Funcionário salvo");
      setNewName("");
      setNewRole("");
      setCapturedDescriptors([]);
      setConsent(false);
      fetchEmployees(selectedCompany);
      setRoute("dashboard");
    } catch (err) {
      console.error("Erro saveNewEmployee", err);
      alert("Erro inesperado ao salvar funcionário");
    }
  }

  // ---------- recognition setup and RAF loop (automatic when camera opens) ----------
  async function prepareFaceMatcherAndStart() {
    if (!selectedCompany) {
      setStatusMsg('Selecione uma empresa');
      return;
    }
    if (!faceapiLoaded || !faceapi) {
      setStatusMsg('Modelos não carregados');
      return;
    }

    // fetch employees once
    const { data: emps, error: e } = await supabase.from("employees").select("*").eq("company_id", String(selectedCompany));
    if (e) {
      console.error(e);
      setStatusMsg('Erro buscando funcionários');
      return;
    }
    if (!emps?.length) {
      setStatusMsg('Nenhum funcionário cadastrado');
      return;
    }

    setEmployees(emps);

    // build map and matcher
    const idMap = {};
    const labeled = emps.map((e2) => {
      idMap[String(e2.id)] = e2.name;
      const descs = (e2.descriptors || []).map((d) => new Float32Array(d));
      return new faceapi.LabeledFaceDescriptors(String(e2.id), descs);
    });

    idNameMapRef.current = idMap;
    faceMatcherRef.current = new faceapi.FaceMatcher(labeled, MATCH_THRESHOLD);

    // start RAF loop
    startRecognitionLoop();
  }

  function startRecognitionLoop() {
    if (recognitionRunningRef.current) return;
    recognitionRunningRef.current = true;
    setStatusMsg('🔄 Reconhecimento automático iniciado');

    let lastRun = 0;

    const loop = async (timestamp) => {
      recognitionRaf.current = requestAnimationFrame(loop);
      if (!recognitionRunningRef.current) return;
      if (!videoRef.current || videoRef.current.paused || videoRef.current.ended) return;
      if (timestamp - lastRun < (window.innerWidth <= 540 ? DETECTION_INTERVAL_MS - 200 : DETECTION_INTERVAL_MS)) return; // throttle
      lastRun = timestamp;

      if (isProcessingRef.current) return;
      isProcessingRef.current = true;

      try {
        const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.5 });
        const detections = await faceapi
          .detectAllFaces(videoRef.current, options)
          .withFaceLandmarks()
          .withFaceDescriptors();

        const canvas = canvasRef.current;
        const ctx = canvas ? canvas.getContext('2d') : null;
        if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (!detections || detections.length === 0) {
          isProcessingRef.current = false;
          return;
        }

        const matcher = faceMatcherRef.current;
        const idMap = idNameMapRef.current;

        for (const det of detections) {
          const best = matcher.findBestMatch(det.descriptor);
          const label = best.label;

          if (ctx) {
            const box = det.detection.box;
            ctx.lineWidth = 4;
            ctx.strokeStyle = 'rgba(0, 190, 120, 0.95)';
            ctx.strokeRect(box.x, box.y, box.width, box.height);

            const nameText = (label !== 'unknown') ? (idMap[label] || label) : 'Desconhecido';
            const fontSize = Math.max(14, Math.round((box.width || 80) / 12));
            ctx.font = `${fontSize}px Inter, Arial`;
            const padding = 8;
            const textWidth = ctx.measureText(nameText).width + padding * 2;
            const textHeight = fontSize + 8;
            ctx.fillStyle = 'rgba(0, 190, 120, 0.95)';
            ctx.fillRect(box.x, Math.max(0, box.y - textHeight - 6), textWidth, textHeight);
            ctx.fillStyle = '#fff';
            ctx.fillText(nameText, box.x + padding, Math.max(0, box.y - 10));
          }

          if (label !== 'unknown') {
            const matchedEmployeeId = label;
            const lastSeen = lastSeenRef.current[matchedEmployeeId];
            const now = Date.now();
            if (lastSeen && now - lastSeen < DEDUP_MS) {
              setRecentMatches((prev) => [{ id: matchedEmployeeId, name: idMap[matchedEmployeeId] || matchedEmployeeId, timestamp: now }, ...prev].slice(0, 6));
              continue;
            }

            // check DB last record
            const { data: last, error } = await supabase
              .from("attendances")
              .select("*")
              .eq("employee_id", matchedEmployeeId)
              .order("attended_at", { ascending: false })
              .limit(1);

            if (error) {
              console.error("Erro verificando último registro", error);
              continue;
            }

            const fiveMinutesAgo = new Date(Date.now() - DEDUP_MS);
            if (!last || !last.length || new Date(last[0].attended_at) < fiveMinutesAgo) {
              const { error: insertErr } = await supabase.from("attendances").insert([
                { company_id: String(selectedCompany), employee_id: matchedEmployeeId, confidence: best.distance },
              ]);
              if (insertErr) {
                console.error("Erro inserindo attendance", insertErr);
                setStatusMsg("Erro ao salvar presença");
              } else {
                lastSeenRef.current[matchedEmployeeId] = now;
                setStatusMsg(`✅ Presença registrada: ${idMap[matchedEmployeeId] || matchedEmployeeId}`);
                setRecentMatches((prev) => [{ id: matchedEmployeeId, name: idMap[matchedEmployeeId] || matchedEmployeeId, timestamp: now }, ...prev].slice(0, 6));
                fetchAttendances({ company_id: selectedCompany });
              }
            } else {
              lastSeenRef.current[matchedEmployeeId] = now;
              setStatusMsg(`⚠️ ${idMap[matchedEmployeeId] || matchedEmployeeId} já registrado nos últimos ${Math.round(DEDUP_MS / 60000)} min`);
            }
          }
        }

      } catch (err) {
        console.error('Erro no loop de reconhecimento', err);
      } finally {
        isProcessingRef.current = false;
      }
    };

    recognitionRaf.current = requestAnimationFrame(loop);
  }

  function stopRecognitionLoop() {
    if (recognitionRaf.current) {
      cancelAnimationFrame(recognitionRaf.current);
      recognitionRaf.current = null;
    }
    recognitionRunningRef.current = false;
    isProcessingRef.current = false;
    setStatusMsg('⏹️ Reconhecimento parado');
  }

  // ---------- export XLSX ----------
  function exportAttendancesToExcel() {
    if (!attendances || attendances.length === 0) {
      alert("Sem registros");
      return;
    }
    const rows = attendances.map((r) => ({
      id: r.id,
      employee: r.employees?.name || r.employee_id,
      attended_at: r.attended_at,
      confidence: r.confidence,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Presencas");
    XLSX.writeFile(wb, "presencas.xlsx");
  }

  // UI
  return (
    <div className="app-root">
      <header className="app-header">
        <div className="header-inner">
          <div className="brand">
            {/* Substitua o caminho abaixo pelo caminho da sua logo */}
            <img src={logo} alt="Logo da Clínica" className="logo-clinica" />
            <div>
              <h1 className="title">R.R. Prevenção em Saúde</h1>
              <p className="subtitle">Presença Facial</p>
            </div>
          </div>

          <div className="header-actions">
            <div className="models-status">
              Status: {loadingModels ? "carregando..." : faceapiLoaded ? "Online" : "Offline"}
            </div>

            {user && (
              <>
                <div className="user-pill">{user.name}</div>
                <button className="btn" onClick={handleLogout}>Sair</button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="app-main">
        {!user ? (
          // Login page
          <div className="card center-card">
            <h2>Login</h2>
            <form onSubmit={handleLogin} style={{ width: "100%" }}>
              <div className="form-row">
                <label className="label">Usuário</label>
                <input className="input" value={loginUsername} onChange={(e) => setLoginUsername(e.target.value)} />
              </div>
              <div className="form-row">
                <label className="label">Senha</label>
                <input className="input" type="password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} />
              </div>
              <div className="form-row">
                <button className="btn primary" type="submit">Entrar</button>
              </div>
            </form>
          </div>
        ) : (
          <div className="layout">
            <section className="content">
              {route === "dashboard" && (
                <div className="card">
                  <h2>Dashboard</h2>
                  <div className="row gap">
                    <div className="col">
                      <label className="label">🏢 - Empresa </label>
                      <br></br>
                      <select className="select" value={selectedCompany || ""} onChange={(e) => { const v = e.target.value || null; setSelectedCompany(v); fetchEmployees(v); }}>
                        <option value="">-- selecione a empresa --</option>
                        {companies.map((c) => (
                          <option key={c.id} value={String(c.id)}>{c.name}</option>
                        ))}
                      </select>
                    </div>

                    <div className="col stats">
                      <div className="stat">
                        <div className="stat-value">{employees.length}</div>
                        <div className="stat-label">Funcionários</div>
                      </div>
                      <div className="stat">
                        <div className="stat-value">{attendances.length}</div>
                        <div className="stat-label">Registros</div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {route === "register" && (
                <div className="card">
                  <h2>✚ Registrar Funcionário</h2>
                  <br></br>
                  <div className="form-row">
                    <label>Empresa</label>
                    <select className="select" value={selectedCompany || ""} onChange={(e) => { const v = e.target.value || null; setSelectedCompany(v); fetchEmployees(v); }}>
                      <option value="">-- selecione a empresa --</option>
                      {companies.map((c) => (<option key={c.id} value={String(c.id)}>{c.name}</option>))}
                    </select>
                  </div>

                  <div className="form-row">
                    <label>Nome</label>
                    <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} />
                  </div>

                  <div className="form-row">
                    <label>Cargo</label>
                    <input className="input" value={newRole} onChange={(e) => setNewRole(e.target.value)} />
                  </div>

                  <div className="form-row actions">
                    <div className="btn-group">
                      <button className="btn green" onClick={openCamera}>Abrir Câmera</button>
                      <button className="btn yellow" onClick={switchFacing}>Trocar Frente/Trás</button>
                      <button className="btn indigo" onClick={handleCaptureForRegister}>Capturar Rostos</button>
                    </div>
                  </div>

                  <div className="video-wrapper">
                    <video ref={videoRef} className="video" autoPlay muted playsInline />
                    <div className="capture-info">Capturas: {capturedDescriptors.length}</div>
                  </div>

                  <div className="form-row">
                    <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Aceito que meus dados biométricos sejam armazenados.</label>
                  </div>

                  <div className="form-row">
                    <button className="btn primary" onClick={saveNewEmployee}>Salvar Funcionário</button>
                  </div>
                </div>
              )}

              {route === "attendance" && (
                <div className="card">
                  {/* Modified attendance summary: only one button initially */}
                  {!cameraFullscreen ? (
                    <>
                      <h2>✅ Tela de Presença</h2>
                      <p className="muted">Empresa: {companies.find((c) => String(c.id) === String(selectedCompany))?.name || 'nenhuma selecionada'}</p>

                      <div className="form-row">
                        <label className="checkbox-label"><input type="checkbox" checked={autoRecognitionEnabled} onChange={(e) => setAutoRecognitionEnabled(e.target.checked)} /> Reconhecimento automático</label>
                      </div>

                      <br />
                      <div className="form-row">
                        <button className="btn primary" onClick={() => { setCameraFullscreen(true); openCamera(); }}>Abrir Câmera</button>
                      </div>
                    </>
                  ) : (
                    // placeholder when fullscreen active
                    <div style={{ minHeight: 120 }} />
                  )}
                </div>
              )}

              {route === "history" && (
                <div className="card">
                  <h2>📋 Histórico</h2>
                  <br></br>
                  <div className="row gap">
                    <button className="btn" onClick={() => fetchAttendances({ company_id: selectedCompany })}>Carregar</button>
                    <button className="btn primary" onClick={exportAttendancesToExcel}>Exportar XLSX</button>
                  </div>

                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr><th>ID</th><th>Funcionário</th><th>Quando</th><th>Confiança</th></tr>
                      </thead>
                      <tbody>
                        {attendances.map((a) => (
                          <tr key={a.id}><td>{String(a.id).slice(0,6)}</td><td>{a.employees?.name || a.employee_id}</td><td>{new Date(a.attended_at).toLocaleString()}</td><td>{Number(a.confidence).toFixed(2)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      {/* Fullscreen camera view overlay (when cameraFullscreen = true) */}
      {user && cameraFullscreen && (
        <div className="camera-fullscreen">
          <video ref={videoRef} className="video-fullscreen" autoPlay muted playsInline />
          <canvas ref={canvasRef} className="overlay-canvas" />

          {/* close button top-right (icon) */}
          <button className="camera-close" aria-label="Fechar" onClick={() => { stopRecognitionLoop(); stopCamera(); setCameraFullscreen(false); }}>✖</button>

          {/* recent matches top-left */}
          <div className="recent-matches left">
            <h4>Últimos</h4>
            <ul>
              {recentMatches.map((m) => (
                <li key={m.id + String(m.timestamp)}>{m.name}</li>
              ))}
            </ul>
          </div>

          {/* floating controls at bottom center: keep only switch camera */}
          <div className="camera-controls centered">
            <button className="btn icon-btn" onClick={() => { switchFacing(); stopRecognitionLoop(); setTimeout(() => openCamera(), 400); }} aria-label="Trocar">🔁</button>
          </div>
        </div>
      )}

      {/* BOTTOM NAV (agora visível em todas as larguras) */}
      {user && (
        <div className="bottom-nav" role="navigation" aria-label="Navegação principal">
          <button className={`nav-item ${route === "dashboard" ? "active" : ""}`} onClick={() => setRoute("dashboard")}><span style={{ fontSize: "28px" }}>💻</span></button>
          <button className={`nav-item ${route === "register" ? "active" : ""}`} onClick={() => { setRoute("register"); fetchCompanies(); }}><span style={{ color: "#ffffffff", fontSize: "26px" }}>🧑‍💼</span></button>
          <button className={`nav-item ${route === "attendance" ? "active" : ""}`} onClick={() => { setRoute("attendance"); setCameraFullscreen(false); }}><span style={{ color: "#ffffffff", fontSize: "26px" }}>✋</span></button>
          <button className={`nav-item ${route === "history" ? "active" : ""}`} onClick={() => { setRoute("history"); fetchAttendances({ company_id: selectedCompany }); }}><span style={{ color: "#ffffffff", fontSize: "26px" }}>📋</span></button>
        </div>
      )}
    </div>
  );
}

/*f
/* FILE: src/styles.css - UPDATES (no visual changes required for toggle; using existing checkbox styles) */