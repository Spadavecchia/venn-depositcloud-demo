/*
 * Redirect-capture contract
 *
 * DepositCloud finishes enrollment by navigating the iframe to this app's
 * return.html with query params: status=success|failed, dc_account=<id>,
 * and optionally reason=<code>.
 *
 * We detect that in two independent ways and only act on the first one
 * that fires (see resultHandled below):
 *   1. On the iframe's `load` event we try to read
 *      iframe.contentWindow.location.href. That throws while the frame is
 *      still on DepositCloud's origin, and only succeeds once the frame
 *      has navigated back to our own origin (return.html).
 *   2. return.html, when it detects it is running inside a frame, posts
 *      {type: 'dc:enrollment', status, dc_account, reason} to its parent
 *      via postMessage. We listen for that here and check event.origin
 *      strictly against our own origin before trusting it.
 */

const CONFIG_STORAGE_KEY = "venn-demo:config";
const DEPOSIT_STATUS_STORAGE_KEY = "venn-demo:deposit-status";

const CHECK_SVG = '<svg class="pill-check" viewBox="0 0 24 24" aria-hidden="true"><polyline points="4 12 10 18 20 6"></polyline></svg>';

const CONFIG_DEFAULTS = {
  host: "https://test.depositcloud.com",
  path: "/enrollment/property/55d5a7763daad4bd/general_pricing_config",
  iss: "venn",
  sub: "",
  email: "",
  dob: "",
  leaseId: "",
  unitNumber: "",
};

const CONFIG_FIELDS = [
  { key: "host", id: "cfg-host" },
  { key: "path", id: "cfg-path" },
  { key: "iss", id: "cfg-iss" },
  { key: "sub", id: "cfg-sub" },
  { key: "email", id: "cfg-email" },
  { key: "dob", id: "cfg-dob" },
  { key: "leaseId", id: "cfg-lease-id" },
  { key: "unitNumber", id: "cfg-unit-number" },
];

const state = {
  resultHandled: false,
};

function readJsonStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    return;
  }
}

function removeStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch (err) {
    return;
  }
}

function computeReturnUrl() {
  return location.origin + location.pathname.replace(/[^/]*$/, "") + "return.html";
}

function loadConfig() {
  const stored = readJsonStorage(CONFIG_STORAGE_KEY) || {};
  return Object.assign({}, CONFIG_DEFAULTS, stored);
}

function saveConfigField(key, value) {
  const stored = readJsonStorage(CONFIG_STORAGE_KEY) || {};
  stored[key] = value;
  writeJsonStorage(CONFIG_STORAGE_KEY, stored);
}

function populateConfigForm(config) {
  CONFIG_FIELDS.forEach(({ key, id }) => {
    const input = document.getElementById(id);
    if (input) input.value = config[key] || "";
  });
  const secretInput = document.getElementById("cfg-secret");
  if (secretInput) secretInput.value = "";
  const returnUrlInput = document.getElementById("cfg-return-url");
  if (returnUrlInput) returnUrlInput.value = computeReturnUrl();
}

function bindConfigPersistence() {
  CONFIG_FIELDS.forEach(({ key, id }) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener("input", () => saveConfigField(key, input.value));
  });
}

function collectConfig() {
  const config = { returnUrl: computeReturnUrl(), secret: "" };
  CONFIG_FIELDS.forEach(({ key, id }) => {
    const input = document.getElementById(id);
    config[key] = input ? input.value.trim() : "";
  });
  const secretInput = document.getElementById("cfg-secret");
  config.secret = secretInput ? secretInput.value : "";
  return config;
}

function textEncode(value) {
  return new TextEncoder().encode(value);
}

