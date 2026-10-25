const https = require("https");
const { isTurnstileEnabled } = require("./turnstileConfig");

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function postForm(url, formData) {
  return new Promise((resolve, reject) => {
    const body = formData.toString();
    const request = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let data = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function getClientIp(req) {
  const forwardedFor = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"];

  if (Array.isArray(forwardedFor)) {
    return forwardedFor[0];
  }

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.ip || req.socket.remoteAddress;
}

async function verifyTurnstile(req, res, next) {
  try {
    if (!isTurnstileEnabled()) {
      return next();
    }

    const secret = process.env.TURNSTILE_SECRET_KEY;
    const token = req.body && req.body["cf-turnstile-response"];

    if (!secret) {
      return res.status(500).send("Konfigurasi Turnstile belum disiapkan.");
    }

    if (!token) {
      return res.status(400).send("Verifikasi keamanan wajib diisi.");
    }

    const formData = new URLSearchParams({
      secret,
      response: token,
      remoteip: getClientIp(req),
    });

    const result = await postForm(VERIFY_URL, formData);

    if (!result.success) {
      return res.status(403).send("Verifikasi keamanan gagal.");
    }

    next();
  } catch (error) {
    next(error);
  }
}

module.exports = verifyTurnstile;
