function parseEnvBoolean(value, fallback = true) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  return !["0", "false", "no", "off", "disabled"].includes(String(value).trim().toLowerCase());
}

// Default: aktif hanya jika kedua key sudah diisi; TURNSTILE_ENABLED bisa memaksa on/off.
function isTurnstileEnabled() {
  const hasKeys = Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);
  return parseEnvBoolean(process.env.TURNSTILE_ENABLED, hasKeys);
}

function getTurnstileSiteKey() {
  return isTurnstileEnabled() ? process.env.TURNSTILE_SITE_KEY || "" : "";
}

module.exports = {
  getTurnstileSiteKey,
  isTurnstileEnabled,
};
