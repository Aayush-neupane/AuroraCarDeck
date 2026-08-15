const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
let PORT = Number(process.env.PORT) || 8899;

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

const server = http
  .createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const file = path.normalize(path.join(ROOT, urlPath));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end("403 Forbidden");
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("404 Not Found");
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(PORT);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log("Port " + PORT + " in use, trying " + (PORT + 1) + "...");
    PORT += 1;
    server.listen(PORT);
  } else {
    throw err;
  }
});

server.on("listening", () => {
  console.log("Aurora dev server: http://localhost:" + PORT);
});