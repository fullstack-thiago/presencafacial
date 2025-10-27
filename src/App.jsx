// src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import "./styles.css";

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
  const attendanceInterval = useRef(null);
  const videoRef = useRef(null);
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

  // CONFIG
  const DEDUP_MS = 5 * 60 * 1000; // 5 minutos para evitar duplicação de presença
  const DETECTION_INTERVAL_MS = 2500; // intervalo padrão (desktop)
  const MATCH_THRESHOLD = 0.55; // face matcher threshold (ajustável)

  // lastSeen local to avoid hammering DB when same person is in frame repeatedly
  const lastSeenRef = useRef({}); // { [employeeId]: timestamp }

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
      stopAttendanceLoop();
      // cleanup camera
      if (streamRef.current) {
        try {
          streamRef.current.getTracks().forEach((t) => t.stop());
        } catch (e) {}
        streamRef.current = null;
      }
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
    stopAttendanceLoop();
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      streamRef.current = null;
    }
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
    } catch (err) {
      console.error("Erro abrir câmera", err);
      setStatusMsg("Erro ao abrir câmera: " + String(err));
    }
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
      const options = new faceapi.TinyFaceDetectorOptions();
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

  // ---------- attendance loop ----------
  async function startAttendanceLoop() {
    if (!selectedCompany) {
      setStatusMsg("Selecione uma empresa primeiro");
      return;
    }
    if (!faceapiLoaded || !faceapi) {
      setStatusMsg("Modelos não carregados ainda");
      return;
    }
    if (!videoRef.current) {
      setStatusMsg("Vídeo não disponível");
      return;
    }

    // fetch employees of the company once
    const { data: emps, error: e } = await supabase.from("employees").select("*").eq("company_id", String(selectedCompany));
    if (e) {
      console.error(e);
      setStatusMsg("Erro buscando funcionários");
      return;
    }
    if (!emps?.length) {
      setStatusMsg("Nenhum funcionário cadastrado");
      return;
    }

    setEmployees(emps);

    // build labeled descriptors (converted to Float32Array)
    const labeled = emps.map((e2) => {
      const descs = (e2.descriptors || []).map((d) => new Float32Array(d));
      // label use employee id string (more robust than name)
      return new faceapi.LabeledFaceDescriptors(String(e2.id), descs);
    });

    const faceMatcher = new faceapi.FaceMatcher(labeled, MATCH_THRESHOLD);
    setStatusMsg("🔄 Reconhecimento contínuo iniciado...");

    // clear previous interval
    if (attendanceInterval.current) {
      clearInterval(attendanceInterval.current);
      attendanceInterval.current = null;
    }

    // adjust interval for mobile to save CPU/battery
    const intervalMs = (typeof window !== "undefined" && window.innerWidth <= 540) ? 4000 : DETECTION_INTERVAL_MS;

    // detection loop
    attendanceInterval.current = setInterval(async () => {
      try {
        if (!videoRef.current || videoRef.current.paused || videoRef.current.ended) return;

        const options = new faceapi.TinyFaceDetectorOptions();
        // detect all faces in frame (to support multiple people)
        const detections = await faceapi
          .detectAllFaces(videoRef.current, options)
          .withFaceLandmarks()
          .withFaceDescriptors();

        if (!detections || detections.length === 0) {
          // optional: setStatusMsg('Sem rosto detectado');
          return;
        }

        // iterate detections
        for (const det of detections) {
          const best = faceMatcher.findBestMatch(det.descriptor);
          if (best.label !== "unknown") {
            const matchedEmployeeId = best.label; // string
            const confidence = best.distance;

            // local dedup: check lastSeenRef
            const lastSeen = lastSeenRef.current[matchedEmployeeId];
            const now = Date.now();
            if (lastSeen && now - lastSeen < DEDUP_MS) {
              setStatusMsg(`⚠️ ${matchedEmployeeId} já registrado nos últimos ${Math.round(DEDUP_MS / 60000)} min`);
              continue;
            }

            // check DB last record for safety (server-side dedup still recommended)
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
              // insert attendance
              const { error: insertErr } = await supabase.from("attendances").insert([
                {
                  company_id: String(selectedCompany),
                  employee_id: matchedEmployeeId,
                  confidence,
                },
              ]);
              if (insertErr) {
                console.error("Erro inserindo attendance", insertErr);
                setStatusMsg("Erro ao salvar presença");
              } else {
                lastSeenRef.current[matchedEmployeeId] = now;
                setStatusMsg(`✅ Presença registrada: ${matchedEmployeeId} (conf: ${Number(confidence).toFixed(2)})`);
                // opcional: atualizar histórico local
                fetchAttendances({ company_id: selectedCompany });
              }
            } else {
              lastSeenRef.current[matchedEmployeeId] = now;
              setStatusMsg(`⚠️ ${matchedEmployeeId} já registrado nos últimos ${Math.round(DEDUP_MS / 60000)} min`);
            }
          }
        }
      } catch (err) {
        console.error("Erro no loop de reconhecimento", err);
      }
    }, intervalMs);
  }

  function stopAttendanceLoop() {
    if (attendanceInterval.current) {
      clearInterval(attendanceInterval.current);
      attendanceInterval.current = null;
    }
    setStatusMsg("⏹️ Reconhecimento parado");
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
      <img src="/src/assets/logo_saude.png" alt="Logo da Clínica" className="logo-clinica" />
      <div>
        <h1 className="title">R.R. Prevenção em Saúde</h1>
        <p className="subtitle">Presença Facial</p>
      </div>
    </div>

    <div className="header-actions">
      <div className="models-status">
        Status: {loadingModels ? "carregando..." : faceapiLoaded ? "Online" : "Offline"}
      </div>

      {/* Botão de login só aparece se o usuário não estiver logado e se você quiser exibir em outras telas */}
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
            <aside className="sidebar" aria-hidden={typeof window !== "undefined" && window.innerWidth <= 900}>
              <nav>
                <button className={`nav-btn ${route === "dashboard" ? "active" : ""}`} onClick={() => setRoute("dashboard")}>Dashboard</button>
                <button className={`nav-btn ${route === "register" ? "active" : ""}`} onClick={() => { setRoute("register"); fetchCompanies(); }}>Registrar Funcionário</button>
                <button className={`nav-btn ${route === "attendance" ? "active" : ""}`} onClick={() => setRoute("attendance")}>Tela de Presença</button>
                <button className={`nav-btn ${route === "history" ? "active" : ""}`} onClick={() => { setRoute("history"); fetchAttendances({ company_id: selectedCompany }); }}>Histórico</button>
              </nav>

            </aside>

            <section className="content">
              {route === "dashboard" && (
                <div className="card">
                  <h2>Dashboard</h2>
                  <div className="row gap">
                    <div className="col">
                      <label className="label">Empresa</label>
                      <select className="select" value={selectedCompany || ""} onChange={(e) => { const v = e.target.value || null; setSelectedCompany(v); fetchEmployees(v); }}>
                        <option value="">-- selecione --</option>
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
                  <h2>Registrar Funcionário</h2>

                  <div className="form-row">
                    <label>Empresa</label>
                    <select className="select" value={selectedCompany || ""} onChange={(e) => { const v = e.target.value || null; setSelectedCompany(v); fetchEmployees(v); }}>
                      <option value="">-- selecione --</option>
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
                  <h2>Tela de Presença</h2>
                  <p className="muted">Empresa: {companies.find((c) => String(c.id) === String(selectedCompany))?.name || "nenhuma selecionada"}</p>

                  <div className="row gap">
                    <div>
                      <button className="btn green" onClick={openCamera}>Abrir Câmera</button>
                      <button className="btn purple" onClick={startAttendanceLoop}>Iniciar Reconhecimento</button>
                      <button className="btn red" onClick={stopAttendanceLoop}>Parar</button>
                      <button className="btn yellow" onClick={switchFacing}>Trocar Câmera</button>
                    </div>
                  </div>

                  <div className="video-wrapper">
                    <video ref={videoRef} className="video" autoPlay muted playsInline />
                  </div>

                  <p className="status" role="status">Status: {statusMsg}</p>
                </div>
              )}

              {route === "history" && (
                <div className="card">
                  <h2>Histórico</h2>
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

      {/* BOTTOM NAV (agora visível em todas as larguras) */}
      {user && (
        <div className="bottom-nav" role="navigation" aria-label="Navegação principal">
          <button className={`nav-item ${route === "dashboard" ? "active" : ""}`} onClick={() => setRoute("dashboard")}>Dashboard</button>
          <button className={`nav-item ${route === "register" ? "active" : ""}`} onClick={() => { setRoute("register"); fetchCompanies(); }}>Registrar</button>
          <button className={`nav-item ${route === "attendance" ? "active" : ""}`} onClick={() => setRoute("attendance")}>Presença</button>
          <button className={`nav-item ${route === "history" ? "active" : ""}`} onClick={() => { setRoute("history"); fetchAttendances({ company_id: selectedCompany }); }}>Histórico</button>
        </div>
      )}

    </div>
  );
}