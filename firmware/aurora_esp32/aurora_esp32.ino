/*
 * ============================================================
 *   AURORA — ESP32 Vehicle Control Firmware
 *   Dual-motor differential drive (your wiring) + WebSocket HMI
 *
 *   HARDWARE (your car)
 *   -------------------
 *   - 2-channel H-bridge (L298N style): two motors, one per side
 *   - Steering is DIFFERENTIAL: left turn = left motor back,
 *     right motor forward (tank pivot) — no servo
 *   - Optional ESP32-CAM board on the same ESP32 (camera init
 *     is attempted at boot; the /stream endpoint just turns off
 *     if no camera is present)
 *
 *   Twin control channels
 *   ---------------------
 *   1. WebSocket (Web HMI — site files served from SPIFFS):
 *        page  http://<ip>/          (port 80)
 *        WS    ws://<ip>:81/ws       (matches CONFIG.wsPort in js/app.js)
 *      JSON commands: forward / reverse / stop / left / right / center /
 *      gear P|R|N|D / horn / estop / lights / indicator / quality / ping
 *   2. Serial Bluetooth (original basic control, "ESP32_RC_CAR"):
 *        F B L R S + digits 0-9, q  (raw — no gear gating)
 *
 *   LIBRARIES (Arduino Library Manager)
 *   - WebSockets by Markus Sattler
 *   - ArduinoJson (v6 or v7)
 *   (WiFi / WebServer / SPIFFS / esp_camera / BluetoothSerial come with
 *    the ESP32 core)
 *
 *   FLASHING
 *   --------
 *   - Board: ESP32 Dev Module (or AI Thinker ESP32-CAM if you use one)
 *   - If the HMI files are NOT yet in the ESP32's filesystem, copy
 *     index.html, css/, js/, assets/ into a "data" folder next to this
 *     sketch and run Tools > ESP32 Sketch Data Upload first.
 *   - Join AP "AuroraCar" (pass aurora123) or set WIFI_STA_SSID, then
 *     open http://192.168.4.1
 * ============================================================
 */

#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>
#include "BluetoothSerial.h"
#include <FS.h>
#include <SPIFFS.h>

#define CAMERA_MODEL_AI_THINKER   // your camera board — ignorable without one
#include "esp_camera.h"

/* ============================================================
   CONFIG
   ============================================================ */
#define WS_PORT 81                // must match CONFIG.wsPort in js/app.js

#define WIFI_AP_SSID   "AuroraCar"
#define WIFI_AP_PASS   "aurora123"
#define WIFI_STA_SSID  ""         // set to join a router instead of AP-only
#define WIFI_STA_PASS  ""

/* ---- Motor pins (your wiring) ---- */
#define ENA   25                  // PWM — left motor
#define ENB   26                  // PWM — right motor
#define IN1   18
#define IN2   19
#define IN3   21
#define IN4   22

#define PWM_FREQ 1000
#define PWM_RES  8
#define PWM_CH_A 8                // channels 0/1 are used by the camera XCLK;
#define PWM_CH_B 9                // keep motor PWM on 8/9

int speedValue = 200;             // 0..255 — BT digits / q also set this

/* ---- Horn (optional) ---- */
#define PIN_HORN     19           // set to -1 if you have no buzzer

/* ---- Lights (optional GPIO outputs — skip if not wired) ---- */
#define PIN_HEADLIGHTS 12
#define PIN_HIGHBEAM   15
#define PIN_PARKING     4
#define PIN_FOG        16
#define PIN_INTERIOR   17
#define PIN_BRAKE       5
#define PIN_REVERSE    18

/* ---- Indicator LEDs (optional) ---- */
#define PIN_IND_L      26
#define PIN_IND_R      27



#define FW_VERSION     "1.5.0"

/* JSON document — ArduinoJson v6/v7 compatible */
#if defined(ARDUINOJSON_VERSION_MAJOR) && ARDUINOJSON_VERSION_MAJOR >= 7
  #define AURORA_DOC  JsonDocument doc;
#else
  #define AURORA_DOC  DynamicJsonDocument doc(1024);
#endif

/* ============================================================
   GLOBALS
   ============================================================ */
WebServer server(80);
WebSocketsServer webSocket(WS_PORT);
BluetoothSerial SerialBT;

static const char STREAM_BOUNDARY[] = "123456789000000000000987654321";
static const char STREAM_CTYPE[]    = "multipart/x-mixed-replace;boundary=123456789000000000000987654321";

