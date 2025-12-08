// FILE: src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import "./styles.css";
import logo from '/src/assets/logo_saude.png';
import casaIcon from './assets/dashboardx.png';
import funcionarioIcon from './assets/funcionariox.png';
import historicoIcon from './assets/relatoriox.png';

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
  // --- Manter login ao dar F5 ---
  const storedUser = localStorage.getItem('usuarioLogado');

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
  const [employees, setEmployees] = useState([]); // employees for selectedCompany
  const [selectedCompany, setSelectedCompany] = useState(null); // keep as string or uuid

  // Registered employees list (dashboard container)
  const [registeredEmployees, setRegisteredEmployees] = useState([]);
  const [searchName, setSearchName] = useState("");

  // Camera / attendance
  const recognitionRaf = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null); // overlay canvas
  const streamRef = useRef(null); // ← usar ref para stream para cleanup seguro
  const [facingMode, setFacingMode] = useState("environment");
  const [statusMsg, setStatusMsg] = useState("");

  // small control flags & refs for blocking repetitive actions
  const switchInProgressRef = useRef(false);
  const openInProgressRef = useRef(false);

  // recognition enabled state + persistence
  const [recognitionEnabled, setRecognitionEnabled] = useState(false);

  // Register form (and edit)
  const [newName, setNewName] = useState("");
  const [newDepartment, setNewDepartment] = useState("");
  const [capturedDescriptors, setCapturedDescriptors] = useState([]);
  const [editEmployeeId, setEditEmployeeId] = useState(null);

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
  const DETECTION_INTERVAL_MS = 700; // intervalo padrão (mais rápido)
  const MATCH_THRESHOLD = 0.55; // face matcher threshold (ajustável)

  // lastSeen local to avoid hammering DB when same person is in frame repeatedly
  const lastSeenRef = useRef({}); // { [employeeId]: timestamp }

  // guards
  const recognitionRunningRef = useRef(false);
  const isProcessingRef = useRef(false);

  // small cached matcher & map so detector isn't rebuilt each frame
  const faceMatcherRef = useRef(null);
  const idNameMapRef = useRef({});

  // If the state of login exists in localStorage, keep logged in
  useEffect(() => {
    if (storedUser) {
      // simulate retrieving user info
      setUser({ name: HARDCODED_USER.name, username: HARDCODED_USER.username });
      setRoute("dashboard");
    }
    // restore recognition preference
    const pref = localStorage.getItem('recognitionEnabled');
    if (pref === '1') setRecognitionEnabled(true);

    // load initial data
    fetchCompanies();
    fetchRegisteredEmployees();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      if (videoRef.current && streamRef.current && recognitionEnabled) {
        prepareFaceMatcherAndStart();
      }
    } else {
      stopRecognitionLoop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRecognitionEnabled, cameraFullscreen, recognitionEnabled]);

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

  // Fetch employees for the selected company (used by register and dashboard stats)
  async function fetchEmployees(companyId) {
    if (!companyId) {
      setEmployees([]);
      return;
    }
    const { data, error } = await supabase
      .from("employees")
      .select("id, name, role, department, company_id, descriptors, created_at")
      .eq("company_id", String(companyId))
      .order("created_at", { ascending: false });
    if (error) {
      console.error("fetchEmployees", error);
      setStatusMsg("Erro carregando funcionários");
      return;
    }
    setEmployees(data || []);
  }

  // Fetch attendances with joined employee department and company name
  async function fetchAttendances(filters = {}) {
    try {
      // Build base query selecting attendance fields and joining employees and companies
      let q = supabase
        .from("attendances")
        .select("id, attended_at, confidence, employee_id, company_id, employees(id, name, department), companies(id, name)")
        .order("attended_at", { ascending: false })
        .limit(1000);

      if (filters.company_id) q = q.eq("company_id", String(filters.company_id));
      if (filters.employee_id) q = q.eq("employee_id", String(filters.employee_id));
      if (filters.gte_attended_at) q = q.gte('attended_at', filters.gte_attended_at.toISOString());

      const { data, error } = await q;
      if (error) {
        console.error("fetchAttendances", error);
        setStatusMsg("Erro carregando histórico");
      } else {
        setAttendances(data || []);
      }
    } catch (err) {
      console.error("Erro fetchAttendances", err);
      setStatusMsg("Erro carregando histórico");
    }
  }

  // Fetch registered employees (optionally filtered by selectedCompany).
  // Joins company name to each employee for display.
  async function fetchRegisteredEmployees() {
    try {
      let q = supabase
        .from("employees")
        .select("id, name, department, created_at, company_id, companies(id, name)")
        .order("created_at", { ascending: false })
        .limit(1000);

      if (selectedCompany) {
        q = q.eq("company_id", String(selectedCompany));
      }

      const { data, error } = await q;
      if (error) {
        console.error("fetchRegisteredEmployees", error);
        setStatusMsg("Erro carregando funcionários registrados");
        return;
      }
      setRegisteredEmployees(data || []);
    } catch (err) {
      console.error("fetchRegisteredEmployees", err);
    }
  }

  // NOTE: select explicit columns that might exist after schema changes.
  // We request both role and department to be tolerant.
  async function fetchAttendancesInitial() {
    await fetchAttendances({ company_id: selectedCompany });
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
      // persist login
      localStorage.setItem('usuarioLogado', 'true');
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
    localStorage.removeItem('usuarioLogado');
  }

  // -------------------- NOVAS FUNÇÕES (melhorias de estabilidade) --------------------
  async function getPreferredDeviceId(preferredFacing = "environment") {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(d => d.kind === "videoinput");
      if (!videoInputs.length) return null;
      const labelMatch = videoInputs.find(d => {
        const label = (d.label || "").toLowerCase();
        if (preferredFacing === "user") return label.includes("front") || label.includes("facing front") || label.includes("user");
        return label.includes("back") || label.includes("rear") || label.includes("environment");
      });
      if (labelMatch) return labelMatch.deviceId;
      return preferredFacing === "environment" ? videoInputs[videoInputs.length - 1].deviceId : videoInputs[0].deviceId;
    } catch (err) {
      console.warn("getPreferredDeviceId erro:", err);
      return null;
    }
  }

  function attachTrackListeners(stream) {
    if (!stream) return;
    stream.getTracks().forEach((track) => {
      if (track._hasCameraListeners) return;
      track._hasCameraListeners = true;

      track.addEventListener("ended", () => {
        console.warn("Track ended");
        setStatusMsg("Stream finalizado pelo dispositivo");
        stopRecognitionLoop();
        stopCamera();
        retryOpenCamera(2, 700);
      });

      track.addEventListener("mute", () => {
        console.warn("Track muted");
        setStatusMsg("Stream silenciado (mute)");
      });

      track.addEventListener("unmute", () => {
        console.warn("Track unmuted");
        setStatusMsg("Stream reencontrado (unmute)");
      });
    });
  }

  async function warmUpVideoFrames(frames = 6, msBetween = 80) {
    if (!videoRef.current) return;
    const v = videoRef.current;
    await new Promise((res) => {
      const check = () => {
        if (v && v.videoWidth > 0 && v.videoHeight > 0) return res();
        setTimeout(check, 80);
      };
      check();
    });

    for (let i = 0; i < frames; i++) {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, msBetween)));
    }
  }

  async function retryOpenCamera(attempts = 3, initialDelayMs = 300) {
    let attempt = 0;
    while (attempt < attempts) {
      attempt++;
      try {
        await openCamera({ skipAutoStartRecognition: false, retrying: true });
        return true;
      } catch (err) {
        console.warn(`retryOpenCamera: tentativa ${attempt} falhou`, err);
        setStatusMsg(`Tentativa de abrir câmera ${attempt} falhou`);
        const delay = initialDelayMs * attempt;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    console.error("Todas tentativas de abrir câmera falharam");
    return false;
  }

  // check permission best-effort
  async function checkCameraPermission() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) {
        return 'unknown';
      }
      try {
        const p = await navigator.permissions.query({ name: "camera" });
        // some browsers may throw; if success, return state
        return p.state;
      } catch (err) {
        return 'unknown';
      }
    } catch (err) {
      return 'unknown';
    }
  }

  // -------------------- openCamera aprimorada --------------------
  async function openCamera(opts = { skipAutoStartRecognition: false, retrying: false }) {
    if (openInProgressRef.current) {
      console.log("openCamera: já em progresso");
      return;
    }
    openInProgressRef.current = true;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatusMsg("getUserMedia não suportado neste navegador");
        throw new Error("getUserMedia não suportado");
      }

      stopRecognitionLoop();
      stopCamera();

      await checkCameraPermission();

      let constraints;
      const preferredDeviceId = await getPreferredDeviceId(facingMode);
      if (preferredDeviceId) {
        constraints = {
          video: {
            deviceId: { exact: preferredDeviceId },
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode,
          },
        };
      } else {
        constraints = {
          video: {
            facingMode,
            width: { ideal: 640 },
            height: { ideal: 480 },
          },
        };
      }

      setStatusMsg("Pedindo permissão para câmera...");
      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      if (!videoRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        setStatusMsg("Vídeo não disponível");
        throw new Error("Vídeo element não encontrado");
      }

      videoRef.current.srcObject = stream;
      streamRef.current = stream;
      attachTrackListeners(stream);

      await videoRef.current.play().catch((e) => {
        console.warn("play() falhou:", e);
      });
      setStatusMsg("Câmera aberta — aquecendo frames...");

      // wait for valid video size
      await new Promise((resolve) => {
        const checkReady = () => {
          const v = videoRef.current;
          if (v && v.videoWidth > 0 && v.videoHeight > 0) {
            resolve();
          } else {
            setTimeout(checkReady, 100);
          }
        };
        checkReady();
      });

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
      }, 350);

      await warmUpVideoFrames(6, 60);

      if (!opts.skipAutoStartRecognition && (cameraFullscreen || route === 'attendance') && autoRecognitionEnabled && recognitionEnabled) {
        if (!selectedCompany) {
          setStatusMsg("Selecione a empresa antes de abrir a câmera");
          return;
        }
        if (!faceapiLoaded) {
          setStatusMsg("Aguarde carregamento dos modelos...");
          await new Promise((r) => setTimeout(r, 500));
        }

        if (!faceapiLoaded) {
          setStatusMsg("Modelos ainda não prontos");
          return;
        }

        setTimeout(() => {
          prepareFaceMatcherAndStart().catch((e) => console.error("prepareFaceMatcherAndStart erro:", e));
        }, 250);
      }

      setStatusMsg("Câmera pronta");
      return true;
    } catch (err) {
      console.error("Erro ao abrir câmera (aprimorada):", err);
      setStatusMsg("Erro ao abrir câmera: " + (err && err.message ? err.message : String(err)));
      throw err;
    } finally {
      openInProgressRef.current = false;
    }
  }

  // -------------------- switchFacing aprimorado --------------------
  async function switchFacing() {
    if (switchInProgressRef.current) return;
    switchInProgressRef.current = true;
    try {
      setFacingMode((prev) => (prev === "user" ? "environment" : "user"));

      if (streamRef.current) {
        try {
          streamRef.current.getTracks().forEach((t) => t.stop());
        } catch (e) {
          console.error("Erro ao parar stream:", e);
        }
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
      }

      await new Promise(r => setTimeout(r, 320));
      try {
        await openCamera();
        setStatusMsg("Câmera trocada");
      } catch (err) {
        console.error("Erro ao reabrir câmera após troca", err);
        retryOpenCamera(2, 400);
      }
    } finally {
      setTimeout(() => { switchInProgressRef.current = false; }, 550);
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

  // ---------- registration capture ----------
  async function captureDescriptorFromVideo(opts = { attempts: 3, inputSize: 128, scoreThreshold: 0.45 }) {
    if (!faceapiLoaded || !faceapi) {
      setStatusMsg("Modelos não carregados ainda");
      return null;
    }
    if (!videoRef.current) {
      setStatusMsg("Vídeo não disponível");
      return null;
    }

    for (let i = 0; i < opts.attempts; i++) {
      try {
        const options = new faceapi.TinyFaceDetectorOptions({ inputSize: opts.inputSize, scoreThreshold: opts.scoreThreshold });
        const detection = await faceapi
          .detectSingleFace(videoRef.current, options)
          .withFaceLandmarks()
          .withFaceDescriptor();
        if (detection) {
          return Array.from(detection.descriptor);
        }
      } catch (err) {
        console.warn('Tentativa de captura falhou', err);
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    return null;
  }

  async function handleCaptureForRegister() {
    setStatusMsg("Capturando...");
    const desc = await captureDescriptorFromVideo({ attempts: 4, inputSize: 128, scoreThreshold: 0.45 });
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

  // Attempt several payload shapes to be tolerant to schema changes
  async function attemptInsertEmployee(payloads, isUpdate = false, updateId = null) {
    for (const payload of payloads) {
      try {
        if (isUpdate && updateId) {
          const { data, error } = await supabase.from("employees").update(payload).eq("id", updateId).select();
          if (error) {
            console.warn("update attempt error for payload:", payload, error);
            continue;
          }
          return { success: true, data };
        } else {
          const { data, error } = await supabase.from("employees").insert([payload]).select();
          if (error) {
            console.warn("insert attempt error for payload:", payload, error);
            continue;
          }
          return { success: true, data };
        }
      } catch (err) {
        console.error("insert/update exception for payload:", payload, err);
        continue;
      }
    }
    return { success: false, message: "Todas as tentativas de INSERT/UPDATE falharam" };
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
    if (capturedDescriptors.length === 0 && !editEmployeeId) {
      // If editing, allow not providing new captures (keep existing descriptors)
      alert("Capte ao menos 1 foto (ou edite sem novas capturas)");
      return;
    }

    const base = {
      company_id: String(selectedCompany),
      name: newName,
      descriptors: capturedDescriptors.length ? capturedDescriptors : undefined,
      photos: [],
      department: newDepartment || null,
    };

    // Build payload variants for tolerant insertion/update
    const payloads = [
      { ...base, department: newDepartment },
      { ...base, role: newDepartment },
      { ...base, department: newDepartment, role: newDepartment },
      { ...base, department: newDepartment || "N/D" },
    ];

    setStatusMsg(editEmployeeId ? "Atualizando funcionário..." : "Salvando funcionário...");
    const res = await attemptInsertEmployee(payloads, Boolean(editEmployeeId), editEmployeeId);
    if (!res.success) {
      console.error("saveNewEmployee: falha ao inserir/atualizar, veja erros no console");
      alert("Erro ao salvar funcionário. Ver console para detalhes.");
      setStatusMsg("Erro ao salvar funcionário");
      return;
    }

    alert(editEmployeeId ? "Funcionário atualizado" : "Funcionário salvo");
    // reset form
    setNewName("");
    setNewDepartment("");
    setCapturedDescriptors([]);
    setEditEmployeeId(null);
    // refresh lists
    fetchEmployees(selectedCompany);
    fetchRegisteredEmployees();
    setRoute("dashboard");
    setStatusMsg("Funcionário salvo");
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

    const { data: emps, error: e } = await supabase
      .from("employees")
      .select("id, name, role, department, descriptors")
      .eq("company_id", String(selectedCompany));

    if (e) {
      console.error(e);
      setStatusMsg('Erro buscando funcionários');
      return;
    }
    if (!emps?.length) {
      setStatusMsg('Nenhum funcionário cadastrado');
      return;
    }

    const normalized = emps.map((emp) => {
      let descs = emp.descriptors || [];
      if (typeof descs === "string") {
        try { descs = JSON.parse(descs); } catch (err) { console.warn("descriptors parse failed", emp.id, err); }
      }
      if (!Array.isArray(descs)) descs = [];
      return { ...emp, descriptors: descs };
    });

    setEmployees(normalized);

    const idMap = {};
    const labeled = [];
    for (const e2 of normalized) {
      idMap[String(e2.id)] = e2.name;
      const descsRaw = e2.descriptors || [];
      const descs = descsRaw
        .map((d) => {
          try {
            if (Array.isArray(d)) return new Float32Array(d);
            if (d && typeof d === "object") return new Float32Array(Object.values(d));
            return null;
          } catch (err) {
            console.warn("erro convertendo descriptor", e2.id, err);
            return null;
          }
        })
        .filter(Boolean);
      if (descs.length > 0) {
        labeled.push(new faceapi.LabeledFaceDescriptors(String(e2.id), descs));
      } else {
        console.warn("Funcionário sem descriptors ignorado no matcher:", e2.id, e2.name);
      }
    }

    if (!labeled.length) {
      setStatusMsg("Nenhum descriptor utilizável encontrado para matcher");
      return;
    }

    idNameMapRef.current = idMap;
    faceMatcherRef.current = new faceapi.FaceMatcher(labeled, MATCH_THRESHOLD);

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
      if (timestamp - lastRun < (window.innerWidth <= 540 ? DETECTION_INTERVAL_MS - 200 : DETECTION_INTERVAL_MS)) return;
      lastRun = timestamp;

      if (isProcessingRef.current) return;
      isProcessingRef.current = true;

      try {
        let inputSize = 160;
        let scoreThreshold = 0.5;
        const lastDetAt = window._lastDetectionsAt || 0;
        if (Date.now() - lastDetAt > 7000) {
          inputSize = 128;
          scoreThreshold = 0.45;
        }

        const options = new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold });
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

        window._lastDetectionsAt = Date.now();

        const matcher = faceMatcherRef.current;
        const idMap = idNameMapRef.current;

        for (const det of detections) {
          const best = matcher.findBestMatch(det.descriptor);
          const label = best.label;

          if (ctx) {
            const box = det.detection.box;
            ctx.lineWidth = 4;
            ctx.strokeStyle = '#53e427';
            ctx.strokeRect(box.x, box.y, box.width, box.height);

            const nameText = (label !== 'unknown') ? (idMap[label] || label) : 'Desconhecido';
            const fontSize = Math.max(14, Math.round((box.width || 80) / 12));
            ctx.font = `${fontSize}px Inter, Arial`;
            const padding = 8;
            const textWidth = ctx.measureText(nameText).width + padding * 2;
            const textHeight = fontSize + 8;
            ctx.fillStyle = '#53e427';
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
        if (err && err.name && (err.name === 'NotReadableError' || err.name === 'TrackStartError' || err.name === 'OverconstrainedError')) {
          console.warn("Erro relacionado à câmera detectado no loop, tentando reabrir...");
          stopRecognitionLoop();
          stopCamera();
          retryOpenCamera(1, 500);
        }
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

  // manual restart camera
  async function handleRestartCamera() {
    setStatusMsg("Reiniciando câmera...");
    stopRecognitionLoop();
    stopCamera();
    const ok = await retryOpenCamera(2, 300);
    setStatusMsg(ok ? "Câmera reiniciada" : "Falha ao reiniciar câmera");
  }

  // recognition toggle (start/stop) with persistence
  async function handleStartRecognition() {
    localStorage.setItem('recognitionEnabled', '1');
    setRecognitionEnabled(true);
    setStatusMsg("Iniciando reconhecimento...");

    if (!videoRef.current || !streamRef.current) {
      try {
        await openCamera({ skipAutoStartRecognition: true });
      } catch (e) {
        console.error("Erro abrindo camera antes de iniciar reconhecimento", e);
        setStatusMsg("Erro ao abrir câmera antes de iniciar reconhecimento");
        return;
      }
    }

    try {
      await prepareFaceMatcherAndStart();
      setStatusMsg("Reconhecimento: ON");
    } catch (err) {
      console.error("Falha ao preparar matcher", err);
      setStatusMsg("Falha ao iniciar reconhecimento");
      setRecognitionEnabled(false);
      localStorage.removeItem('recognitionEnabled');
    }
  }

  function handleStopRecognition() {
    localStorage.removeItem('recognitionEnabled');
    setRecognitionEnabled(false);
    stopRecognitionLoop();
    setStatusMsg("Reconhecimento: OFF");
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
      department: r.employees?.department || "",
      company: r.companies?.name || r.company_id,
      attended_at: r.attended_at,
      confidence: r.confidence,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Presencas");
    XLSX.writeFile(wb, "presencas.xlsx");
  }

  // ---------- helpers for history filters ----------
  function applyHistoryFilter(range) {
    const now = new Date();
    let from = null;
    if (range === 'hour') from = new Date(now.getTime() - 1000 * 60 * 60);
    if (range === 'day') from = new Date(now.getTime() - 1000 * 60 * 60 * 24);
    if (range === 'week') from = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 7);
    if (range === 'month') from = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 30);

    if (range === 'all') {
      fetchAttendances({ company_id: selectedCompany });
    } else {
      fetchAttendances({ company_id: selectedCompany, gte_attended_at: from });
    }
  }

  function handleFilterChange(e) {
    const val = e.target.value;
    applyHistoryFilter(val);
  }

  // ---------- Registered employees actions ----------
  function handleSearchChange(e) {
    const v = e.target.value;
    setSearchName(v);
  }

  // Filtered list derived from registeredEmployees + searchName
  const filteredRegisteredEmployees = registeredEmployees.filter((emp) => {
    if (!searchName) return true;
    return (emp.name || "").toLowerCase().includes(searchName.toLowerCase());
  });

  async function handleDeleteEmployee(empId) {
    const ok = confirm("Deseja realmente apagar este funcionário? Esta ação é irreversível.");
    if (!ok) return;
    try {
      const { error } = await supabase.from("employees").delete().eq("id", empId);
      if (error) {
        console.error("Erro ao apagar funcionário", error);
        alert("Erro ao apagar funcionário");
        return;
      }
      setStatusMsg("Funcionário apagado");
      fetchEmployees(selectedCompany);
      fetchRegisteredEmployees();
      fetchAttendances({ company_id: selectedCompany });
    } catch (err) {
      console.error("Erro handleDeleteEmployee", err);
      alert("Erro ao apagar funcionário");
    }
  }

  function handleEditEmployee(emp) {
    // emp has structure: { id, name, department, created_at, company_id, companies: { name } }
    setEditEmployeeId(emp.id);
    setNewName(emp.name || "");
    setNewDepartment(emp.department || "");
    setCapturedDescriptors([]); // keep empty — update will keep existing descriptors if none provided
    setSelectedCompany(emp.company_id || null);
    // navigate to register form
    setRoute("register");
    // ensure employees list and form are in sync
    fetchEmployees(emp.company_id);
  }

  function handleCancelEdit() {
    setEditEmployeeId(null);
    setNewName("");
    setNewDepartment("");
    setCapturedDescriptors([]);
  }

  // ---------- recognition indicator component ----------
  const RecognitionIndicator = () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 12, height: 12, borderRadius: 12, background: recognitionEnabled ? '#22c55e' : '#ef4444', boxShadow: recognitionEnabled ? '0 0 8px rgba(34,197,94,0.4)' : '0 0 8px rgba(239,68,68,0.3)' }} />
      <div style={{ fontSize: 13 }}>{recognitionEnabled ? 'Reconhecimento: ON' : 'Reconhecimento: OFF'}</div>
    </div>
  );

  // UI
  return (
    <div className="app-root">
      <header className="app-header">
        <div className="header-inner">
          <div className="brand">
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
                <>
                <div className="card">
                  <h2>Dashboard 💻</h2>
                  <br />
                  <div className="row gap">
                    <div className="col">
                      <label className="label">🏢 - Empresa </label>

                      <select className="select" value={selectedCompany || ""} onChange={(e) => { const v = e.target.value || null; setSelectedCompany(v); fetchEmployees(v); fetchRegisteredEmployees(); }}>
                        <option value="">-- selecione a empresa --</option>
                        {companies.map((c) => (
                          <option key={c.id} value={String(c.id)}>{c.name}</option>
                        ))}
                      </select>

                      <div style={{ marginTop: "15px", display: "flex", gap: "10px" }}>
                        <button
                          className="btn primary"
                          onClick={() => {
                            if (!selectedCompany) { alert("Selecione uma empresa antes de registrar presença"); return; }
                            setCameraFullscreen(true);
                            openCamera();
                          }}
                        >
                          Abrir Câmera
                        </button>

                        <button className="btn" onClick={() => { fetchAttendances({ company_id: selectedCompany }); setRoute("history"); }}>
                          Ver Histórico
                        </button>
                      </div>

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

{/* New container: Registered employees list */}
<div className="card">
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
    <h3 style={{ margin: 0, marginLeft: '10px'}}>👨‍💼</h3>

    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        className="input"
        placeholder="Buscar por nome..."
        value={searchName}
        onChange={handleSearchChange}
        style={{ width: 200, minWidth: 120 }}
      />

      {/* Atualizar */}
      <button
        className=""
        onClick={() => { fetchRegisteredEmployees(); fetchEmployees(selectedCompany); setStatusMsg('Lista atualizada'); }}
        title="Atualizar lista"
      >
        🔄 
      </button>
    </div>
  </div>

  <div className="table-wrap" style={{ marginTop: 12 }}>
    {/* Desktop / tablet: tabela */}
    <table className="table responsive-table">
      <thead>
        <tr>
          <th>Nome</th>
          <th>Departamento</th>
          <th>Empresa</th>
          <th>Registrado em</th>
          <th style={{ width: 120 }}>Ações</th>
        </tr>
      </thead>
      <tbody>
        {filteredRegisteredEmployees.length === 0 && (
          <tr><td colSpan={5} style={{ padding: 20 }} className="muted">Nenhum funcionário encontrado</td></tr>
        )}
        {filteredRegisteredEmployees.map((emp) => (
          <tr key={emp.id}>
            <td>{emp.name}</td>
            <td>{emp.department || "-"}</td>
            <td>{emp.companies?.name || companies.find(c => String(c.id) === String(emp.company_id))?.name || "-"}</td>
            <td>{emp.created_at ? new Date(emp.created_at).toLocaleString() : "-"}</td>
            <td>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" title="Editar" onClick={() => handleEditEmployee(emp)}>✏️</button>
                <button className="btn" title="Apagar" onClick={() => handleDeleteEmployee(emp.id)}>🗑️</button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>

    {/* Mobile: cards empilhados (visível apenas em telas pequenas via CSS) */}
    <div className="employee-cards">
      {filteredRegisteredEmployees.map((emp) => (
        <div className="employee-card" key={"card-" + emp.id}>
          <div className="employee-card-row">
            <div>
              <div style={{ fontWeight: 700 }}>{emp.name}</div>
              <div className="muted" style={{ fontSize: 13 }}>{emp.department || "-"}</div>
              <div style={{ fontSize: 13 }}>{emp.companies?.name || companies.find(c => String(c.id) === String(emp.company_id))?.name || "-"}</div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginLeft: 12 }}>
              <div style={{ fontSize: 12, color: '#666' }}>{emp.created_at ? new Date(emp.created_at).toLocaleString() : "-"}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" style={{ padding: '8px 10px' }} onClick={() => handleEditEmployee(emp)}>✏️ </button>
                <button className="btn" style={{ padding: '8px 10px' }} onClick={() => handleDeleteEmployee(emp.id)}>🗑️ </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  </div>
</div>

                </>
              )}

              {route === "register" && (
                <div className="card">
                  <h2>{editEmployeeId ? "Editar Funcionário" : "Registrar Funcionário"}</h2>
                  <br />

                  <div className="form-row">
                    <label>Empresa do Funcionário</label>
                    <select className="select" value={selectedCompany || ""} onChange={(e) => { const v = e.target.value || null; setSelectedCompany(v); fetchEmployees(v); fetchRegisteredEmployees(); }}>
                      <option value="">-- selecione a empresa --</option>
                      {companies.map((c) => (<option key={c.id} value={String(c.id)}>{c.name}</option>))}
                    </select>
                  </div>

                  <div className="form-row">
                    <label>Nome do Funcionário</label>
                    <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} />
                  </div>

                  <div className="form-row">
                    <label>Departamento do Funcionário</label>
                    <input className="input" value={newDepartment} onChange={(e) => setNewDepartment(e.target.value)} />
                  </div>

                  {/* camera preview */}
                  <div className="video-wrapper">
                    <video ref={videoRef} className="video" autoPlay muted playsInline />
                    <div className="capture-info">Capturas: {capturedDescriptors.length}</div>
                  </div>

                  <div className="form-row actions actions-centered">
                    <div className="btn-group btn-group-modern" role="toolbar" aria-label="Controles da câmera">
                      <button className="btn-ghost cam-btn" onClick={() => { switchFacing(); }} aria-label="Trocar câmera" title="Trocar Câmera">
                        <span className="icon-large">🔄</span>
                        <span className="btn-label"></span>
                      </button>

                      <button className="btn-primary cam-btn" onClick={handleCaptureForRegister} aria-label="Capturar rosto" title="Capturar Rosto">
                        <span className="icon-large">📸</span>
                        <span className="btn-label"></span>
                      </button>

                      <button className="btn-ghost cam-btn" onClick={openCamera} aria-label="Abrir câmera" title="Abrir Câmera">
                        <span className="icon-large">🎥</span>
                        <span className="btn-label"></span>
                      </button>
                    </div>
                  </div>

                  <div className="form-row" style={{ display: 'flex', gap: 8 }}>
                    <button className="btn primary" onClick={saveNewEmployee}>{editEmployeeId ? "Salvar" : "Salvar Funcionário"}</button>
                    {editEmployeeId && <button className="btn" onClick={() => { handleCancelEdit(); setRoute("dashboard"); }}>Cancelar</button>}
                  </div>
                </div>
              )}

              {route === "history" && (
                <div className="card">
                  <h2>📋 Histórico de Presenças</h2>

                  <div className="filter-row" style={{ display:'flex', alignItems:'center', gap:'8px', margin:'12px 0' }}>
                    <span style={{ fontSize:'20px' }}>🔍</span>
                    <select id="filterSelect" style={{ padding:'6px 10px', borderRadius:'6px' }} onChange={handleFilterChange}>
                      <option value="hour">Última hora</option>
                      <option value="day">Último dia</option>
                      <option value="week">Última semana</option>
                      <option value="month">Último mês</option>
                      <option value="all">Todos</option>
                    </select>
                  </div>

                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
                    <button className="btn" onClick={() => fetchAttendances({ company_id: selectedCompany })}>Atualizar</button>
                    <button className="btn primary" onClick={exportAttendancesToExcel}>Exportar</button>
                  </div>

                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr><th>Funcionário</th><th>Departamento</th><th>Empresa</th><th>Quando</th><th>Confiança</th></tr>
                      </thead>
                      <tbody>
                        {attendances.map((a) => (
                          <tr key={a.id}>
                            <td>{a.employees?.name || a.employee_id}</td>
                            <td>{a.employees?.department || "-"}</td>
                            <td>{a.companies?.name || a.company_id}</td>
                            <td>{a.attended_at ? new Date(a.attended_at).toLocaleString() : "-"}</td>
                            <td>{a.confidence != null ? Number(a.confidence).toFixed(2) : "-"}</td>
                          </tr>
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

          <button className="camera-close" aria-label="Fechar" onClick={() => { stopRecognitionLoop(); stopCamera(); setCameraFullscreen(false); }}>✖</button>

          <div style={{ position: 'absolute', top: 12, left: 12 }}>
            <RecognitionIndicator />
          </div>

          <div className="recent-matches left">
            <h4>Últimos registros</h4>
            <ul>
              {recentMatches.map((m) => (
                <li key={m.id + String(m.timestamp)}>{m.name}</li>
              ))}
            </ul>
          </div>

          <div className="camera-controls centered">
            <button className="btn-switch-camera glass" onClick={() => { switchFacing(); stopRecognitionLoop(); setTimeout(() => openCamera(), 400); }}>
              🔄
            </button>

            <button className="btn-switch-camera glass" onClick={() => { recognitionEnabled ? handleStopRecognition() : handleStartRecognition(); }} title={recognitionEnabled ? 'Parar reconhecimento' : 'Iniciar reconhecimento'} style={{ marginLeft: 10 }}>
              {recognitionEnabled ? '⏸️' : '▶️'}
            </button>

            <button className="btn-switch-camera glass" onClick={() => handleRestartCamera()} title="Reiniciar câmera" style={{ marginLeft: 10 }}>
              🎥
            </button>
          </div>
        </div>
      )}

      {user && !cameraFullscreen && (
        <div className="bottom-nav" role="navigation" aria-label="Navegação principal">
          <button className={`nav-item ${route === "dashboard" ? "active" : ""}`} onClick={() => setRoute("dashboard")}>
            <img src={casaIcon} alt="Dashboard" className="nav-icon nav-icon--dashboard" onError={(e) => { e.currentTarget.style.opacity = 0.5; }} />
          </button>

          <button className={`nav-item ${route === "register" ? "active" : ""}`} onClick={() => { setRoute("register"); fetchCompanies(); fetchRegisteredEmployees(); }}>
            <img src={funcionarioIcon} alt="Registrar" className="nav-icon nav-icon--registerr" onError={(e) => { e.currentTarget.style.opacity = 0.5; }} />
          </button>

          <button className={`nav-item ${route === "history" ? "active" : ""}`} onClick={() => { setRoute("history"); fetchAttendances({ company_id: selectedCompany }); }}>
            <img src={historicoIcon} alt="Histórico" className="nav-icon nav-icon--history" onError={(e) => { e.currentTarget.style.opacity = 0.5; }} />
          </button>
        </div>
      )}

      {/* Status bar removed — não renderizamos mais statusMsg aqui */}
    </div>
  );
}
