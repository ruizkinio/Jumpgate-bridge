(function () {
  "use strict";
  const storageKey = "jumpgate.release-validation.activation.v1";
  const bootstrap = JSON.parse(document.getElementById("jumpgate-uat-bootstrap").textContent || "{}");
  const pairCode = document.getElementById("pairCode");
  const button = document.getElementById("activateBtn");
  const status = document.getElementById("status");

  function compact(value) {
    return String(value || "").toUpperCase().replace(/[\s-]/g, "");
  }

  function token() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    try {
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } finally {
      bytes.fill(0);
    }
  }

  function attempt(code) {
    let current = null;
    try {
      current = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    } catch (_error) {}
    if (
      current &&
      current.code === code &&
      typeof current.config === "string" &&
      /^[A-Za-z0-9_-]{16,4096}$/.test(current.config) &&
      typeof current.retryToken === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(current.retryToken)
    ) {
      return current;
    }
    current = { code, config: bootstrap.config, retryToken: token() };
    sessionStorage.setItem(storageKey, JSON.stringify(current));
    return current;
  }

  async function activate() {
    const code = compact(pairCode.value);
    if (!/^[A-Z2-9]{8}$/.test(code)) {
      status.textContent = "Enter the eight-character code shown by Jumpgate.";
      return;
    }
    button.disabled = true;
    status.textContent = "Activating the synthetic validation profile...";
    try {
      const current = attempt(code);
      const response = await fetch("/pair/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          userCode: current.code,
          config: current.config,
          activationRetryToken: current.retryToken,
        }),
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(body.error || "Activation failed");
      sessionStorage.removeItem(storageKey);
      status.textContent = "Activated. Return to Jumpgate and observe the selected scenario.";
    } catch (error) {
      status.textContent = error && error.message ? error.message : "Activation failed";
    } finally {
      button.disabled = false;
    }
  }

  button.addEventListener("click", activate);
})();