/* ---- vehicle state ---- */
enum MotorMode { MOTOR_STOP, MOTOR_FORWARD, MOTOR_REVERSE };
enum WheelDir  { W_STOP, W_FWD, W_REV };

char gear = 'P';                   // P / R / N / D
MotorMode throttle = MOTOR_STOP;   // from pedals (gear-gated on WS)
char turn = 'N';                   // N / L / R  — wheel or BT
WheelDir wA = W_STOP, wB = W_STOP; // left / right motor directions
bool hornOn = false;
bool indLeft = false, indRight = false, indHazard = false;
uint32_t lastCmdMs = 0;
int motorDuty = 0;                 // current PWM (0..255)

/* ---- camera / stream ---- */
int frameDelayMs = 50;
uint32_t framesSinceTick = 0;
String currentQuality = "800x600|20";
bool cameraReady = false;

struct LightDef { const char *name; uint8_t pin; };
static const LightDef LIGHTS[] = {
  { "headlights", PIN_HEADLIGHTS },
  { "highbeam",   PIN_HIGHBEAM },
  { "parkinglights", PIN_PARKING },
  { "foglights",  PIN_FOG },
  { "interiorlight", PIN_INTERIOR },
  { "brakelight", PIN_BRAKE },
  { "reverselight", PIN_REVERSE }
};

/* ============================================================
   MOTOR CONTROL (differential drive)
   ============================================================ */
void writeMotors() {
  digitalWrite(IN1, wA == W_FWD ? HIGH : LOW);
  digitalWrite(IN2, wA == W_REV ? HIGH : LOW);
  digitalWrite(IN3, wB == W_FWD ? HIGH : LOW);
  digitalWrite(IN4, wB == W_REV ? HIGH : LOW);

  ledcWrite(PWM_CH_A, wA == W_STOP ? 0 : motorDuty);
  ledcWrite(PWM_CH_B, wB == W_STOP ? 0 : motorDuty);
}

/* Compute wheel directions from (throttle, turn).
   Turn overrides throttle = tank pivot, same as your basic sketch. */
void applyMotion() {
  if (turn == 'L') {
    wA = W_REV; wB = W_FWD;                 // pivot left
  } else if (turn == 'R') {
    wA = W_FWD; wB = W_REV;                 // pivot right
  } else if (throttle == MOTOR_FORWARD) {
    wA = W_FWD; wB = W_FWD;
  } else if (throttle == MOTOR_REVERSE) {
    wA = W_REV; wB = W_REV;
  } else {
    wA = W_STOP; wB = W_STOP;
  }
  writeMotors();
}

void setSpeed(int spd) {
  speedValue = constrain(spd, 0, 255);
  motorDuty = speedValue;
  Serial.printf("speed -> %d\n", motorDuty);
}

/* WS path: gear-gated */
void drive(MotorMode mode) {
  if (mode == MOTOR_FORWARD && gear != 'D') mode = MOTOR_STOP;
  if (mode == MOTOR_REVERSE && gear != 'R') mode = MOTOR_STOP;
  throttle = mode;
  applyMotion();
}

void setTurn(char t) {
  turn = t;
  applyMotion();
}

void stopCar() {
  throttle = MOTOR_STOP;
  turn = 'N';
  applyMotion();
}

/* ============================================================
   WEB (static files from SPIFFS)
   ============================================================ */
static const char *mimeFor(const String &path) {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".css"))  return "text/css";
  if (path.endsWith(".js"))   return "application/javascript";
  if (path.endsWith(".png"))  return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".svg"))  return "image/svg+xml";
  if (path.endsWith(".ico"))  return "image/x-icon";
  if (path.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

void handleNotFound() {
  String path = server.uri();
  if (path == "/") path = "/index.html";
  int q = path.indexOf("?");
  if (q >= 0) path = path.substring(0, q);
  if (!SPIFFS.exists(path)) {
    server.send(404, "text/plain", "404 Not Found");
    return;
  }
  File f = SPIFFS.open(path, "r");
  if (!f) { server.send(500, "text/plain", "Cannot open file"); return; }
  server.streamFile(f, mimeFor(path));
  f.close();
}

/* ============================================================
   CAMERA (optional hardware)
   ============================================================ */
bool initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;   // NOTE: reserves ledc channels 0/1,
  config.ledc_timer   = LEDC_TIMER_0;     // which is why motors use 8/9
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  config.frame_size   = psramFound() ? FRAMESIZE_SVGA : FRAMESIZE_CIF;
  config.jpeg_quality = psramFound() ? 8 : 12;
  config.fb_count     = psramFound() ? 2 : 1;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed (0x%x) — stream disabled\n", err);
    return false;
  }
  Serial.println("Camera ready");
  return true;
}