function base64UrlFromBytes(bytes) {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) {
    binary += String.fromCharCode(view[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromString(value) {
  return base64UrlFromBytes(textEncode(value));
}

function truncateMiddle(value, keepStart, keepEnd) {
  if (value.length <= keepStart + keepEnd + 3) return value;
  return `${value.slice(0, keepStart)}...${value.slice(value.length - keepEnd)}`;
}

async function buildLaunchToken(config) {
  const header = { alg: "HS256", typ: "JWT" };
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    iss: config.iss,
    aud: "depositcloud",
    sub: config.sub,
    iat,
    exp: iat + 300,
    jti: crypto.randomUUID(),
  };
  if (config.email) payload.email = config.email;
  if (config.dob) payload.dob = config.dob;
  if (config.leaseId) payload.lease_id = config.leaseId;
  if (config.unitNumber) payload.unit_number = config.unitNumber;

  const encodedHeader = base64UrlFromString(JSON.stringify(header));
  const encodedPayload = base64UrlFromString(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    textEncode(config.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBytes = await crypto.subtle.sign("HMAC", key, textEncode(signingInput));
  const encodedSignature = base64UrlFromBytes(signatureBytes);

  return { token: `${signingInput}.${encodedSignature}`, payload };
}

function buildLaunchUrl(host, path, token) {
  const trimmedHost = host.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(trimmedHost + normalizedPath);
  url.searchParams.set("launch_token", token);
  return url.toString();
}

function pillMarkup(status) {
  const isDone = status === "done";
  return `${isDone ? CHECK_SVG : ""}${isDone ? "done" : "pending"}`;
}

function setPillState(id, status) {
  const pill = document.getElementById(id);
  if (!pill) return;
  pill.classList.toggle("pill-done", status === "done");
  pill.classList.toggle("pill-pending", status !== "done");
  pill.innerHTML = pillMarkup(status);
}

function loadDepositStatus() {
  const stored = readJsonStorage(DEPOSIT_STATUS_STORAGE_KEY);
  return stored && stored.status === "done" ? "done" : "pending";
}

function saveDepositStatus(status) {
  writeJsonStorage(DEPOSIT_STATUS_STORAGE_KEY, { status });
}

function renderDepositStatus(status) {
  setPillState("pill-deposit", status);
  const action = document.getElementById("deposit-action");
  if (!action) return;
  action.disabled = status === "done";
  action.textContent = status === "done" ? "Completed" : "Start deposit";
}

function setDepositStatus(status) {
  saveDepositStatus(status);
  renderDepositStatus(status);
}

function resetDemo() {
  removeStorage(DEPOSIT_STATUS_STORAGE_KEY);
  renderDepositStatus("pending");
  clearBanner();
  hideValidationMessage();
}

function showValidationMessage(message) {
  const el = document.getElementById("deposit-validation");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function hideValidationMessage() {
  const el = document.getElementById("deposit-validation");
  if (!el) return;
  el.hidden = true;
  el.textContent = "";
}

function showBanner(kind, message) {
  const region = document.getElementById("banner-region");
  if (!region) return;
  region.innerHTML = "";
  const banner = document.createElement("div");
  banner.className = `banner banner-${kind}`;
  banner.textContent = message;
  region.appendChild(banner);
}

function clearBanner() {
  const region = document.getElementById("banner-region");
  if (region) region.innerHTML = "";
}

function renderWhatWeSent(launchUrl, payload) {
  const urlEl = document.getElementById("sent-url");
  const payloadEl = document.getElementById("sent-payload");
  if (urlEl) {
    const parts = launchUrl.split("launch_token=");
    const truncatedToken = parts[1] ? truncateMiddle(parts[1], 24, 12) : "";
    urlEl.textContent = parts[1] ? `${parts[0]}launch_token=${truncatedToken}` : launchUrl;
    urlEl.dataset.fullValue = launchUrl;
  }
  if (payloadEl) {
    payloadEl.textContent = JSON.stringify(payload, null, 2);
    payloadEl.dataset.fullValue = JSON.stringify(payload, null, 2);
  }
}

function bindCopyButtons() {
  document.querySelectorAll(".copy-button").forEach((button) => {
    button.addEventListener("click", async () => {
      const targetId = button.dataset.copyTarget;
      const target = targetId ? document.getElementById(targetId) : null;
      if (!target) return;
      const value = target.dataset.fullValue || target.textContent;
      try {
        await navigator.clipboard.writeText(value);
        const original = button.textContent;
        button.textContent = "Copied";
        setTimeout(() => {
          button.textContent = original;
        }, 1200);
      } catch (err) {
        return;
      }
    });
  });
}

function getModalElements() {
  return {
    overlay: document.getElementById("modal-overlay"),
    iframe: document.getElementById("enrollment-frame"),
  };
}

function openModal(launchUrl) {
  const { overlay, iframe } = getModalElements();
  if (!overlay || !iframe) return;
  state.resultHandled = false;
  overlay.hidden = false;
  iframe.src = launchUrl;
  document.addEventListener("keydown", handleModalKeydown);
}

function hideModal() {
  const { overlay, iframe } = getModalElements();
  if (overlay) overlay.hidden = true;
  if (iframe) iframe.src = "about:blank";
  document.removeEventListener("keydown", handleModalKeydown);
}

function closeModalManually() {
  if (!state.resultHandled) {
    showBanner("neutral", "Deposit step left pending; the resident can resume later.");
  }
  hideModal();
}

function handleModalKeydown(event) {
  if (event.key === "Escape") closeModalManually();
}

function handleEnrollmentResult(result) {
  if (state.resultHandled) return;
  state.resultHandled = true;
  hideModal();
  const status = result && result.status;
  const account = result && result.dc_account;
  const reason = result && result.reason;
  if (status === "success") {
    setDepositStatus("done");
    showBanner("success", `Deposit completed. Account ${account || "unknown"}.`);
  } else if (status === "failed") {
    showBanner("failed", `We could not complete the deposit step${reason ? ` (${reason})` : ""}.`);
  } else {
    showBanner("neutral", "Deposit step left pending; the resident can resume later.");
  }
}

function tryReadFramedReturnParams(iframe) {
  try {
    const href = iframe.contentWindow.location.href;
    const url = new URL(href);
    if (!url.pathname.endsWith("return.html")) return null;
    return {
      status: url.searchParams.get("status"),
      dc_account: url.searchParams.get("dc_account"),
      reason: url.searchParams.get("reason"),
    };
  } catch (err) {
    return null;
  }
}

function bindIframeLoadDetection() {
  const { iframe } = getModalElements();
  if (!iframe) return;
  iframe.addEventListener("load", () => {
    const result = tryReadFramedReturnParams(iframe);
    if (result) handleEnrollmentResult(result);
  });
}

function bindPostMessageDetection() {
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data.type !== "dc:enrollment") return;
    handleEnrollmentResult(event.data);
  });
}

async function launchDeposit() {
  hideValidationMessage();
  const config = collectConfig();
  if (!config.sub || !config.secret) {
    showValidationMessage("Resident sub (PMS resident id) and signing secret are required.");
    return;
  }
  const { token, payload } = await buildLaunchToken(config);
  const launchUrl = buildLaunchUrl(config.host, config.path, token);
  renderWhatWeSent(launchUrl, payload);
  openModal(launchUrl);
}

function bindStaticEventHandlers() {
  const depositAction = document.getElementById("deposit-action");
  if (depositAction) {
    depositAction.addEventListener("click", () => {
      launchDeposit().catch(() => {
        showValidationMessage("Could not build the launch token. Check the console for details.");
      });
    });
  }

  const closeButton = document.getElementById("modal-close");
  if (closeButton) closeButton.addEventListener("click", closeModalManually);

  const overlay = document.getElementById("modal-overlay");
  if (overlay) {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeModalManually();
    });
  }

  const resetLink = document.getElementById("reset-demo");
  if (resetLink) resetLink.addEventListener("click", resetDemo);
}

function renderStaticChecklistPills() {
  setPillState("pill-electricity", "done");
  setPillState("pill-internet", "done");
  setPillState("pill-insurance", "pending");
  setPillState("pill-keys", "pending");
}

function init() {
  const config = loadConfig();
  populateConfigForm(config);
  bindConfigPersistence();
  bindStaticEventHandlers();
  bindCopyButtons();
  bindIframeLoadDetection();
  bindPostMessageDetection();
  renderStaticChecklistPills();
  renderDepositStatus(loadDepositStatus());
}

document.addEventListener("DOMContentLoaded", init);
