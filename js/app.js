(function () {
  "use strict";

  /* ============================================================
     CONFIG
     ============================================================ */
  const CONFIG = {
    wsPort: 81,
    wsPath: "/ws",
    streamPath: "/stream",
    capturePath: "/capture",
    quality: "800x600|20",
    brakeMode: "reverse",
    steerDeadzone: 8,
    steerMaxDeg: 90,
    cmdInterval: 160,
    autoReconnect: true,
    reconnectDelay: 2500
  };

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ============================================================
     STATE
     ============================================================ */
  const state = {
    ws: null,
    wsConnected: false,
    wsIntentionalClose: false,
    reconnectAttempts: 0,
    telemetry: {},
    config: {},
    speed: 0,
    gear: "P",
    currentCmd: "none",
    throttleHold: null,
    brakeHold: null,
    steerAngle: 0,
    steerSending: false,
    recording: false,
    recChunks: [],
    recTimer: null,
    recSeconds: 0,
    mediaRecorder: null,
    recStream: null,
    latencyRtt: null,
    indicators: { left: false, right: false, hazard: false, ohl: false, ohr: false },
    autoCancelInd: false,
    indicatorTimer: null,
    indicatorPhase: 0,
    indicatorDrag: false,
    indicatorMomentary: null,
    latchedDir: null,
    fullscreen: false
  };

  const toggles = {
    headlights: false, highbeam: false, parkinglights: false,
    foglights: false, interiorlight: false, brakeLight: false, reverseLight: false
  };

  /* ============================================================
     COMMS
     ============================================================ */
  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let port = CONFIG.wsPort;
    if (!port) {
      port = location.port || (proto === "wss" ? "443" : "80");
    }
    return proto + "://" + location.hostname + ":" + port + CONFIG.wsPath;
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(obj));
    }
  }

  function sendCommand(cmd, meta) {
    const msg = Object.assign({ command: cmd }, meta || {});
    send(msg);
    state.currentCmd = cmd;
    const el = $("telCurrentCmd");
    if (el) el.textContent = cmd.toUpperCase();
  }

  function connect() {
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
    state.wsIntentionalClose = false;
    const url = wsUrl();
    $("wsUrl").textContent = url.replace("ws://", "http://").replace("wss://", "https://");
    setConnState("reco", "CONNECTING");
    try {
      state.ws = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    state.ws.onopen = () => {
      state.wsConnected = true;
      state.reconnectAttempts = 0;
      setConnState("on", "CONNECTED");
      send({ type: "hello", app: "aurora", version: "1.0.0" });
      send({ type: "quality", value: CONFIG.quality });
      applyConfigToUI();
      updateStatusFromTelemetry({});
    };
    state.ws.onmessage = (ev) => handleMessage(ev.data);
    state.ws.onclose = () => {
      state.wsConnected = false;
      setConnState("off", "OFFLINE");
      updateStatusFromTelemetry({});
      if (!state.wsIntentionalClose && CONFIG.autoReconnect) scheduleReconnect();
    };
    state.ws.onerror = () => {
      try { state.ws.close(); } catch (e) {}
    };
  }

  function scheduleReconnect() {
    if (!CONFIG.autoReconnect || state.wsIntentionalClose) return;
    state.reconnectAttempts++;
    setConnState("reco", "RECONNECT " + state.reconnectAttempts);
    setTimeout(connect, CONFIG.reconnectDelay);
  }

  function disconnect() {
    state.wsIntentionalClose = true;
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
    setConnState("off", "OFFLINE");
  }

  function setConnState(kind, label) {
    const el = $("connState");
    el.className = "conn-state " + kind;
    el.textContent = label;
  }

  /* ============================================================
     MESSAGE HANDLING + TELEMETRY
     ============================================================ */
  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "pong" || msg.pong) {
      const now = performance.now();
      if (msg.t) {
        state.latencyRtt = Math.round(now - msg.t);
        state.telemetry.latency = state.telemetry.latency
          ? Math.round(lerp(state.telemetry.latency, state.latencyRtt, 0.25))
          : state.latencyRtt;
      }
      $("connLatency").textContent = "PING " + (state.latencyRtt === null ? "—" : state.latencyRtt + " ms");
    }
    if (msg.type === "config" || msg.config) {
      const c = msg.config || msg;
      state.config = Object.assign(state.config, c);
      if (c.brake_mode) CONFIG.brakeMode = c.brake_mode;
      if (c.quality) CONFIG.quality = c.quality;
      applyConfigToUI();
    }
    if (msg.type === "telemetry" || msg.telemetry || msg.type === "state") {
      applyTelemetry(msg.telemetry || msg);
    }
    if (msg.type === "ack" || msg.ack) {
      updateStatusLed("motors", !!msg.ack);
    }
  }

  function applyTelemetry(t) {
    const st = state.telemetry;
    assign(st, "battery", t, "battery_pct", "battery", "batt");
    assign(st, "voltage", t, "voltage", "volts", "batt_voltage", "battery_voltage");
    assign(st, "uptime", t, "uptime", "uptime_s");
    assign(st, "motor", t, "motor_state", "motor");
    assign(st, "cpu_temp", t, "cpu_temp", "temperature", "temp");
    assign(st, "rssi", t, "rssi", "wifi_rssi", "wifi");
    assign(st, "latency", t, "latency", "ping", "rtt");
    assign(st, "pkt_loss", t, "pkt_loss", "packet_loss", "ploss");
    assign(st, "fps", t, "fps", "frame_rate", "frames");
    assign(st, "cmd_resp", t, "cmd_resp", "cmd_response", "resp_time");
    assign(st, "firmware", t, "firmware", "fw", "firmware_version");
    assign(st, "gear", t, "gear");
    assign(st, "speed", t, "speed", "spd");
    assign(st, "current_cmd", t, "current_cmd", "cmd");
    if (t.warnings) st.warnings = t.warnings;

    if (st.gear !== undefined && st.gear !== state.gear) selectGear(String(st.gear), true);

    updateTelemetryUI();
    updateWarnings();
    updateStatusFromTelemetry({});
    updateGauges();
  }

  function assign(target, key, src, ...pickKeys) {
    const v = pick(src, ...pickKeys);
    if (v !== undefined && v !== null) target[key] = v;
  }

  function pick(obj, ...keys) {
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    return undefined;
  }

  function updateTelemetryUI() {
    const t = state.telemetry;
    if (!$("telBattery")) return;
    const batt = t.battery;
    $("telBattery").textContent = batt !== undefined ? Math.round(batt) + "%" : "—";
    $("telVoltage").textContent = t.voltage !== undefined ? Number(t.voltage).toFixed(2) + " V" : "—";
    $("telUptime").textContent = t.uptime !== undefined ? fmtUptime(t.uptime) : "—";
    $("telMotor").textContent = t.motor !== undefined ? String(t.motor).toUpperCase() : (state.throttleHold || state.brakeHold ? "ACTIVE" : "IDLE");
    $("telCpuTemp").textContent = t.cpu_temp !== undefined ? t.cpu_temp + " °C" : "—";
    $("telRssi").textContent = t.rssi !== undefined ? t.rssi + " dBm" : "—";
    $("telLatency").textContent = t.latency !== undefined ? t.latency + " ms" : "—";
    $("telPktLoss").textContent = t.pkt_loss !== undefined ? t.pkt_loss + "%" : "—";
    $("telFps").textContent = t.fps !== undefined ? t.fps : "—";
    $("telCmdResp").textContent = t.cmd_resp !== undefined ? t.cmd_resp + " ms" : "—";
    $("telFirmware").textContent = t.firmware !== undefined ? t.firmware : "—";
    updateBatteryUI(batt, t.voltage);
    updateWifiUI(t.rssi, t.latency !== undefined ? t.latency : state.latencyRtt);
  }

  function updateBatteryUI(pct, volt) {
    const pc = pct !== undefined ? clamp(Math.round(pct), 0, 100) : null;
    const icon = $("batteryLevel");
    const pctEl = $("batteryPct");
    if (!icon && !pctEl) return;
    if (pctEl) pctEl.textContent = pc === null ? "—" : pc + "%";
    const voltEl = $("batteryVolt");
    if (voltEl) voltEl.textContent = volt !== undefined ? Number(volt).toFixed(2) + " V" : "—";
    if (pc !== null && icon) {
      icon.style.width = pc + "%";
      icon.parentElement.classList.toggle("low", pc <= 30);
      icon.parentElement.classList.toggle("critical", pc <= 15);
    }
  }

  function updateWifiUI(rssi, ping) {
    const barsEl = $("wifiBars");
    if (!barsEl && !$("wifiRssi")) return;
    const bars = barsEl ? barsEl.children : [];
    let level = 0;
    if (rssi !== undefined) {
      const r = Number(rssi);
      level = r > -60 ? 4 : r > -68 ? 3 : r > -76 ? 2 : r > -84 ? 1 : 0;
    }
    for (let i = 0; i < bars.length; i++) bars[i].classList.toggle("on", i < level);
    const rssiEl = $("wifiRssi");
    if (rssiEl) rssiEl.textContent = rssi !== undefined ? rssi + " dBm" : "—";
    const pingEl = $("wifiPing");
    if (pingEl) pingEl.textContent = ping !== undefined && ping !== null ? ping + " ms" : "—";
  }

  function fmtUptime(s) {
    s = Math.floor(Number(s) || 0);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return d + "d " + h + "h";
    if (h) return h + "h " + m + "m";
    if (m) return m + "m " + sec + "s";
    return sec + "s";
  }

  /* ============================================================
     GAUGES (canvas)
     ============================================================ */
  const Gauge = {
    speedCtx: null,
    speedVal: 0,
    targets: { speed: 0 },
    canvas: null,
    size: 0
  };

  function initGauges() {
    Gauge.canvas = $("gaugeSpeedCanvas");
    Gauge.speedCtx = Gauge.canvas.getContext("2d");
    Gauge.canvas.style.width = "100%";
    Gauge.canvas.style.height = "100%";
    requestAnimationFrame(gaugeLoop);
  }

  function gaugeLoop() {
    Gauge.speedVal = lerp(Gauge.speedVal, Gauge.targets.speed, 0.12);
    if (Math.abs(Gauge.speedVal - Gauge.targets.speed) < 0.3) Gauge.speedVal = Gauge.targets.speed;
    drawGauge(Gauge.speedCtx, Gauge.speedVal, 0, 140, { needle: "#ff5a4d", redline: [118, 140] });
    requestAnimationFrame(gaugeLoop);
  }

  function drawGauge(ctx, val, min, max, opt) {
    const size = Math.round(Gauge.canvas.getBoundingClientRect().width) || Gauge.size || 220;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (Gauge.size !== size || Gauge.canvas.width !== size * dpr) {
      Gauge.canvas.width = size * dpr;
      Gauge.canvas.height = size * dpr;
      Gauge.size = size;
    }
    const s = size / 220;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, 0, 0);
    const w = 220, h = 220, cx = w / 2, cy = h / 2;
    const rOuter = 96, rTrack = 80, rInner = 72;
    const start = Math.PI * 0.75;
    const sweep = Math.PI * 1.5;
    const end = start + sweep;
    ctx.clearRect(0, 0, w, h);

    const span = max - min;
    const angOf = (v) => start + (clamp(v, min, max) - min) / span * sweep;

    ctx.lineCap = "butt";
    ctx.strokeStyle = "rgba(255,255,255,0.09)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter + 2, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, rTrack, start + 0.03, end - 0.03);
    ctx.stroke();

    if (opt.redline) {
      ctx.strokeStyle = "#ff5a4d";
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(cx, cy, rTrack, angOf(opt.redline[0]), angOf(opt.redline[1]));
      ctx.stroke();
    } else if (opt.redZone) {
      ctx.strokeStyle = "rgba(255,90,77,0.55)";
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(cx, cy, rTrack, angOf(opt.redZone[0]), angOf(opt.redZone[1]));
      ctx.stroke();
    }

    ctx.lineCap = "round";
    for (let i = 0; i <= 106; i++) {
      const v = min + i * (span / 106);
      const a = angOf(v);
      const major = i % 9 === 0;
      const isRed = (opt.redline && v >= opt.redline[0]) || (opt.redZone && v >= opt.redZone[0]);
      ctx.strokeStyle = isRed ? "#ff5a4d" : (major ? "#c9cdd4" : "#565c65");
      ctx.lineWidth = major ? 3.4 : 1.6;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * rInner, cy + Math.sin(a) * rInner);
      ctx.lineTo(cx + Math.cos(a) * (rInner - (major ? 15 : 8)), cy + Math.sin(a) * (rInner - (major ? 15 : 8)));
      ctx.stroke();
    }

    ctx.fillStyle = "#9aa1ab";
    ctx.font = "700 11px 'SF Mono', 'Roboto Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const labelStep = Math.max(1, Math.round(span / 14));
    for (let v = min; v <= max; v += labelStep) {
      const a = angOf(v);
      const la = clamp(a, start + 0.07, end - 0.07);
      ctx.fillText(String(v), cx + Math.cos(la) * (rOuter - 5), cy + Math.sin(la) * (rOuter - 5));
    }

    const needle = angOf(Math.round(val * 10) / 10);
    ctx.strokeStyle = opt.needle || "#ff5a4d";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(needle) * 16, cy - Math.sin(needle) * 16);
    ctx.lineTo(cx + Math.cos(needle) * (rInner - 8), cy + Math.sin(needle) * (rInner - 8));
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#e8eaed";
    ctx.beginPath();
    ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0a0a0b";
    ctx.beginPath();
    ctx.arc(cx, cy, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }

  function updateGauges() {
    const t = state.telemetry;
    const speed = t.speed !== undefined ? clamp(Number(t.speed), 0, 140) : 0;
    Gauge.targets.speed = speed;
    $("gaugeSpeedNumber").textContent = Math.round(speed);
    const cc = $("clusterCenter");
    if (cc) cc.classList.toggle("reverse", state.gear === "R");
  }

  /* ============================================================
     WARNING ICONS
     ============================================================ */
  const WARN_ICONS = [
    { id: "seatbelt", label: "SEATBELT", icon: '<path d="M7 4a5 5 0 0 1 10 0v3M8 5v14M16 5v14M12 12v3"/><path d="M10 17h4"/>' },
    { id: "battery", label: "BATTERY", icon: '<rect x="3" y="8" width="18" height="10" rx="1"/><path d="M7 12v2M11 12v2M15 12v2M21 11v6"/>' },
    { id: "temperature", label: "TEMP", icon: '<path d="M14 14V5a2 2 0 0 0-4 0v9a4 4 0 1 0 4 0z"/><path d="M12 9v6"/>' },
    { id: "engine", label: "ENGINE", icon: '<path d="M3 12h3l2-3h3l2-3h3v3h1a2 2 0 0 1 2 2v2l-3 3h-2l-2-2h-3a1 1 0 0 1-1-1v-2"/><path d="M9 12v5h2l1 3h3l1-3h2l-1-3"/>' },
    { id: "oil", label: "OIL", icon: '<path d="M12 3s6 7 6 12a6 6 0 0 1-12 0c0-5 6-12 6-12z"/><path d="M9.5 14a2.5 2.5 0 0 0 2.5 2.5"/>' },
    { id: "parkingbrake", label: "P-BRAKE", icon: '<circle cx="12" cy="12" r="9"/><path d="M12 9v3l2 2"/><path d="M8 15h8"/>' },
    { id: "abs", label: "ABS", icon: '<circle cx="12" cy="12" r="9"/><path d="M8.5 15.5L15.5 8.5"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="12" cy="9" r="1.4"/><circle cx="12" cy="15" r="1.4"/>' },
    { id: "wifi", label: "WIFI", icon: '<path d="M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0M12 18.5h.01"/><path d="M4 8.5a14 14 0 0 1 16 0"/>' },
    { id: "camera", label: "CAMERA", icon: '<rect x="2" y="6" width="14" height="12" rx="1"/><path d="M16 10l6-3v10l-6-3"/>' },
    { id: "motor", label: "MOTOR", icon: '<circle cx="12" cy="12" r="2.2"/><path d="M12 5v2M12 17v2M12 2v3M12 19v3M5 12h2M17 12h2M2 12h3M19 12h3"/>' },
    { id: "lights", label: "LIGHTS", icon: '<path d="M8 3h8v9a4 4 0 0 1-8 0V3zM8 3H6m10 0h2M8 15h8M9 18h6"/>' },
    { id: "indicators", label: "IND", icon: '<path d="M6 5l10 7-10 7V5z"/><path d="M13 5l5 3.5M13 19l5-3.5"/>' }
  ];

  const WARN_ALERT = new Set(["parkingbrake", "abs"]);

  function initWarnings() {
    const row = $("warnRow");
    if (!row) return;
    row.innerHTML = "";
    for (const w of WARN_ICONS) {
      const el = document.createElement("div");
      el.className = "warn-icon";
      el.id = "warn-" + w.id;
      el.title = w.label;
      el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">' + w.icon + "</svg>";
      row.appendChild(el);
    }
  }

  function updateWarnings() {
    const b = state.telemetry;
    const w = b.warnings || {};
    const battLow = b.battery !== undefined && b.battery <= 20;
    const tempHigh = b.cpu_temp !== undefined && Number(b.cpu_temp) > 75;
    const camOk = state.streamState === "on";
    const wifiWeak = b.rssi !== undefined && Number(b.rssi) < -78;

    const map = {
      seatbelt: !!w.seatbelt,
      battery: battLow || w.battery === true,
      temperature: tempHigh || w.temperature === true,
      engine: w.engine === true,
      oil: w.oil === true,
      parkingbrake: w.parkingbrake === true || w.parking_brake === true || state.gear === "P",
      abs: w.abs === true,
      wifi: wifiWeak || w.wifi === true,
      camera: !camOk && state.wsConnected,
      motor: w.motor === true,
      lights: w.lights === true,
      indicators: state.indicators.left || state.indicators.right || state.indicators.hazard
    };

    for (const key in map) {
      const el = $("warn-" + key);
      if (!el) continue;
      const on = map[key];
      el.classList.toggle("active", on);
      el.classList.toggle("alert", on && WARN_ALERT.has(key));
      el.classList.toggle("ok", on && !WARN_ALERT.has(key) && key !== "indicators");
      el.classList.toggle("warn-blink", on && key === "indicators" && state.indicators.hazard);
    }
  }

  /* ============================================================
     STATUS LEDS
     ============================================================ */
  function updateStatusLed(name, on, blink) {
    const el = $("st-" + name);
    if (!el) return;
    el.classList.toggle("on", !!on);
    el.classList.toggle("blink", !!blink);
  }

  function updateStatusFromTelemetry() {
    const on = state.throttleHold || state.brakeHold;
    updateStatusLed("connected", state.wsConnected);
    updateStatusLed("motors", !!on);
    updateStatusLed("camera", state.streamState === "on");
    updateStatusLed("headlights", toggles.headlights);
    updateStatusLed("brakelights", state.brakeHold || toggles.brakeLight);
    updateStatusLed("indicator", state.indicators.left || state.indicators.right, state.indicators.left || state.indicators.right);
    updateStatusLed("hazard", state.indicators.hazard, state.indicators.hazard);
  }

  /* ============================================================
     STEERING WHEEL
     ============================================================ */
  const wheel = {
    el: null,
    dragStart: 0,
    baseAngle: 0,
    animFrame: null,
    pointerDown: false,
    keys: { left: false, right: false }
  };

  function initWheel() {
    wheel.el = $("steeringWheel");
    const startAngle = (e) => {
      const r = wheel.el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const x = e.clientX - cx, y = e.clientY - cy;
      return Math.atan2(y, x) * 180 / Math.PI;
    };
    const signedDelta = (a, b) => {
      let d = (b - a) % 360;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      return d;
    };

    wheel.el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      wheel.el.setPointerCapture(e.pointerId);
      wheel.pointerDown = true;
      wheel.el.classList.add("dragging");
      wheel.dragStart = startAngle(e);
      wheel.baseAngle = state.steerAngle;
      cancelWheelAnim();
      if (navigator.vibrate) navigator.vibrate(8);
    });

    wheel.el.addEventListener("pointermove", (e) => {
      if (!wheel.pointerDown) return;
      e.preventDefault();
      const delta = signedDelta(wheel.dragStart, startAngle(e));
      const raw = wheel.baseAngle + delta;
      const limited = clamp(raw, -CONFIG.steerMaxDeg, CONFIG.steerMaxDeg);
      setSteer(limited);
      /* Re-anchor the drag base at the physical limit so the wheel never
         snaps to the opposite lock when the finger keeps going past 90deg */
      if (limited !== raw) wheel.baseAngle = limited - delta;
    });

    const endDrag = () => {
      if (!wheel.pointerDown) return;
      wheel.pointerDown = false;
      wheel.el.classList.remove("dragging");
      if (state.steerAngle !== 0) steerRelease();
    };
    wheel.el.addEventListener("pointerup", endDrag);
    wheel.el.addEventListener("pointercancel", endDrag);

    wheel.el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        wheel.keys[dir === -1 ? "left" : "right"] = true;
        setSteer(dir * CONFIG.steerMaxDeg);
      }
    });
    wheel.el.addEventListener("keyup", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        wheel.keys[dir === -1 ? "left" : "right"] = false;
        updateKeySteer();
      }
    });

    const hub = $("wheelHub");
    const startHorn = (e) => {
      e.preventDefault();
      e.stopPropagation();
      hub.setPointerCapture(e.pointerId);
      hub.classList.add("active");
      pressHorn();
      if (navigator.vibrate) navigator.vibrate(15);
    };
    const endHorn = () => {
      if (!hub.classList.contains("active")) return;
      hub.classList.remove("active");
      releaseHorn();
    };
    hub.addEventListener("pointerdown", startHorn);
    hub.addEventListener("pointerup", endHorn);
    hub.addEventListener("pointercancel", endHorn);
    hub.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); pressHorn(); }
    });
    hub.addEventListener("keyup", (e) => {
      if (e.key === "Enter") { e.preventDefault(); releaseHorn(); }
    });
  }

  function initIndicatorStalk() {
    const stalk = $("indStalk");
    if (!stalk) return;
    let active = false;
    let startX = 0;
    let startY = 0;

    // On rotated portrait phones the page is turned 90deg, so the stalk's
    // up/down pivot axis (document Y) runs along the SCREEN's X axis.
    const docDy = (e) => {
      const rotated = document.documentElement.classList.contains("rot");
      return rotated ? (startX - e.clientX) : (e.clientY - startY);
    };

    const setVisual = (dir) => {
      stalk.classList.toggle("up", dir === "up");
      stalk.classList.toggle("down", dir === "down");
      stalk.setAttribute("aria-valuenow", dir === "up" ? "-1" : dir === "down" ? "1" : "0");
    };

    const engage = (dir, latch) => {
      if (latch) state.latchedDir = dir;
      state.indicatorMomentary = latch ? null : dir;
      setVisual(dir);
      if (dir === "up") setIndicators({ left: true });
      else setIndicators({ right: true });
      if (navigator.vibrate) navigator.vibrate(12);
    };

    const cancel = () => {
      state.latchedDir = null;
      state.indicatorMomentary = null;
      setIndicators({ left: false, right: false });
      setVisual(null);
    };

    stalk.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      stalk.setPointerCapture(e.pointerId);
      active = true;
      startX = e.clientX;
      startY = e.clientY;
      state.indicatorDrag = true;
    });

    stalk.addEventListener("pointermove", (e) => {
      if (!active) return;
      e.preventDefault();
      const dy = docDy(e);
      const ady = Math.abs(dy);
      if (ady < 8) {
        if (state.latchedDir || state.indicatorMomentary) cancel();
        return;
      }
      const dir = dy < 0 ? "up" : "down";
      if (ady >= 28) {
        if (state.latchedDir !== dir) engage(dir, true);
      } else if (state.indicatorMomentary !== dir) {
        state.latchedDir = null;
        engage(dir, false);
      }
    });

    const release = () => {
      if (!active) return;
      active = false;
      state.indicatorDrag = false;
      if (state.indicatorMomentary) {
        state.indicatorMomentary = null;
        setIndicators({ left: false, right: false });
      }
      setVisual(state.latchedDir);
    };
    stalk.addEventListener("pointerup", release);
    stalk.addEventListener("pointercancel", release);

    stalk.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndicators({ left: !state.indicators.left, hazard: state.indicators.hazard });
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndicators({ right: !state.indicators.right, hazard: state.indicators.hazard });
      }
    });
  }

  function setSteer(angle) {
    state.steerAngle = Math.round(angle);
    wheel.el.style.transform = "rotate(" + state.steerAngle + "deg)";
    const dead = Math.abs(state.steerAngle) < CONFIG.steerDeadzone;
    wheel.el.classList.toggle("turned", !dead);
    const st = $("wheelState");
    st.textContent = dead ? "CENTER" : (state.steerAngle < 0 ? "LEFT " + Math.abs(state.steerAngle) + "°" : "RIGHT " + state.steerAngle + "°");
    $("wheelIndicator").classList.toggle("turned", !dead);
  }

  function steerTick() {
    const a = state.steerAngle;
    if (Math.abs(a) < CONFIG.steerDeadzone) {
      if (state.steerSending) {
        state.steerSending = false;
        send({ command: "center" });
      }
      return;
    }
    state.steerSending = true;
    send({ command: a < 0 ? "left" : "right" });
  }

  function steerRelease() {
    if (state.steerAngle === 0) return;
    cancelWheelAnim();
    const from = state.steerAngle;
    const t0 = performance.now();
    const dur = Math.min(420, 60 + Math.abs(from) * 3.5);
    const step = (now) => {
      const t = clamp((now - t0) / dur, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setSteer(from * (1 - eased));
      if (t < 1) wheel.animFrame = requestAnimationFrame(step);
      else {
        setSteer(0);
        steerTick();
        if (navigator.vibrate) navigator.vibrate(6);
      }
    };
    wheel.animFrame = requestAnimationFrame(step);
  }

  function cancelWheelAnim() {
    if (wheel.animFrame) { cancelAnimationFrame(wheel.animFrame); wheel.animFrame = null; }
  }

  function updateKeySteer() {
    if (wheel.keys.left && !wheel.keys.right) setSteer(-CONFIG.steerMaxDeg);
    else if (wheel.keys.right && !wheel.keys.left) setSteer(CONFIG.steerMaxDeg);
    else { setSteer(0); steerTick(); }
  }

  /* ============================================================
     PEDALS
     ============================================================ */
  function initPedals() {
    bindHoldPedal("gasPedal", "forward", "stop");
    $("brakeSub").textContent = CONFIG.brakeMode === "reverse" ? "REVERSE + STOP" : "STOP ONLY";
    const brakeCmd = () => (CONFIG.brakeMode === "reverse" ? "reverse" : "stop");
    bindHoldPedal("brakePedal", brakeCmd, "stop");
  }

  function bindHoldPedal(elId, cmdFn, releaseCmd) {
    const el = $(elId);
    const press = (e) => {
      e.preventDefault();
      if (state.recording) return;
      const cmd = typeof cmdFn === "function" ? cmdFn() : cmdFn;
      el.classList.add("pressed");
      if (cmd === "forward") state.throttleHold = true;
      if (cmd === "reverse") { state.brakeHold = true; updateStatusLed("brakelights", true, false); }
      updateStatusFromTelemetry();
      updateWarnings();
      handleCommand(cmd);
      const rep = setInterval(() => {
        const c = typeof cmdFn === "function" ? cmdFn() : cmdFn;
        if (elId === "gasPedal" && !state.throttleHold) { clearInterval(rep); return; }
        if (elId === "brakePedal" && !state.brakeHold) { clearInterval(rep); return; }
        handleCommand(c);
      }, CONFIG.cmdInterval);
      el._rep = rep;
      if (navigator.vibrate) navigator.vibrate(12);
    };
    const release = () => {
      el.classList.remove("pressed");
      if (el._rep) clearInterval(el._rep);
      const wasThrottle = state.throttleHold;
      const wasBrake = state.brakeHold;
      state.throttleHold = false;
      state.brakeHold = false;
      handleCommand(releaseCmd);
      if (wasThrottle || wasBrake) {
        updateStatusFromTelemetry();
        updateWarnings();
        if (elId === "brakePedal") updateStatusLed("brakelights", toggles.brakeLight);
      }
    };
    el.addEventListener("pointerdown", press);
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  function handleCommand(cmd) {
    if (cmd === "forward" || cmd === "reverse") sendCommand(cmd);
    else send({ command: cmd });
  }

  /* ============================================================
     GEAR SLIDER (lever)
     ============================================================ */
  const GEAR_ORDER = ["P", "R", "N", "D"];

  function initGearSelector() {
    const rail = $("gearRail");
    const lever = $("gearLever");
    const knob = $("gearKnob");
    const N = GEAR_ORDER.length;
    let active = false;

    const indexFor = (clientY) => {
      const r = rail.getBoundingClientRect();
      const t = clamp((clientY - r.top) / r.height, 0, 1);
      return clamp(Math.round((t - 0.05) / 0.3), 0, N - 1);
    };

    const leverPct = (i) => (i * 30 + 5);

    const moveLever = (clientY, snap) => {
      const i = indexFor(clientY);
      if (snap) lever.classList.remove("no-anim");
      else lever.classList.add("no-anim");
      lever.style.top = leverPct(i) + "%";
      if (knob) knob.textContent = GEAR_ORDER[i];
      return i;
    };

    const pop = () => {
      lever.classList.remove("pop");
      void lever.offsetWidth;
      lever.classList.add("pop");
      setTimeout(() => lever.classList.remove("pop"), 320);
    };

    const commit = (i, drag) => {
      selectGear(GEAR_ORDER[i]);
      sendCommand("gear", { gear: state.gear });
      if (navigator.vibrate) navigator.vibrate(drag ? 6 : 12);
      if (drag) pop();
    };

    rail.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      rail.setPointerCapture(e.pointerId);
      rail.classList.add("dragging");
      lever.classList.add("dragging");
      active = true;
      moveLever(e.clientY, false);
    });

    rail.addEventListener("pointermove", (e) => {
      if (!active) return;
      e.preventDefault();
      moveLever(e.clientY, false);
    });

    const release = (e) => {
      if (!active) return;
      active = false;
      rail.classList.remove("dragging");
      lever.classList.remove("dragging");
      commit(indexFor(e.clientY), true);
    };
    rail.addEventListener("pointerup", release);
    rail.addEventListener("pointercancel", release);

    lever.addEventListener("keydown", (e) => {
      const k = e.key;
      if (k !== "ArrowUp" && k !== "ArrowDown" && k !== "Home" && k !== "End") return;
      e.preventDefault();
      let idx = GEAR_ORDER.indexOf(state.gear);
      if (k === "ArrowUp") idx--;
      else if (k === "ArrowDown") idx++;
      else if (k === "Home") idx = 0;
      else idx = N - 1;
      idx = clamp(idx, 0, N - 1);
      lever.classList.remove("no-anim");
      lever.style.top = (idx * 30 + 5) + "%";
      if (knob) knob.textContent = GEAR_ORDER[idx];
      commit(idx, false);
    });

    selectGear("P");
  }

  function selectGear(g, silent) {
    if (!GEAR_ORDER.includes(g)) return;
    state.gear = g;
    const idx = GEAR_ORDER.indexOf(g);
    document.querySelectorAll("[data-gear]").forEach((n) => {
      n.classList.toggle("active", n.dataset.gear === g);
    });
    const lever = $("gearLever");
    if (lever) {
      lever.setAttribute("aria-valuenow", String(idx));
      lever.classList.remove("no-anim");
      lever.style.top = (idx * 30 + 5) + "%";
    }
    const knob = $("gearKnob");
    if (knob) knob.textContent = g;
    const cur = $("gearCurrent");
    if (cur) cur.textContent = g;
    if (g === "R" && !toggles.reverseLight) {
      setToggle("reverseLight", true);
      send({ command: "reverselight", value: 1 });
    } else if (g !== "R" && toggles.reverseLight) {
      setToggle("reverseLight", false);
      send({ command: "reverselight", value: 0 });
    }
    updateStatusFromTelemetry();
    updateWarnings();
  }

  /* ============================================================
     ROCKERS + TOGGLES
     ============================================================ */
  function initRockers() {
    document.querySelectorAll(".rocker").forEach((r) => {
      r.addEventListener("click", () => {
        const name = r.dataset.toggle;
        if (!(name in toggles)) return;
        setToggle(name, !toggles[name]);
        send({ command: name, value: toggles[name] ? 1 : 0 });
        updateStatusFromTelemetry();
        if (navigator.vibrate) navigator.vibrate(8);
      });
    });

    const lever = $("lightLever");
    if (lever) {
      const toggleLever = () => {
        setToggle("headlights", !toggles.headlights);
        send({ command: "headlights", value: toggles.headlights ? 1 : 0 });
        updateStatusFromTelemetry();
        if (navigator.vibrate) navigator.vibrate(8);
      };
      lever.addEventListener("click", toggleLever);
      lever.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleLever();
        }
      });
    }
  }

  function setToggle(name, val) {
    toggles[name] = val;
    const rocker = document.querySelector('.rocker[data-toggle="' + name + '"]');
    if (rocker) rocker.classList.toggle("on", val);
    const led = document.querySelector('[data-led="' + name + '"]');
    if (led) led.classList.toggle("on", val);
    if (name === "headlights") {
      const lever = $("lightLever");
      if (lever) {
        lever.classList.toggle("on", val);
        lever.setAttribute("aria-checked", val ? "true" : "false");
      }
    }
    const revBtn = $("btnReverseLight");
    if (name === "reverseLight" && revBtn) revBtn.classList.toggle("active", val);
    if (name === "brakeLight") updateStatusLed("brakelights", state.brakeHold || val);
    if (name === "headlights") updateStatusLed("headlights", val);
  }

  /* ============================================================
     ROUND PUSH BUTTONS
     ============================================================ */
  function initRoundButtons() {
    const btns = {
      btnBrakeLight: "brakeLight",
      btnReverseLight: "reverseLight",
      btnLeftInd: "leftIndicator",
      btnRightInd: "rightIndicator",
      btnHazard: "hazard"
    };

    for (const id in btns) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener("click", () => {
        if (btns[id] === "leftIndicator") setIndicators({ left: !state.indicators.left, hazard: state.indicators.hazard });
        else if (btns[id] === "rightIndicator") setIndicators({ right: !state.indicators.right, hazard: state.indicators.hazard });
        else if (btns[id] === "hazard") setIndicators({ hazard: !state.indicators.hazard });
        else {
          setToggle(btns[id], !toggles[btns[id]]);
          send({ command: btns[id], value: toggles[btns[id]] ? 1 : 0 });
        }
        if (navigator.vibrate) navigator.vibrate(8);
      });
    }
  }

  /* Emergency stop — no visible button anymore, kept on the ESC key */
  function triggerEStop() {
    sendCommand("estop");
    send({ type: "emergency", value: 1 });
    for (const t of ["headlights", "highbeam", "parkinglights", "foglights", "interiorlight", "brakeLight", "reverseLight"]) setToggle(t, false);
    selectGear("P");
    setIndicators({ left: false, right: false, hazard: false });
    state.throttleHold = false;
    state.brakeHold = false;
    $("gasPedal").classList.remove("pressed");
    $("brakePedal").classList.remove("pressed");
    updateStatusFromTelemetry();
    if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
  }

  /* ============================================================
     TURN INDICATORS
     ============================================================ */
  function setIndicators(next) {
    const it = state.indicators;
    if (next.hazard !== undefined) it.hazard = !!next.hazard;
    if (it.hazard) { it.left = false; it.right = false; }
    if (next.left !== undefined && !it.hazard) { it.left = !!next.left; if (it.left) it.right = false; }
    if (next.right !== undefined && !it.hazard) { it.right = !!next.right; if (it.right) it.left = false; }

    const any = it.left || it.right || it.hazard;
    const stalk = $("indStalk");
    if (stalk && !state.indicatorDrag) {
      stalk.classList.toggle("up", it.left || it.hazard);
      stalk.classList.toggle("down", it.right || it.hazard);
      stalk.setAttribute("aria-valuenow", it.left || it.hazard ? "-1" : it.right ? "1" : "0");
    }
    const hzBtn = $("btnHazard");
    const liBtn = $("btnLeftInd");
    const riBtn = $("btnRightInd");
    if (hzBtn) hzBtn.classList.toggle("active", it.hazard);
    if (hzBtn) hzBtn.classList.toggle("danger", it.hazard);
    if (liBtn) liBtn.classList.toggle("active", it.left || it.hazard);
    if (riBtn) riBtn.classList.toggle("active", it.right || it.hazard);
    if (liBtn) liBtn.classList.add("ind-btn");
    if (riBtn) riBtn.classList.add("ind-btn");

    clearInterval(state.indicatorTimer);
    state.indicatorTimer = null;
    state.indicatorPhase = 0;
    it.ohl = false;
    it.ohr = false;

    if (any) {
      const rate = it.hazard ? 420 : 640;
      state.indicatorTimer = setInterval(() => {
        state.indicatorPhase++;
        const on = state.indicatorPhase % 2 === 1;
        it.ohl = (it.left || it.hazard) && on;
        it.ohr = (it.right || it.hazard) && on;
        if (liBtn) liBtn.classList.toggle("active", it.ohl);
        if (riBtn) riBtn.classList.toggle("active", it.ohr);
        const blip = hzBtn && hzBtn.querySelector(".ind-blip");
        if (blip) blip.classList.toggle("on", on);
        send({ type: "indicator", left: it.ohl, right: it.ohr, hazard: it.hazard, phase: state.indicatorPhase });
        if (state.autoCancelInd && !it.hazard && state.indicatorPhase >= 8) cancelIndicatorsSilent();
      }, rate);
      it.ohl = it.left || it.hazard;
      it.ohr = it.right || it.hazard;
      if (liBtn) liBtn.classList.toggle("active", it.ohl);
      if (riBtn) riBtn.classList.toggle("active", it.ohr);
      updateStatusLed("indicator", true, true);
      updateStatusLed("hazard", it.hazard, it.hazard);
      send({ type: "indicator", left: it.ohl, right: it.ohr, hazard: it.hazard, phase: 1 });
    } else {
      send({ type: "indicator", left: false, right: false, hazard: false });
      const blip = hzBtn && hzBtn.querySelector(".ind-blip");
      if (blip) blip.classList.remove("on");
      updateStatusLed("indicator", false);
      updateStatusLed("hazard", false);
    }
    updateWarnings();
  }

  function cancelIndicatorsSilent() {
    clearInterval(state.indicatorTimer);
    state.indicatorTimer = null;
    state.indicators.left = false;
    state.indicators.right = false;
    state.indicators.hazard = false;
    state.indicators.ohl = false;
    state.indicators.ohr = false;
    const liBtn = $("btnLeftInd");
    const riBtn = $("btnRightInd");
    const hzBtn = $("btnHazard");
    if (liBtn) liBtn.classList.remove("active");
    if (riBtn) riBtn.classList.remove("active");
    if (hzBtn) hzBtn.classList.remove("active");
    if (hzBtn) hzBtn.classList.remove("danger");
    const blip = hzBtn && hzBtn.querySelector(".ind-blip");
    if (blip) blip.classList.remove("on");
    send({ type: "indicator", left: false, right: false, hazard: false });
    updateStatusLed("indicator", false);
    updateStatusLed("hazard", false);
    updateWarnings();
  }

  /* ============================================================
     CAMERA
     ============================================================ */
  let camRetries = 0;

  function initCamera() {
    const img = $("camFeed");
    img.addEventListener("load", () => {
      camRetries = 0;
      $("camReconnect").hidden = true;
      setCamStatus("ok", "LIVE");
      camFpsCount++;
      $("camFeedFs").src = img.src;
    });
    img.addEventListener("error", () => {
      setCamStatus("warn", "SIGNAL LOST");
      if (state.streamState !== "on") return;
      camRetries++;
      $("camReconnect").hidden = false;
      $("camReconnectText").textContent = "RECONNECTING TO VIDEO STREAM… (RETRY " + camRetries + ")";
      if (camRetries > 2) {
        setTimeout(() => { if (state.streamState === "on") img.src = streamURL(); }, 1200);
      }
    });

    $("btnStream").addEventListener("click", toggleStream);
    $("btnSnapshot").addEventListener("click", takeSnapshot);
    $("btnRecord").addEventListener("click", toggleRecord);
    $("btnReconnectCam").addEventListener("click", () => {
      camRetries = 0;
      startStream();
    });
    $("btnQuality").addEventListener("click", (e) => {
      e.stopPropagation();
      $("qualityMenu").hidden = !$("qualityMenu").hidden;
    });
    document.querySelectorAll(".quality-menu-item").forEach((item) => {
      item.addEventListener("click", () => {
        const q = item.dataset.quality;
        CONFIG.quality = q;
        send({ type: "quality", value: CONFIG.quality });
        $("qualityMenu").hidden = true;
        const qLabel = q === "0" ? "OFF" : (q.indexOf("|") > -1 ? q.split("|")[0].replace("x", "×") : q.toUpperCase());
        $("btnQualityLabel").textContent = qLabel;
        if (state.streamState === "on") startStream();
      });
    });
    document.addEventListener("pointerdown", (e) => {
      const menu = $("qualityMenu");
      if (!menu.hidden && !menu.contains(e.target) && e.target.id !== "btnQuality") menu.hidden = true;
    });

    $("btnFullscreen").addEventListener("click", openFullscreen);
    $("btnFsClose").addEventListener("click", closeFullscreen);
  }

  let camFpsCount = 0;
  let camFpsTimer = null;

  function streamURL() {
    const base = location.protocol === "https:" ? "https://" : "http://";
    let path = CONFIG.streamPath;
    if (path.indexOf("http") === 0) {
      return path + (CONFIG.quality !== "0" ? "?q=" + CONFIG.quality : "");
    }
    return base + location.host + path + (CONFIG.quality !== "0" ? "?q=" + CONFIG.quality : "");
  }

  function toggleStream() {
    if (state.streamState === "on") stopStream();
    else startStream();
  }

  function startStream() {
    if (CONFIG.quality === "0") {
      setCamStatus("warn", "STREAM DISABLED");
      return;
    }
    state.streamState = "on";
    $("camView").classList.add("live");
    $("btnStreamLabel").textContent = "■ STOP";
    $("camReconnect").hidden = true;
    camRetries = 0;
    camFpsCount = 0;
    if (camFpsTimer) clearInterval(camFpsTimer);
    camFpsTimer = setInterval(() => {
      $("camHud").textContent = (CONFIG.quality.split("|")[0] || "—") + " • " + camFpsCount + " FPS";
      const telFps = $("telFps");
      if (telFps) telFps.textContent = camFpsCount;
      state.telemetry.fps = camFpsCount;
      camFpsCount = 0;
    }, 1000);
    $("camFeed").src = streamURL();
    setCamStatus("ok", "LIVE");
    updateStatusFromTelemetry();
    updateWarnings();
  }

  function stopStream() {
    if (state.streamState !== "on") return;
    state.streamState = "off";
    $("camView").classList.remove("live");
    $("btnStreamLabel").textContent = "STREAM";
    $("camFeed").removeAttribute("src");
    if (camFpsTimer) { clearInterval(camFpsTimer); camFpsTimer = null; }
    if (state.recording) stopRecord();
    setCamStatus("warn", "STANDBY");
    updateStatusFromTelemetry();
    updateWarnings();
  }

  function setCamStatus(kind, label) {
    const el = $("camStatus");
    el.className = "cam-status " + kind;
    el.textContent = label;
    $("camFsStatus").textContent = label;
  }

  function takeSnapshot() {
    const img = $("camFeed");
    if (!img.src || state.streamState !== "on") { setCamStatus("warn", "NO STREAM"); return; }
    try {
      const a = document.createElement("a");
      a.href = img.src;
      a.download = "capture_" + ts() + ".jpg";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setCamStatus("ok", "SNAPSHOT");
      if (navigator.vibrate) navigator.vibrate(14);
    } catch (e) {
      setCamStatus("warn", "SNAPSHOT FAILED");
    }
  }

  function ts() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function toggleRecord() {
    if (state.recording) { stopRecord(); return; }
    const img = $("camFeed");
    if (state.streamState !== "on" || !img.src) { setCamStatus("warn", "NO STREAM"); return; }
    if (!window.MediaRecorder) { setCamStatus("warn", "REC UNAVAILABLE"); return; }
    try {
      const canvas = document.createElement("canvas");
      const [w, h] = (CONFIG.quality.split("|")[0] || "640x480").split("x").map(Number);
      canvas.width = w || 640; canvas.height = h || 480;
      const c = canvas.getContext("2d");
      state.recChunks = [];
      state.recSeconds = 0;
      state.recStream = canvas.captureStream(30);
      state.mediaRecorder = new MediaRecorder(state.recStream, { mimeType: pickMime(), videoBitsPerSecond: 4_000_000 });
      state.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) state.recChunks.push(e.data); };
      state.mediaRecorder.onstop = () => {
        const blob = new Blob(state.recChunks, { type: "video/webm" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "recording_" + ts() + ".webm";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      };
      state.mediaRecorder.start(250);
      state.recording = true;
      $("btnRecord").classList.add("active");
      const dot = $("btnRecord").querySelector(".rec-dot");
      if (dot) dot.classList.add("pulsing");
      $("camRecordingBadge").hidden = false;
      state.recTimer = setInterval(() => {
        state.recSeconds++;
        $("camRecordingBadge").lastChild.textContent = " REC " + state.recSeconds + "s";
        if (img.complete && img.naturalWidth > 0) {
          c.drawImage(img, 0, 0, canvas.width, canvas.height);
        }
      }, 1000);
      if (navigator.vibrate) navigator.vibrate(20);
    } catch (e) {
      setCamStatus("warn", "REC FAILED");
    }
  }

  function pickMime() {
    for (const m of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return "";
  }

  function stopRecord() {
    if (!state.recording) return;
    state.recording = false;
    if (state.recTimer) clearInterval(state.recTimer);
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") state.mediaRecorder.stop();
    $("btnRecord").classList.remove("active");
    const dot = $("btnRecord").querySelector(".rec-dot");
    if (dot) dot.classList.remove("pulsing");
    $("camRecordingBadge").hidden = true;
    setCamStatus("ok", "REC SAVED");
    if (navigator.vibrate) navigator.vibrate(14);
  }

  function openFullscreen() {
    state.fullscreen = true;
    $("camFs").hidden = false;
  }

  function closeFullscreen() {
    state.fullscreen = false;
    $("camFs").hidden = true;
  }

  /* ============================================================
     KEYBOARD
     ============================================================ */
  let keyThrottleTimer = null;
  let keyBrakeTimer = null;

  function initKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === " " || k.indexOf("arrow") === 0) e.preventDefault();
      switch (k) {
        case "w": case "arrowup":
          if (state.throttleHold) break;
          state.throttleHold = true;
          handleCommand("forward");
          keyThrottleTimer = setInterval(() => handleCommand("forward"), CONFIG.cmdInterval);
          updateStatusFromTelemetry();
          break;
        case "s": case "arrowdown":
          if (state.brakeHold) break;
          state.brakeHold = true;
          const bcmd = CONFIG.brakeMode === "reverse" ? "reverse" : "stop";
          handleCommand(bcmd);
          keyBrakeTimer = setInterval(() => handleCommand(bcmd), CONFIG.cmdInterval);
          updateStatusLed("brakelights", true);
          updateStatusFromTelemetry();
          break;
        case "a": case "arrowleft":
          wheel.keys.left = true;
          updateKeySteer();
          break;
        case "d": case "arrowright":
          wheel.keys.right = true;
          updateKeySteer();
          break;
        case " ": pressHorn();
          break;
        case "h": toggleRocker("headlights");
          break;
        case "f": toggleRocker("foglights");
          break;
        case "q": setIndicators({ left: !state.indicators.left, hazard: state.indicators.hazard });
          break;
        case "e": setIndicators({ right: !state.indicators.right, hazard: state.indicators.hazard });
          break;
        case "z": setIndicators({ hazard: !state.indicators.hazard });
          break;
        case "p": toggleRocker("parkinglights");
          break;
        case "r": toggleRecord();
          break;
        case "escape":
          triggerEStop();
          break;
        case "g":
          const next = GEAR_ORDER[(GEAR_ORDER.indexOf(state.gear) + 1) % GEAR_ORDER.length];
          selectGear(next);
          sendCommand("gear", { gear: next });
          break;
        case "b": toggleRocker("highbeam");
          break;
      }
    });

    window.addEventListener("keyup", (e) => {
      const k = e.key.toLowerCase();
      if (e.key === " ") { releaseHorn(); return; }
      switch (k) {
        case "w": case "arrowup":
          if (keyThrottleTimer) clearInterval(keyThrottleTimer);
          state.throttleHold = false;
          handleCommand("stop");
          updateStatusFromTelemetry();
          break;
        case "s": case "arrowdown":
          if (keyBrakeTimer) clearInterval(keyBrakeTimer);
          state.brakeHold = false;
          handleCommand("stop");
          updateStatusLed("brakelights", toggles.brakeLight);
          updateStatusFromTelemetry();
          break;
        case "a":
          wheel.keys.left = false;
          updateKeySteer();
          break;
        case "d":
          wheel.keys.right = false;
          updateKeySteer();
          break;
      }
    });

    window.addEventListener("blur", () => {
      if (keyThrottleTimer) clearInterval(keyThrottleTimer);
      if (keyBrakeTimer) clearInterval(keyBrakeTimer);
      state.throttleHold = false;
      state.brakeHold = false;
      wheel.keys.left = wheel.keys.right = false;
      updateKeySteer();
      releaseHorn();
      updateStatusFromTelemetry();
    });
  }

  function toggleRocker(name) {
    if (!(name in toggles)) return;
    setToggle(name, !toggles[name]);
    send({ command: name, value: toggles[name] ? 1 : 0 });
    updateStatusFromTelemetry();
    if (navigator.vibrate) navigator.vibrate(8);
  }

  function pressHorn() {
    const el = $("btnHorn");
    if (el) el.classList.add("active");
    sendCommand("horn");
  }

  function releaseHorn() {
    const el = $("btnHorn");
    if (el) el.classList.remove("active");
    send({ command: "horn", value: 0 });
  }

  /* ============================================================
     MISC UI
     ============================================================ */
  function applyConfigToUI() {
    $("brakeSub").textContent = CONFIG.brakeMode === "reverse" ? "REVERSE + STOP" : "STOP ONLY";
  }

  function initConnectionUI() {
    $("btnConnect").addEventListener("click", () => {
      if (state.wsConnected) disconnect();
      else connect();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.fullscreen) closeFullscreen();
    });
  }

  /* ============================================================
     MOBILE ORIENTATION LOCK
     Rotates the whole page 90deg on portrait phones so the HMI
     is always seen in landscape. `.rot` is driven by CSS; here we
     also set --rot-vh/--rot-vw from the live visual viewport so
     the rotated frame always equals the visible screen (it follows
     the mobile URL bar expand/collapse) and the layout stays fully
     responsive to that size.
     ============================================================ */
  function applyOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    const phone = Math.min(window.innerWidth, window.innerHeight) <= 480;
    const rot = portrait && phone;
    const root = document.documentElement;
    root.classList.toggle("rot", rot);
    if (rot) {
      const vv = window.visualViewport;
      const h = vv ? vv.height : window.innerHeight;
      const w = vv ? vv.width : window.innerWidth;
      root.style.setProperty("--rot-vh", h + "px");
      root.style.setProperty("--rot-vw", w + "px");
      try { window.scrollTo(0, 0); } catch (e) {}
    }
  }

  /* ============================================================
     LOADING SCREEN
     Fast, smooth boot overlay: eased progress counter, then a
     quick finish once resources are loaded (or after a timeout).
     ============================================================ */
  function initLoader() {
    const loader = $("loader");
    const bar = $("loaderBar");
    const pct = $("loaderPct");
    if (!loader || !bar) return;

    const t0 = performance.now();
    const MIN_TIME = 1500;
    let finished = false;

    const ease = (t) => 1 - Math.pow(1 - t, 3);

    function finish() {
      if (finished) return;
      const elapsed = performance.now() - t0;
      if (elapsed < MIN_TIME) {
        setTimeout(finish, MIN_TIME - elapsed);
        return;
      }
      finished = true;
      let v = parseFloat(bar.style.width) || 0;
      const step = () => {
        v = Math.min(100, v + (100 - v) * 0.3);
        bar.style.width = v.toFixed(1) + "%";
        if (pct) pct.textContent = Math.round(v) + "%";
        if (v < 99.5) requestAnimationFrame(step);
        else setTimeout(() => loader.classList.add("done"), 220);
      };
      requestAnimationFrame(step);
    }

    let v = 0;
    (function tick() {
      if (finished) return;
      const t = Math.min(1, (performance.now() - t0) / MIN_TIME);
      v = Math.min(92, ease(t) * 92);
      bar.style.width = v.toFixed(1) + "%";
      if (pct) pct.textContent = Math.round(v) + "%";
      requestAnimationFrame(tick);
    })();

    if (document.readyState === "complete") finish();
    else {
      window.addEventListener("load", finish);
      setTimeout(finish, 4500);
    }
  }

  /* ============================================================
     INIT
     ============================================================ */
  function init() {
    initLoader();
    initGauges();
    initWarnings();
    initWheel();
    initPedals();
    initGearSelector();
    initIndicatorStalk();
    initRockers();
    initRoundButtons();
    initCamera();
    initKeyboard();
    initConnectionUI();
    applyOrientation();
    window.addEventListener("resize", applyOrientation);
    window.addEventListener("orientationchange", applyOrientation);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", applyOrientation);
    }

    updateStatusFromTelemetry();
    updateWarnings();
    setSteer(0);

    /* Long-press on touch: kill text selection callout / context menu */
    if (window.matchMedia && matchMedia("(pointer: coarse)").matches || "ontouchstart" in window) {
      document.addEventListener("contextmenu", (e) => e.preventDefault());
      document.addEventListener("selectstart", (e) => e.preventDefault());
    }

    setInterval(steerTick, 90);
    setTimeout(() => setInterval(() => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        send({ type: "ping", t: performance.now() });
      }
    }, 3000), 3000);

    connect();
    startStream();
  }

  document.addEventListener("DOMContentLoaded", init);
})();