framesize_t framesizeFor(int w) {
  if (w >= 1600) return FRAMESIZE_UXGA;
  if (w >= 1280) return FRAMESIZE_SXGA;
  if (w >= 1024) return FRAMESIZE_XGA;
  if (w >= 800)  return FRAMESIZE_SVGA;
  if (w >= 640)  return FRAMESIZE_VGA;
  if (w >= 320)  return FRAMESIZE_QVGA;
  return FRAMESIZE_SVGA;
}

/* "800x600|20" / "low" / "med" / "high" / "0" — from js/app.js */
void applyQuality(const String &q) {
  currentQuality = q;
  int fps = 20;
  framesize_t size = FRAMESIZE_SVGA;

  if (q == "low")  size = FRAMESIZE_VGA;
  else if (q == "med")  size = FRAMESIZE_SVGA;
  else if (q == "high") size = FRAMESIZE_XGA;
  else if (q != "0") {
    int ix = q.indexOf('x');
    int ip = q.indexOf('|');
    if (ix > 0) {
      size = framesizeFor(q.substring(0, ix).toInt());
      if (ip > ix) {
        int f = q.substring(ip + 1).toInt();
        if (f > 0) fps = constrain(f, 1, 60);
      }
    }
  }
  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_framesize(s, size);
    s->set_quality(s, 8);
  }
  frameDelayMs = 1000 / fps;
  Serial.println("quality -> " + q);
}

void handleStream() {
  if (!cameraReady || currentQuality == "0") {
    server.send(503, "text/plain", "Camera unavailable");
    return;
  }
  WiFiClient client = server.client();
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, STREAM_CTYPE, "");

  while (client.connected()) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) { delay(5); continue; }

    client.print("--");
    client.print(STREAM_BOUNDARY);
    client.print("\r\nContent-Type: image/jpeg\r\nContent-Length: ");
    client.print(fb->len);
    client.print("\r\n\r\n");
    client.write(fb->buf, fb->len);
    client.print("\r\n");

    framesSinceTick++;
    esp_camera_fb_return(fb);
    delay(frameDelayMs);
  }
  client.stop();
}

/* ============================================================
   WEBSOCKET (protocol documented in README.md)
   ============================================================ */
void wsSend(const JsonDocument &doc, uint8_t clientNum) {
  String out;
  serializeJson(doc, out);
  webSocket.sendTXT(clientNum, out);
}
void wsBroadcast(const JsonDocument &doc) {
  String out;
  serializeJson(doc, out);
  webSocket.broadcastTXT(out);
}

void sendConfig(uint8_t clientNum) {
  AURORA_DOC
  doc["type"] = "config";
  doc["brake_mode"] = "reverse";
  doc["quality"] = currentQuality;
  wsSend(doc, clientNum);
}

void sendTelemetry() {
  AURORA_DOC
  doc["type"] = "telemetry";

  float v = 0;
  int pct = 0;
  if (BATT_PIN >= 0) {
    v = analogReadMilliVolts(BATT_PIN) / 1000.0f * BATT_DIVIDER;
    pct = (int)constrain(100.0f * (v - BATT_EMPTY) / (BATT_FULL - BATT_EMPTY), 0, 100);
  }
  doc["battery_pct"] = pct;
  if (BATT_PIN >= 0) doc["voltage"] = (float)((int)(v * 100)) / 100.0f;
  doc["uptime"] = millis() / 1000;
  doc["motor_state"] = throttle == MOTOR_FORWARD ? "forward"
                     : throttle == MOTOR_REVERSE ? "reverse" : "idle";
  doc["cpu_temp"] = (float)((int)(temperatureRead() * 10)) / 10.0f;
  doc["rssi"] = WiFi.RSSI();
  doc["latency"] = 0;
  doc["pkt_loss"] = 0;
  doc["fps"] = framesSinceTick * 2;
  doc["cmd_resp"] = (uint32_t)(lastCmdMs ? (millis() - lastCmdMs) : 0);
  doc["firmware"] = FW_VERSION;
  doc["gear"] = String(gear);
  /* speed is synthesized from throttle so the gauge moves on a bench —
     replace with an encoder/hall readout for real speed */
  doc["speed"] = (throttle == MOTOR_FORWARD || throttle == MOTOR_REVERSE)
                 ? map(motorDuty, 0, 255, 0, 60) : 0;

  JsonObject w = doc.createNestedObject("warnings");
  w["seatbelt"] = false;
  w["battery"] = pct <= 20;
  w["temperature"] = temperatureRead() > 75;
  w["oil"] = false;
  w["abs"] = false;
  w["wifi"] = false;
  w["motor"] = false;
  w["lights"] = false;

  wsBroadcast(doc);
  framesSinceTick = 0;
}

