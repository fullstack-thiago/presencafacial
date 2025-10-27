// src/App.jsx
// Observação: mantenha face-api.js, @supabase/supabase-js e xlsx instalados
import React, { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function App() {
  // --- routes / app state ---
  const [route, setRoute] = useState("dashboard"); // 'login','dashboard','register','attendance','history'
  const [loadingModels, setLoadingModels] = useState(true);
  const [faceapi, setFaceapi] = useState(null);
  const [faceapiLoaded, setFaceapiLoaded] = useState(false);

  const [user, setUser] = useState(null); // demo single-account flow

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
  const DETECTION_INTERVAL_MS = 2500; // intervalo do loop
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

  // ---------- demo login ----------
  function loginDemo() {
    setUser({ name: "EmpresaAdmin" });
    setRoute("dashboard");
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
          // optionally update status: setStatusMsg('Sem rosto detectado');
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
    }, DETECTION_INTERVAL_MS);
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

  // ---------- UI ----------
  return (
    <div className="min-h-screen bg-gray-50 p-4 font-sans">
      <header className="max-w-3xl mx-auto mb-6">
        <h1 className="text-2xl font-bold">MVP - Presença Facial</h1>
        <p className="text-sm text-gray-600">Modelos: {loadingModels ? "carregando..." : faceapiLoaded ? "pronto" : "erro"}</p>
      </header>

      {!user ? (
        <div className="max-w-md mx-auto bg-white p-4 rounded shadow">
          <h2 className="text-lg">Login (demo)</h2>
          <button className="mt-4 px-4 py-2 bg-blue-600 text-white rounded" onClick={loginDemo}>
            Entrar como demo
          </button>
        </div>
      ) : (
        <main className="max-w-4xl mx-auto">
          <nav className="mb-4 flex gap-2">
            <button className={`px-3 py-2 rounded ${route === "dashboard" ? "bg-blue-600 text-white" : "bg-white"}`} onClick={() => setRoute("dashboard")}>
              Dashboard
            </button>
            <button
              className={`px-3 py-2 rounded ${route === "register" ? "bg-blue-600 text-white" : "bg-white"}`}
              onClick={() => {
                setRoute("register");
                fetchCompanies();
              }}
            >
              Registrar Funcionário
            </button>
            <button className={`px-3 py-2 rounded ${route === "attendance" ? "bg-blue-600 text-white" : "bg-white"}`} onClick={() => setRoute("attendance")}>
              Tela de Presença
            </button>
            <button
              className={`px-3 py-2 rounded ${route === "history" ? "bg-blue-600 text-white" : "bg-white"}`}
              onClick={() => {
                setRoute("history");
                fetchAttendances({ company_id: selectedCompany });
              }}
            >
              Histórico
            </button>
          </nav>

          {route === "dashboard" && (
            <section className="bg-white p-4 rounded shadow">
              <h2 className="text-lg font-semibold">Dashboard</h2>
              <p className="mt-2">Selecione a empresa para operar:</p>
              <select
                className="mt-2 p-2 border"
                value={selectedCompany || ""}
                onChange={(e) => {
                  const v = e.target.value || null;
                  setSelectedCompany(v);
                  fetchEmployees(v);
                }}
              >
                <option value="">-- selecione --</option>
                {companies.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.name}
                  </option>
                ))}
              </select>
              <div className="mt-4">
                <p>Funcionários cadastrados: {employees.length}</p>
                <p>Registros: {attendances.length}</p>
              </div>
            </section>
          )}

          {route === "register" && (
            <section className="bg-white p-4 rounded shadow">
              <h2 className="text-lg font-semibold">Registrar Funcionário</h2>
              <div className="mt-2">
                <label>Empresa</label>
                <select
                  className="block p-2 border"
                  value={selectedCompany || ""}
                  onChange={(e) => {
                    const v = e.target.value || null;
                    setSelectedCompany(v);
                    fetchEmployees(v);
                  }}
                >
                  <option value="">-- selecione --</option>
                  {companies.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-2">
                <label>Nome</label>
                <input className="block p-2 border w-full" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <label className="mt-2">Cargo</label>
                <input className="block p-2 border w-full" value={newRole} onChange={(e) => setNewRole(e.target.value)} />
              </div>

              <div className="mt-3">
                <div className="flex gap-2 items-center">
                  <button className="px-3 py-2 bg-green-600 text-white rounded" onClick={openCamera}>
                    Abrir Câmera
                  </button>
                  <button className="px-3 py-2 bg-yellow-500 text-white rounded" onClick={switchFacing}>
                    Trocar Frente/Trás
                  </button>
                  <button className="px-3 py-2 bg-indigo-600 text-white rounded" onClick={handleCaptureForRegister}>
                    Capturar Rostos
                  </button>
                </div>

                <video ref={videoRef} className="w-full mt-2 rounded border" autoPlay muted playsInline style={{ maxHeight: 300 }} />
                <p className="mt-2 text-sm">Capturas: {capturedDescriptors.length}</p>

                <div className="mt-2">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                    Aceito que meus dados biométricos (descritores) sejam armazenados para controle de presença.
                  </label>
                </div>

                <div className="mt-2">
                  <button className="px-4 py-2 bg-blue-600 text-white rounded" onClick={saveNewEmployee}>
                    Salvar Funcionário
                  </button>
                </div>
              </div>
            </section>
          )}

          {route === "attendance" && (
            <section className="bg-white p-4 rounded shadow">
              <h2 className="text-lg font-semibold">Tela de Presença</h2>
              <p className="mt-2">Empresa: {companies.find((c) => String(c.id) === String(selectedCompany))?.name || "nenhuma selecionada"}</p>

              <div className="flex gap-2 mt-2">
                <button className="px-3 py-2 bg-green-600 text-white rounded" onClick={openCamera}>
                  Abrir Câmera
                </button>
                <button className="px-3 py-2 bg-purple-600 text-white rounded" onClick={startAttendanceLoop}>
                  Iniciar Reconhecimento
                </button>
                <button className="px-3 py-2 bg-red-600 text-white rounded" onClick={stopAttendanceLoop}>
                  Parar
                </button>
                <button className="px-3 py-2 bg-yellow-500 text-white rounded" onClick={switchFacing}>
                  Trocar Câmera
                </button>
              </div>

              <video ref={videoRef} className="w-full mt-2 rounded border" autoPlay muted playsInline style={{ maxHeight: 360 }} />
              <p className="mt-2 text-sm">Status: {statusMsg}</p>
            </section>
          )}

          {route === "history" && (
            <section className="bg-white p-4 rounded shadow">
              <h2 className="text-lg font-semibold">Histórico</h2>
              <div className="mt-2 flex gap-2">
                <button className="px-3 py-2 bg-gray-200 rounded" onClick={() => fetchAttendances({ company_id: selectedCompany })}>
                  Carregar
                </button>
                <button className="px-3 py-2 bg-blue-600 text-white rounded" onClick={exportAttendancesToExcel}>
                  Exportar XLSX
                </button>
              </div>

              <div className="mt-4 overflow-auto max-h-96">
                <table className="w-full text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th>ID</th>
                      <th>Funcionário</th>
                      <th>Quando</th>
                      <th>Confiança</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attendances.map((a) => (
                      <tr key={a.id} className="border-t">
                        <td className="p-1">{String(a.id).slice(0, 6)}</td>
                        <td className="p-1">{a.employees?.name || a.employee_id}</td>
                        <td className="p-1">{new Date(a.attended_at).toLocaleString()}</td>
                        <td className="p-1">{Number(a.confidence).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </main>
      )}

      <footer className="max-w-3xl mx-auto mt-6 text-sm text-gray-500">
        Feito como esqueleto. Ajuste permissões Supabase e LGPD antes de usar em produção.
      </footer>
    </div>
  );
}
