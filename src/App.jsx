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

// CONFIG
const DEDUP_MS = 5 * 60 * 1000; // 5 minutos
const DETECTION_INTERVAL_MS = 700;
const MATCH_THRESHOLD = 0.55;
const STREAM_STUCK_THRESHOLD_MS = 2500; // se sem frames por > X, tentar reiniciar

export default function App() {
  // auth / user
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  // login form
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // routes / view
  const [route, setRoute] = useState("login"); // login, dashboard, register, history, attendance
  const [statusMsg, setStatusMsg] = useState("");

  // face-api state
  const [faceapi, setFaceapi] = useState(null);
  const [faceapiLoaded, setFaceapiLoaded] = useState(false);
  const [loadingModels, setLoadingModels] = useState(true);

  // entities
  const [companies, setCompanies] = useState([]);
  const [employees, setEmployees] = useState([]); // basic employee list (without descriptors)
  const [selectedCompany, setSelectedCompany] = useState(null);

  // camera / recognition
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const recognitionRaf = useRef(null);
  const recognitionRunningRef = useRef(false);
  const isProcessingRef = useRef(false);
  const [facingMode, setFacingMode] = useState("environment");
  const [cameraFullscreen, setCameraFullscreen] = useState(false);
  const [autoRecognitionEnabled, setAutoRecognitionEnabled] = useState(true);
  const [recentMatches, setRecentMatches] = useState([]);
  const [showOverlay, setShowOverlay] = useState(true);

  // new: manual recognition toggle
  const [recognitionEnabled, setRecognitionEnabled] = useState(false);

  // permission state
  const [cameraPermission, setCameraPermission] = useState("unknown"); // 'granted','denied','prompt','unknown'

  // stream health
  const lastFrameAtRef = useRef(Date.now());

  // registration
  const [newName, setNewName] = useState("");
  const [newDepartment, setNewDepartment] = useState("");
  const [capturedDescriptors, setCapturedDescriptors] = useState([]);

  // attendances
  const [attendances, setAttendances] = useState([]);

  // matching helpers
  const faceMatcherRef = useRef(null);
  const idNameMapRef = useRef({});
  const lastSeenRef = useRef({}); // local dedup map: {employeeId: timestamp}
  const localAttendanceCache = useRef({}); // cache last attendance timestamp per employeeId

  // device rotation helpers
  const videoInputIdsRef = useRef([]); // array of deviceIds
  const currentDeviceIndexRef = useRef(-1);
  const switchingDeviceRef = useRef(false);

  // ------------------ auth handling ------------------
  useEffect(() => {
    let mounted = true;
    async function initAuth() {
      setAuthLoading(true);
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!mounted) return;
      if (session && session.user) {
        setUser(session.user);
        setRoute("dashboard");
      } else {
        setUser(null);
        setRoute("login");
      }
      setAuthLoading(false);
    }
    initAuth();

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      if (session && session.user) {
        setUser(session.user);
        setRoute("dashboard");
      } else {
        setUser(null);
        setRoute("login");
      }
    });

    return () => {
      mounted = false;
      listener?.subscription?.unsubscribe?.();
      stopRecognitionLoop();
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSignIn(e) {
    e?.preventDefault?.();
    setStatusMsg("Autenticando...");
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        console.error("signIn error", error);
        alert("Erro ao autenticar: " + error.message);
        setStatusMsg("");
        return;
      }
      if (data?.user) {
        setUser(data.user);
        setRoute("dashboard");
        setEmail("");
        setPassword("");
        setStatusMsg("Autenticado");
      } else {
        setStatusMsg("");
      }
    } catch (err) {
      console.error(err);
      alert("Erro inesperado ao autenticar");
      setStatusMsg("");
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    setUser(null);
    setRoute("login");
    setStatusMsg("");
    stopRecognitionLoop();
    stopCamera();
  }

  // ------------------ load face-api dynamically + models ------------------
  useEffect(() => {
    let mounted = true;
    async function loadFaceApiAndModels() {
      try {
        const f = await import("face-api.js");
        if (!mounted) return;
        setFaceapi(f);
        setLoadingModels(true);
        const MODEL_URL = "/models";
        await f.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await f.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        await f.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
        setFaceapiLoaded(true);
        setLoadingModels(false);
        setStatusMsg("Modelos prontos");
      } catch (err) {
        console.error("Erro carregando face-api", err);
        setStatusMsg("Erro carregando modelos");
        setLoadingModels(false);
      }
    }
    loadFaceApiAndModels();
    fetchCompanies();
    refreshVideoInputs();

    // device change listener (hot-plug cameras)
    function onDeviceChange() {
      console.log("devicechange detected");
      setStatusMsg("Mudança de dispositivos detectada, verificando câmera...");
      refreshVideoInputs();
      if (streamRef.current) {
        retryOpenCamera(2, 400);
      }
    }
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    } else if (navigator.mediaDevices && navigator.mediaDevices.ondevicechange !== undefined) {
      navigator.mediaDevices.ondevicechange = onDeviceChange;
    }

    return () => {
      mounted = false;
      stopRecognitionLoop();
      stopCamera();
      if (navigator.mediaDevices && navigator.mediaDevices.removeEventListener) {
        navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
      } else if (navigator.mediaDevices && navigator.mediaDevices.ondevicechange !== undefined) {
        navigator.mediaDevices.ondevicechange = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // re-open camera when switching facingMode or opening camera routes
  useEffect(() => {
    if (!videoRef.current) return;
    if (route === "register" || cameraFullscreen || route === "attendance") {
      const t = setTimeout(() => openCamera().catch(() => {}), 300);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facingMode, route, cameraFullscreen]);

  // ------------------ Supabase helpers (safe defaults) ------------------
  async function fetchCompanies() {
    const { data, error } = await supabase.from("companies").select("*").order("name");
    if (error) {
      console.error("fetchCompanies", error);
      setStatusMsg("Erro carregando empresas");
      return;
    }
    setCompanies(data || []);
  }

  // fetch basic employees WITHOUT descriptors (for UI lists)
  async function fetchEmployees(companyId) {
    if (!companyId) {
      setEmployees([]);
      return;
    }
    const { data, error } = await supabase
      .from("employees")
      .select("id, name, department, company_id")
      .eq("company_id", String(companyId))
      .order("name");
    if (error) {
      console.error("fetchEmployees", error);
      setStatusMsg("Erro carregando funcionários");
      return;
    }
    setEmployees(data || []);
  }

  // Fetch attendances with optional filters; include employee (name, department) and company (name)
  async function fetchAttendances(filters = {}) {
    try {
      let q = supabase
        .from("attendances")
        // request joined fields: employees (name, department), companies (name)
        .select("id,attended_at,confidence, employee_id, company_id, employees(name,department), companies(name)")
        .order("attended_at", { ascending: false })
        .limit(1000);
      if (filters.company_id) q = q.eq("company_id", String(filters.company_id));
      if (filters.employee_id) q = q.eq("employee_id", String(filters.employee_id));
      if (filters.gte_attended_at) q = q.gte('attended_at', filters.gte_attended_at.toISOString());
      const { data, error } = await q;
      if (error) {
        console.error("fetchAttendances error", error);
      } else {
        // normalize for UI
        const normalized = (data || []).map((r) => ({
          id: r.id,
          employee_id: r.employee_id,
          employee_name: r.employees?.name || null,
          department: r.employees?.department || null,
          company_name: r.companies?.name || null,
          attended_at: r.attended_at,
          confidence: r.confidence,
        }));
        setAttendances(normalized);
      }
    } catch (err) {
      console.error("Erro fetchAttendances", err);
    }
  }

  // Fetch descriptors securely for the selected company (this will be protected by RLS policies)
  async function fetchEmployeeDescriptors(companyId) {
    if (!companyId) return [];
    // We request only id, name, descriptors
    const { data, error } = await supabase
      .from("employees")
      .select("id, name, descriptors")
      .eq("company_id", String(companyId));
    if (error) {
      console.error("fetchEmployeeDescriptors", error);
      setStatusMsg("Erro ao buscar descriptors");
      return [];
    }
    return data || [];
  }

  // ------------------ Camera helpers ------------------
  async function refreshVideoInputs() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter((d) => d.kind === "videoinput");
      videoInputIdsRef.current = videoInputs.map((d) => ({ id: d.deviceId, label: d.label }));
      // try to set current index to match facingMode heuristics
      if (videoInputIdsRef.current.length) {
        // find best index if currentDeviceIndexRef not set
        const idx = videoInputIdsRef.current.findIndex((v) =>
          (facingMode === "user" ? /front|facing front|user/i : /back|rear|environment/i).test(v.label)
        );
        currentDeviceIndexRef.current = idx >= 0 ? idx : 0;
      } else {
        currentDeviceIndexRef.current = -1;
      }
    } catch (err) {
      console.warn("refreshVideoInputs erro", err);
      videoInputIdsRef.current = [];
      currentDeviceIndexRef.current = -1;
    }
  }

  async function getPreferredDeviceId(preferredFacing = "environment") {
    // prefer device selected in videoInputIdsRef if available
    await refreshVideoInputs();
    const arr = videoInputIdsRef.current || [];
    if (!arr.length) return null;
    const idx = currentDeviceIndexRef.current >= 0 ? currentDeviceIndexRef.current : (preferredFacing === "environment" ? arr.length - 1 : 0);
    return arr[idx]?.id || null;
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

  // Called inside RAF loop when a frame is painted
  function markFrameSeen() {
    lastFrameAtRef.current = Date.now();
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

  // Try to detect permission status (best-effort)
  async function checkCameraPermission() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) {
        setCameraPermission("unknown");
        return;
      }
      const p = await navigator.permissions.query({ name: "camera" });
      if (p && p.state) {
        setCameraPermission(p.state); // 'granted' | 'prompt' | 'denied'
        p.onchange = () => setCameraPermission(p.state);
      } else {
        setCameraPermission("unknown");
      }
    } catch (err) {
      setCameraPermission("unknown");
    }
  }

  // openCamera enhanced
  async function openCamera(opts = { skipAutoStartRecognition: false, retrying: false }) {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatusMsg("getUserMedia não suportado neste navegador");
        throw new Error("getUserMedia não suportado");
      }

      stopRecognitionLoop();
      stopCamera();

      // check permission best-effort
      checkCameraPermission();
      await refreshVideoInputs();

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

      // update frame monitor
      lastFrameAtRef.current = Date.now();

      // when video plays, mark frames
      const onPlay = () => {
        markFrameSeen();
      };
      videoRef.current.addEventListener("playing", onPlay, { once: true });

      await videoRef.current.play().catch((e) => {
        console.warn("play() falhou:", e);
      });
      setStatusMsg("Câmera aberta");

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

      // Adjust canvas to video size & respect ratio
      setTimeout(() => {
        const canvas = canvasRef.current;
        const v = videoRef.current;
        if (canvas && v) {
          const ratio = window.devicePixelRatio || 1;
          canvas.width = (v.videoWidth || v.clientWidth) * ratio;
          canvas.height = (v.videoHeight || v.clientHeight) * ratio;
          const rect = v.getBoundingClientRect();
          canvas.style.width = `${rect.width}px`;
          canvas.style.height = `${rect.height}px`;
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        }
      }, 350);

      await warmUpVideoFrames(6, 60);

      // monitor stream health periodically
      startStreamHealthMonitor();

      // set currentDeviceIndexRef to index of the device we opened (if found)
      if (stream && stream.getVideoTracks && videoInputIdsRef.current.length) {
        const label = stream.getVideoTracks()[0]?.label || "";
        const idx = videoInputIdsRef.current.findIndex(v => (v.label || "") === label);
        if (idx >= 0) currentDeviceIndexRef.current = idx;
      }

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

      return true;
    } catch (err) {
      console.error("Erro ao abrir câmera (aprimorada):", err);
      setStatusMsg("Erro ao abrir câmera: " + (err && err.message ? err.message : String(err)));
      throw err;
    }
  }

  // cycle to next available video device in videoInputIdsRef
  async function switchFacing() {
    if (switchingDeviceRef.current) {
      // ignore rapid clicks
      setStatusMsg("Aguardando troca de câmera...");
      return;
    }
    switchingDeviceRef.current = true;
    try {
      await refreshVideoInputs();
      const arr = videoInputIdsRef.current || [];
      if (!arr.length) {
        setStatusMsg("Nenhuma câmera disponível para alternar");
        switchingDeviceRef.current = false;
        return;
      }
      // compute next index
      let next = (currentDeviceIndexRef.current + 1) % arr.length;
      if (next < 0) next = 0;
      currentDeviceIndexRef.current = next;
      const nextId = arr[next].id;

      // stop and open with exact deviceId
      stopRecognitionLoop();
      stopCamera();

      // set facingMode heuristic for future calls
      setFacingMode((prev) => (prev === "user" ? "environment" : "user"));

      setStatusMsg("Trocando câmera...");
      // open camera using exact deviceId constraint
      try {
        const constraints = {
          video: {
            deviceId: { exact: nextId },
            width: { ideal: 640 },
            height: { ideal: 480 },
          },
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          streamRef.current = stream;
          attachTrackListeners(stream);
          await videoRef.current.play().catch(() => {});
          setStatusMsg("Câmera trocada");
          // update lastFrameAt and warmup
          lastFrameAtRef.current = Date.now();
          await warmUpVideoFrames(4, 60);
        } else {
          stream.getTracks().forEach(t => t.stop());
          setStatusMsg("Vídeo não encontrado para trocar câmera");
        }
      } catch (err) {
        console.error("Erro ao abrir deviceId específico:", err);
        // fallback: try openCamera generic
        await retryOpenCamera(1, 300);
      }
    } finally {
      switchingDeviceRef.current = false;
    }
  }

  function stopCamera() {
    stopStreamHealthMonitor();
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

  // ------------------ Registration capture ------------------
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

    const payload = {
      company_id: String(selectedCompany),
      name: newName,
      department: newDepartment,
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
      setNewDepartment("");
      setCapturedDescriptors([]);
      fetchEmployees(selectedCompany);
      setRoute("dashboard");
    } catch (err) {
      console.error("Erro saveNewEmployee", err);
      alert("Erro inesperado ao salvar funcionário");
    }
  }

  // ------------------ Recognition setup and RAF loop ------------------
  async function prepareFaceMatcherAndStart() {
    if (!selectedCompany) {
      setStatusMsg('Selecione uma empresa');
      return;
    }
    if (!faceapiLoaded || !faceapi) {
      setStatusMsg('Modelos não carregados');
      return;
    }
    if (!recognitionEnabled) {
      setStatusMsg('Reconhecimento desligado (pressione Iniciar)');
      return;
    }

    // fetch employees basic list (for name mapping)
    await fetchEmployees(selectedCompany);

    // fetch descriptors securely (this SELECT must be permitted via RLS to the logged user)
    const empsWithDescriptors = await fetchEmployeeDescriptors(selectedCompany);
    if (!empsWithDescriptors || !empsWithDescriptors.length) {
      setStatusMsg('Nenhum funcionário cadastrado com descriptors');
      return;
    }

    // build matcher
    const idMap = {};
    const labeled = empsWithDescriptors.map((e2) => {
      idMap[String(e2.id)] = e2.name;
      const descs = (e2.descriptors || []).map((d) => new Float32Array(d));
      return new faceapi.LabeledFaceDescriptors(String(e2.id), descs);
    });

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
      if (!recognitionEnabled) return;
      if (!videoRef.current || videoRef.current.paused || videoRef.current.ended) return;
      // throttle adaptive for mobile
      if (timestamp - lastRun < (window.innerWidth <= 540 ? DETECTION_INTERVAL_MS - 200 : DETECTION_INTERVAL_MS)) return;
      lastRun = timestamp;

      // mark that we saw a frame
      markFrameSeen();

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
            const now = Date.now();
            const lastSeen = lastSeenRef.current[matchedEmployeeId];

            // local dedup check first
            if (lastSeen && now - lastSeen < DEDUP_MS) {
              setRecentMatches((prev) => [{ id: matchedEmployeeId, name: idMap[matchedEmployeeId] || matchedEmployeeId, timestamp: now }, ...prev].slice(0, 6));
              continue;
            }

            // check local attendance cache (avoid DB read)
            const cachedTs = localAttendanceCache.current[matchedEmployeeId];
            const fiveMinutesAgo = Date.now() - DEDUP_MS;
            if (cachedTs && cachedTs > fiveMinutesAgo) {
              lastSeenRef.current[matchedEmployeeId] = now;
              setRecentMatches((prev) => [{ id: matchedEmployeeId, name: idMap[matchedEmployeeId] || matchedEmployeeId, timestamp: now }, ...prev].slice(0, 6));
              setStatusMsg(`⚠️ ${idMap[matchedEmployeeId] || matchedEmployeeId} já registrado recentemente (cache)`);
              continue;
            }

            // insert attendance (fire-and-forget) and update caches immediately
            const attendancePayload = { company_id: String(selectedCompany), employee_id: matchedEmployeeId, confidence: best.distance };
            supabase.from("attendances").insert([attendancePayload]).then(({error}) => {
              if (error) {
                console.error("Erro inserindo attendance", error);
                setStatusMsg("Erro ao salvar presença");
              } else {
                setStatusMsg(`✅ Presença registrada: ${idMap[matchedEmployeeId] || matchedEmployeeId}`);
              }
            }).catch((e) => {
              console.error("insert catch", e);
              setStatusMsg("Erro ao salvar presença");
            });

            lastSeenRef.current[matchedEmployeeId] = now;
            localAttendanceCache.current[matchedEmployeeId] = Date.now();
            setRecentMatches((prev) => [{ id: matchedEmployeeId, name: idMap[matchedEmployeeId] || matchedEmployeeId, timestamp: now }, ...prev].slice(0, 6));
            // update history UI in background
            fetchAttendances({ company_id: selectedCompany });
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

  // ------------------ stream health monitor ------------------
  const streamHealthInterval = useRef(null);
  function startStreamHealthMonitor() {
    stopStreamHealthMonitor();
    streamHealthInterval.current = setInterval(() => {
      // if we have a stream but didn't see any frames in threshold -> try to reopen
      if (streamRef.current) {
        const last = lastFrameAtRef.current || 0;
        if (Date.now() - last > STREAM_STUCK_THRESHOLD_MS) {
          console.warn("Stream parece travado (sem frames). Tentando reiniciar câmera...");
          setStatusMsg("Stream travado — reiniciando câmera...");
          stopRecognitionLoop();
          stopCamera();
          retryOpenCamera(2, 400).then((ok) => {
            if (ok) setStatusMsg("Câmera reiniciada automaticamente");
            else setStatusMsg("Falha ao reiniciar câmera automaticamente");
          });
        }
      }
    }, 1200);
  }
  function stopStreamHealthMonitor() {
    if (streamHealthInterval.current) {
      clearInterval(streamHealthInterval.current);
      streamHealthInterval.current = null;
    }
  }

  // ------------------ external controls: start/stop recognition ------------------
  async function handleStartRecognition() {
    if (!videoRef.current || !streamRef.current) {
      try {
        await openCamera({ skipAutoStartRecognition: true });
      } catch (e) {
        console.error("Erro abrindo camera antes de iniciar reconhecimento", e);
        return;
      }
    }

    setRecognitionEnabled(true);
    setStatusMsg("Tentando iniciar reconhecimento...");
    // prepare matcher and then start
    try {
      await prepareFaceMatcherAndStart();
      setStatusMsg("Reconhecimento: ON");
    } catch (e) {
      console.error("Erro ao preparar matcher", e);
      setStatusMsg("Falha ao iniciar reconhecimento");
    }
  }

  function handleStopRecognition() {
    setRecognitionEnabled(false);
    stopRecognitionLoop();
    setStatusMsg("Reconhecimento: OFF");
  }

  // manual restart camera
  async function handleRestartCamera() {
    setStatusMsg("Reiniciando câmera...");
    stopRecognitionLoop();
    stopCamera();
    const ok = await retryOpenCamera(2, 300);
    if (ok) setStatusMsg("Câmera reiniciada");
    else setStatusMsg("Falha ao reiniciar câmera");
  }

  // ------------------ export XLSX ------------------
  function exportAttendancesToExcel() {
    if (!attendances || attendances.length === 0) {
      alert("Sem registros");
      return;
    }
    const rows = attendances.map((r) => ({
      id: r.id,
      employee: r.employee_name || r.employee_id,
      department: r.department,
      company: r.company_name,
      attended_at: r.attended_at,
      confidence: r.confidence,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Presencas");
    XLSX.writeFile(wb, "presencas.xlsx");
  }

  // ------------------ history filters helpers ------------------
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

  // ------------------ UI ------------------
  if (authLoading) {
    return <div className="app-root"><div className="center-card card"><h3>Inicializando...</h3></div></div>;
  }

  // small helper for indicator
  const RecognitionIndicator = () => (
    <div>
      
      
    </div>
  );

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
                <div style={{ marginRight: 12 }}><RecognitionIndicator /></div>
                <div className="user-pill">{user.email || user.user_metadata?.full_name || user.id}</div>
                <button className="btn" onClick={handleSignOut}>Sair</button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="app-main">
        {!user ? (
          <div className="card center-card">
            <h2>Login</h2>
            <form onSubmit={handleSignIn} style={{ width: "100%" }}>
              <div className="form-row">
                <label className="label">E-mail</label>
                <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="form-row">
                <label className="label">Senha</label>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
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
                  <h2>Dashboard 💻</h2>
                  <div className="row gap">
                    <div className="col">
                      <label className="label">🏢 - Empresa </label>
                      <select className="select" value={selectedCompany || ""} onChange={(e) => { const v = e.target.value || null; setSelectedCompany(v); fetchEmployees(v); }}>
                        <option value="">-- selecione a empresa --</option>
                        {companies.map((c) => (
                          <option key={c.id} value={String(c.id)}>{c.name}</option>
                        ))}
                      </select>

                      <div style={{ marginTop: "15px", display: "flex", gap: "10px" }}>
                        <button
                          className="btn primary"
                          onClick={() => {
                            if (!selectedCompany) {
                              alert("Selecione uma empresa antes de registrar presença");
                              return;
                            }
                            setCameraFullscreen(true);
                            openCamera();
                          }}
                        >
                          Abrir Câmera
                        </button>

                        <button
                          className="btn"
                          onClick={() => {
                            fetchAttendances({ company_id: selectedCompany });
                            setRoute("history");
                          }}
                        >
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
              )}

              {route === "register" && (
                <div className="card">
                  <h2>✚ Registrar Funcionário</h2>
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
                    <label>Departamento</label>
                    <input className="input" value={newDepartment} onChange={(e) => setNewDepartment(e.target.value)} />
                  </div>

                  <div className="video-wrapper">
                    <video ref={videoRef} className="video" autoPlay muted playsInline />
                    <div className="capture-info">Capturas: {capturedDescriptors.length}</div>
                  </div>

                  <div className="form-row actions actions-centered">
                    <div className="btn-group btn-group-modern" role="toolbar" aria-label="Controles da câmera">
                      <button className="btn-ghost cam-btn" onClick={() => openCamera()} aria-label="Abrir câmera" title="Abrir Câmera">
                        <span className="icon-large">🔍</span>
                        <span className="btn-label">Abrir</span>
                      </button>

                      <button className="btn-ghost cam-btn" onClick={() => switchFacing()} aria-label="Trocar câmera" title="Trocar Câmera">
                        <span className="icon-large">🔁</span>
                        <span className="btn-label">Trocar</span>
                      </button>

                      <button className="btn-primary cam-btn" onClick={handleCaptureForRegister} aria-label="Capturar rosto" title="Capturar Rosto">
                        <span className="icon-large">📸</span>
                        <span className="btn-label">Capturar</span>
                      </button>
                    </div>
                  </div>

                  <div className="form-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button className="btn primary" onClick={saveNewEmployee}>Salvar Funcionário</button>
                    <button
                      className="btn"
                      onClick={() => {
                        // use explicit handlers so indicator and state stay consistent
                        recognitionEnabled ? handleStopRecognition() : handleStartRecognition();
                        setTimeout(() => { /* nothing else */ }, 200);
                      }}
                    >
                      {recognitionEnabled ? 'Parar Reconhecimento' : 'Iniciar Reconhecimento'}
                    </button>
                    <div style={{ marginLeft: 'auto' }}>{cameraPermission !== 'unknown' ? `Permissão câmera: ${cameraPermission}` : ''}</div>
                  </div>
                </div>
              )}

              {route === "history" && (
                <div className="card">
                  <h2>📋 Histórico</h2>
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
                    <button className="btn" onClick={() => { fetchAttendances({ company_id: selectedCompany }); setStatusMsg("Histórico atualizado"); }}>Atualizar</button>
                    <button className="btn primary" onClick={exportAttendancesToExcel}>Exportar XLSX</button>
                  </div>

                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>ID</th>
                          <th>Funcionário</th>
                          <th>Departamento</th>
                          <th>Empresa</th>
                          <th>Quando</th>
                          <th>Confiança</th>
                        </tr>
                      </thead>
                      <tbody>
                        {attendances.map((a) => (
                          <tr key={a.id}>
                            <td>{String(a.id).slice(0,6)}</td>
                            <td>{a.employee_name || a.employee_id}</td>
                            <td>{a.department || '-'}</td>
                            <td>{a.company_name || '-'}</td>
                            <td>{new Date(a.attended_at).toLocaleString()}</td>
                            <td>{a.confidence != null ? Number(a.confidence).toFixed(2) : '-'}</td>
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

      {user && cameraFullscreen && (
        <div className="camera-fullscreen">
          <video ref={videoRef} className="video-fullscreen" autoPlay muted playsInline />
          <canvas ref={canvasRef} className="overlay-canvas" style={{ display: showOverlay ? 'block' : 'none' }} />

          <button className="camera-close" aria-label="Fechar" onClick={() => { stopRecognitionLoop(); stopCamera(); setCameraFullscreen(false); }}>✖</button>

          <div style={{ position: 'absolute', top: 12, left: 12 }}>
            <RecognitionIndicator />
          </div>

          <div className="recent-matches left" style={{ top: 48 }}>
            <h4>Últimos registros</h4>
            <ul>
              {recentMatches.map((m) => (
                <li key={m.id + String(m.timestamp)}>{m.name}</li>
              ))}
            </ul>
          </div>

          <div className="camera-controls centered" style={{ bottom: 20 }}>
            <button
              className="btn-switch-camera glass"
              onClick={() => switchFacing()}
              title="Trocar câmera"
            >
              🔁
            </button>

            <button
              className="btn-switch-camera glass"
              onClick={() => { recognitionEnabled ? handleStopRecognition() : handleStartRecognition(); }}
              title={recognitionEnabled ? "Parar reconhecimento" : "Iniciar reconhecimento"}
              style={{ marginLeft: 10 }}
            >
              {recognitionEnabled ? '⏸️' : '▶️'}
            </button>

            <button
              className="btn-switch-camera glass"
              onClick={() => handleRestartCamera()}
              title="Reiniciar câmera"
              style={{ marginLeft: 10 }}
            >
              🔄
            </button>
          </div>
        </div>
      )}

      {user && !cameraFullscreen && (
        <div className="bottom-nav" role="navigation" aria-label="Navegação principal">
          <button className={`nav-item ${route === "dashboard" ? "active" : ""}`} onClick={() => setRoute("dashboard")}>
            <img src={casaIcon} alt="Dashboard" className="nav-icon nav-icon--dashboard" onError={(e) => { e.currentTarget.style.opacity = 0.5; }} />
          </button>

          <button className={`nav-item ${route === "register" ? "active" : ""}`} onClick={() => { setRoute("register"); fetchCompanies(); }}>
            <img src={funcionarioIcon} alt="Registrar" className="nav-icon nav-icon--registerr" onError={(e) => { e.currentTarget.style.opacity = 0.5; }} />
          </button>

          <button className={`nav-item ${route === "history" ? "active" : ""}`} onClick={() => { setRoute("history"); fetchAttendances({ company_id: selectedCompany }); }}>
            <img src={historicoIcon} alt="Histórico" className="nav-icon nav-icon--history" onError={(e) => { e.currentTarget.style.opacity = 0.5; }} />
          </button>
        </div>
      )}

      <div className="status-bar">{statusMsg}</div>
    </div>
  );
}