void handleCommand(const char *cmd, const JsonDocument &doc) {
  if (!strcmp(cmd, "forward")) {
    drive(MOTOR_FORWARD);
  } else if (!strcmp(cmd, "reverse")) {
    /* brake pedal in Drive = stop, not reverse */
    drive(gear == 'R' ? MOTOR_REVERSE : MOTOR_STOP);
  } else if (!strcmp(cmd, "stop")) {
    drive(MOTOR_STOP);
  } else if (!strcmp(cmd, "left")) {
    setTurn('L');
  } else if (!strcmp(cmd, "right")) {
    setTurn('R');
  } else if (!strcmp(cmd, "center")) {
    setTurn('N');
  } else if (!strcmp(cmd, "horn")) {
    hornOn = doc["value"] | 1;
    if (PIN_HORN >= 0) digitalWrite(PIN_HORN, hornOn ? HIGH : LOW);
  } else if (!strcmp(cmd, "estop")) {
    eStop();
  } else if (!strcmp(cmd, "gear")) {
    const char *g = doc["gear"] | "P";
    if (strlen(g) == 1 && (g[0] == 'P' || g[0] == 'R' || g[0] == 'N' || g[0] == 'D')) {
      gear = g[0];
      Serial.printf("gear -> %c\n", gear);
      if (gear != 'D' && gear != 'R') drive(MOTOR_STOP);
    }
  } else {
    /* lights: {"command":"<name>","value":1|0} */
    for (const LightDef &l : LIGHTS) {
      if (!strcmp(cmd, l.name) && l.pin >= 0) {
        digitalWrite(l.pin, (doc["value"] | 0) ? HIGH : LOW);
        return;
      }
    }
  }
}

void handleWsEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.printf("[WS] client %u connected\n", num);
      sendConfig(num);
      break;

    case WStype_DISCONNECTED:
      Serial.printf("[WS] client %u disconnected — stopping car\n", num);
      stopCar();
      break;

    case WStype_TEXT: {
      AURORA_DOC
      if (deserializeJson(doc, (const char *)payload)) return;

      const char *cmd = doc["command"] | "";
      if (strlen(cmd) > 0) {
        lastCmdMs = millis();
        handleCommand(cmd, doc);
        return;
      }

      const char *type_ = doc["type"] | "";
      if (!strcmp(type_, "ping")) {
        double tval = doc["t"] | 0.0;
        doc.remove();
        doc["type"] = "pong";
        doc["t"] = tval;                  // echo the frontend timestamp
        wsSend(doc, num);
      } else if (!strcmp(type_, "quality")) {
        applyQuality(doc["value"] | "800x600|20");
      } else if (!strcmp(type_, "indicator")) {
        indLeft   = doc["left"]   | false;
        indRight  = doc["right"]  | false;
        indHazard = doc["hazard"] | false;
        if (PIN_IND_L >= 0) digitalWrite(PIN_IND_L, LOW);
        if (PIN_IND_R >= 0) digitalWrite(PIN_IND_R, LOW);
      } else if (!strcmp(type_, "hello")) {
        sendConfig(num);
      }
      break;
    }
    default:
      break;
  }
}

/* ============================================================
   BLUETOOTH (original basic control — raw, no gear gating)
   ============================================================ */
void handleBT(char c) {
  switch (c) {
    case 'F': throttle = MOTOR_FORWARD; applyMotion(); break;
    case 'B': throttle = MOTOR_REVERSE; applyMotion(); break;
    case 'L': setTurn('L'); break;
    case 'R': setTurn('R'); break;
    case 'S': stopCar(); break;
    case '0': setSpeed(0);   break;
    case '1': setSpeed(25);  break;
    case '2': setSpeed(50);  break;
    case '3': setSpeed(75);  break;
    case '4': setSpeed(100); break;
    case '5': setSpeed(125); break;
    case '6': setSpeed(150); break;
    case '7': setSpeed(175); break;
    case '8': setSpeed(200); break;
    case '9': setSpeed(225); break;
    case 'q': setSpeed(255); break;
  }
}

