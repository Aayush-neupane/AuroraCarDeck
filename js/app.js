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
    return proto + "://" + pageHost() + ":" + port + CONFIG.wsPath;
  }

  function pageHost() {
    return location.hostname || (location.protocol === "file:" ? "localhost" : "");
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(obj));
    }
  }

  function sendCommand(cmd, meta) {
    const msg = Object.assign({ command: cmd }, meta || {});
    send(msg);
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
    };
    state.ws.onmessage = (ev) => handleMessage(ev.data);
    state.ws.onclose = () => {
      state.wsConnected = false;
      setConnState("off", "OFFLINE");
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

  /* ============================================================
     GAUGES (canvas)
     ============================================================ */
  const Gauge = {
    speedCtx: null,
    speedVal: 0,
    targets: { speed: 0 },
    canvas: null,
    size: 0,
    tripKm: 0,
    lastT: null
  };

  function initGauges() {
    Gauge.canvas = $("gaugeSpeedCanvas");
    Gauge.speedCtx = Gauge.canvas.getContext("2d");
    Gauge.canvas.style.width = "100%";
    Gauge.canvas.style.height = "100%";
    requestAnimationFrame(gaugeLoop);
  }

  function gaugeLoop() {
    const now = performance.now();
    if (Gauge.lastT === null) Gauge.lastT = now;
    const dt = (now - Gauge.lastT) / 1000;
    Gauge.lastT = now;
    Gauge.speedVal = lerp(Gauge.speedVal, Gauge.targets.speed, 0.12);
    if (Math.abs(Gauge.speedVal - Gauge.targets.speed) < 0.3) Gauge.speedVal = Gauge.targets.speed;
    Gauge.tripKm += (Gauge.speedVal / 3600) * dt;
    drawGauge(Gauge.speedCtx, Gauge.speedVal, 0, 140, { needle: "#ff5a4d", redline: [118, 140] });
    const trip = $("subTrip");
    if (trip) trip.textContent = Gauge.tripKm.toFixed(1);
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
    const ringGrad = ctx.createLinearGradient(0, cy - rOuter, 0, cy + rOuter);
    ringGrad.addColorStop(0, "rgba(235,240,250,0.30)");
    ringGrad.addColorStop(0.45, "rgba(255,255,255,0.07)");
    ringGrad.addColorStop(0.5, "rgba(255,255,255,0.02)");
    ringGrad.addColorStop(1, "rgba(0,0,0,0.45)");
    ctx.strokeStyle = ringGrad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter + 2, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = "rgba(115,150,215,0.12)";
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
      ctx.strokeStyle = isRed ? "#ff5a4d" : (major ? "#e2e7ef" : "#6a7280");
      ctx.lineWidth = major ? 3.4 : 1.6;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * rInner, cy + Math.sin(a) * rInner);
      ctx.lineTo(cx + Math.cos(a) * (rInner - (major ? 15 : 8)), cy + Math.sin(a) * (rInner - (major ? 15 : 8)));
      ctx.stroke();
    }

    ctx.fillStyle = "#aab4c0";
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
    ctx.save();
    ctx.shadowColor = "rgba(255,90,77,0.65)";
    ctx.shadowBlur = 7;
    ctx.strokeStyle = opt.needle || "#ff5a4d";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(needle) * 16, cy - Math.sin(needle) * 16);
    ctx.lineTo(cx + Math.cos(needle) * (rInner - 8), cy + Math.sin(needle) * (rInner - 8));
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = "rgba(120,160,220,0.28)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, 9.5, 0, Math.PI * 2);
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
    updateSubReadout();
  }

  function updateSubReadout() {
    const gear = $("subGear");
    if (gear) {
      gear.textContent = state.gear;
      gear.classList.toggle("active", state.gear === "D" || state.gear === "R");
    }
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
      if (cmd === "reverse") state.brakeHold = true;
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
        updateSubReadout();
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
    if (g === "R" && !toggles.reverseLight) {
      setToggle("reverseLight", true);
      send({ command: "reverselight", value: 1 });
    } else if (g !== "R" && toggles.reverseLight) {
      setToggle("reverseLight", false);
      send({ command: "reverselight", value: 0 });
    }
  }

  /* ============================================================
     ROCKERS + TOGGLES
     ============================================================ */
  function initRockers() {
    const lever = $("lightLever");
    if (lever) {
      const toggleLever = () => {
        setToggle("headlights", !toggles.headlights);
        send({ command: "headlights", value: toggles.headlights ? 1 : 0 });
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
    const led = document.querySelector('[data-led="' + name + '"]');
    if (led) led.classList.toggle("on", val);
    if (name === "headlights") {
      const lever = $("lightLever");
      if (lever) {
        lever.classList.toggle("on", val);
        lever.setAttribute("aria-checked", val ? "true" : "false");
      }
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
        send({ type: "indicator", left: it.ohl, right: it.ohr, hazard: it.hazard, phase: state.indicatorPhase });
        if (state.autoCancelInd && !it.hazard && state.indicatorPhase >= 8) cancelIndicatorsSilent();
      }, rate);
      it.ohl = it.left || it.hazard;
      it.ohr = it.right || it.hazard;
      send({ type: "indicator", left: it.ohl, right: it.ohr, hazard: it.hazard, phase: 1 });
    } else {
      send({ type: "indicator", left: false, right: false, hazard: false });
    }
  }

  function cancelIndicatorsSilent() {
    clearInterval(state.indicatorTimer);
    state.indicatorTimer = null;
    state.indicators.left = false;
    state.indicators.right = false;
    state.indicators.hazard = false;
    state.indicators.ohl = false;
    state.indicators.ohr = false;
    send({ type: "indicator", left: false, right: false, hazard: false });
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
    return base + pageHost() + ":" + (location.port || "80") + path + (CONFIG.quality !== "0" ? "?q=" + CONFIG.quality : "");
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
      state.telemetry.fps = camFpsCount;
      camFpsCount = 0;
    }, 1000);
    $("camFeed").src = streamURL();
    setCamStatus("ok", "LIVE");
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
  let keyDuty = 0;
  const KEY_TARGET_DUTY = 200;

  function toggleKeyHelp() {
    const el = $("keyHelp");
    if (el) el.hidden = !el.hidden;
  }

  function initKeyHelpUI() {
    const el = $("keyHelp");
    if (!el) return;
    el.addEventListener("click", (e) => {
      if (e.target === el) el.hidden = true;
    });
  }

  function initKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "?" || k.indexOf("arrow") === 0) e.preventDefault();
      switch (k) {
        case "w": case "arrowup":
          if (state.throttleHold) break;
          state.throttleHold = true;
          const gasEl = $("gasPedal");
          if (gasEl) gasEl.classList.add("pressed");
          handleCommand("forward");
          keyThrottleTimer = setInterval(() => {
            if (keyDuty < KEY_TARGET_DUTY) {
              keyDuty = Math.min(KEY_TARGET_DUTY, keyDuty + 40);
              send({ command: "speed", value: keyDuty });
            }
            handleCommand("forward");
          }, CONFIG.cmdInterval);
          break;
        case "s": case "arrowdown":
          if (state.brakeHold) break;
          state.brakeHold = true;
          const brakeEl = $("brakePedal");
          if (brakeEl) brakeEl.classList.add("pressed");
          const bcmd = CONFIG.brakeMode === "reverse" ? "reverse" : "stop";
          handleCommand(bcmd);
          keyBrakeTimer = setInterval(() => {
            if (keyDuty < KEY_TARGET_DUTY) {
              keyDuty = Math.min(KEY_TARGET_DUTY, keyDuty + 40);
              send({ command: "speed", value: keyDuty });
            }
            handleCommand(bcmd);
          }, CONFIG.cmdInterval);
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
        case "k": case "?":
          toggleKeyHelp();
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
          if (keyThrottleTimer) { clearInterval(keyThrottleTimer); keyThrottleTimer = null; }
          state.throttleHold = false;
          keyDuty = 0;
          send({ command: "speed", value: 0 });
          handleCommand("stop");
          const gasEl = $("gasPedal");
          if (gasEl) gasEl.classList.remove("pressed");
          break;
        case "s": case "arrowdown":
          if (keyBrakeTimer) { clearInterval(keyBrakeTimer); keyBrakeTimer = null; }
          state.brakeHold = false;
          keyDuty = 0;
          send({ command: "speed", value: 0 });
          handleCommand("stop");
          const brakeEl = $("brakePedal");
          if (brakeEl) brakeEl.classList.remove("pressed");
          break;
        case "a": case "arrowleft":
          wheel.keys.left = false;
          updateKeySteer();
          break;
        case "d": case "arrowright":
          wheel.keys.right = false;
          updateKeySteer();
          break;
      }
    });

    window.addEventListener("blur", () => {
      if (keyThrottleTimer) clearInterval(keyThrottleTimer);
      if (keyBrakeTimer) clearInterval(keyBrakeTimer);
      keyThrottleTimer = keyBrakeTimer = null;
      state.throttleHold = false;
      state.brakeHold = false;
      keyDuty = 0;
      wheel.keys.left = wheel.keys.right = false;
      updateKeySteer();
      const gasEl = $("gasPedal");
      if (gasEl) gasEl.classList.remove("pressed");
      const brakeEl = $("brakePedal");
      if (brakeEl) brakeEl.classList.remove("pressed");
      releaseHorn();
    });
  }

  function toggleRocker(name) {
    if (!(name in toggles)) return;
    setToggle(name, !toggles[name]);
    send({ command: name, value: toggles[name] ? 1 : 0 });
    if (navigator.vibrate) navigator.vibrate(8);
  }

  function pressHorn() {
    sendCommand("horn");
  }

  function releaseHorn() {
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
        else setTimeout(() => {
          loader.classList.add("done");
          document.body.classList.add("ready");
        }, 220);
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

  function initClock() {
    const el = $("connClock");
    if (!el) return;
    const tick = () => {
      const d = new Date();
      el.textContent = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ============================================================
     INIT
     ============================================================ */
  function init() {
    initLoader();
    initGauges();
    initClock();
    initWheel();
    initPedals();
    initGearSelector();
    initIndicatorStalk();
    initRockers();
    initCamera();
    initKeyboard();
    initKeyHelpUI();
    initConnectionUI();
    applyOrientation();
    window.addEventListener("resize", applyOrientation);
    window.addEventListener("orientationchange", applyOrientation);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", applyOrientation);
    }

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