/* ============================================================
   SAFETY
   ============================================================ */
void eStop() {
  stopCar();
  gear = 'P';
  hornOn = false;
  if (PIN_HORN >= 0) digitalWrite(PIN_HORN, LOW);
  indLeft = indRight = indHazard = false;
  if (PIN_IND_L >= 0) digitalWrite(PIN_IND_L, LOW);
  if (PIN_IND_R >= 0) digitalWrite(PIN_IND_R, LOW);
}

/* ============================================================
   WIFI
   ============================================================ */
void initWiFi() {
  WiFi.setSleep(false);
  if (strlen(WIFI_STA_SSID) > 0) {
    WiFi.mode(WIFI_AP_STA);
    WiFi.begin(WIFI_STA_SSID, WIFI_STA_PASS);
    Serial.print("Connecting to router");
    uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 8000) {
      delay(200);
      Serial.print(".");
    }
    Serial.println();
  } else {
    WiFi.mode(WIFI_AP);
  }
  WiFi.softAP(WIFI_AP_SSID, WIFI_AP_PASS);

  Serial.printf("AP:     %s (pass: %s)\n", WIFI_AP_SSID, WIFI_AP_PASS);
  Serial.printf("Page:   http://%s\n", WiFi.softAPIP().toString().c_str());
  Serial.printf("WS:     ws://%s:%d/ws\n", WiFi.softAPIP().toString().c_str(), WS_PORT);
  if (WiFi.status() == WL_CONNECTED)
    Serial.printf("STA IP: %s\n", WiFi.localIP().toString().c_str());
}

/* ============================================================
   SETUP / LOOP
   ============================================================ */
void setup() {
  Serial.begin(115200);
  delay(200);

  if (!SPIFFS.begin(true)) Serial.println("SPIFFS mount failed");

  /* outputs */
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  if (PIN_HORN >= 0) pinMode(PIN_HORN, OUTPUT);
  for (const LightDef &l : LIGHTS)
    if (l.pin >= 0) pinMode(l.pin, OUTPUT);
  if (PIN_IND_L >= 0) pinMode(PIN_IND_L, OUTPUT);
  if (PIN_IND_R >= 0) pinMode(PIN_IND_R, OUTPUT);

  ledcSetup(PWM_CH_A, PWM_FREQ, PWM_RES);
  ledcAttachPin(ENA, PWM_CH_A);
  ledcSetup(PWM_CH_B, PWM_FREQ, PWM_RES);
  ledcAttachPin(ENB, PWM_CH_B);

  setSpeed(speedValue);

  /* Bluetooth — original basic control */
  SerialBT.begin("ESP32_RC_CAR");

  initWiFi();

  server.on("/stream", HTTP_GET, handleStream);
  server.onNotFound(handleNotFound);
  server.begin();

  webSocket.begin();
  webSocket.onEvent(handleWsEvent);

  cameraReady = initCamera();

  stopCar();
  Serial.println("Aurora firmware " FW_VERSION " ready");
}

void loop() {
  static uint32_t tTelemetry = 0, tBlink = 0;
  static bool blinkPhase = false;

  webSocket.loop();
  server.handleClient();

  /* Bluetooth commands */
  while (SerialBT.available()) {
    char cmd = SerialBT.read();
    Serial.print("BT command: ");
    Serial.println(cmd);
    handleBT(cmd);
  }

  /* indicator blink (hazard blinks faster) */
  if (indLeft || indRight || indHazard) {
    if (millis() - tBlink >= (indHazard ? 350 : 600)) {
      tBlink = millis();
      blinkPhase = !blinkPhase;
      if (PIN_IND_L >= 0)
        digitalWrite(PIN_IND_L, (indLeft || indHazard) && blinkPhase ? HIGH : LOW);
      if (PIN_IND_R >= 0)
        digitalWrite(PIN_IND_R, (indRight || indHazard) && blinkPhase ? HIGH : LOW);
    }
  } else if (millis() - tBlink >= 600) {
    if (PIN_IND_L >= 0) digitalWrite(PIN_IND_L, LOW);
    if (PIN_IND_R >= 0) digitalWrite(PIN_IND_R, LOW);
  }

  /* telemetry every 500 ms */
  if (millis() - tTelemetry >= 500) {
    tTelemetry = millis();
    sendTelemetry();
  }

  delay(2);
}