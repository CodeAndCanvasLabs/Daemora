(function() {
  if (document.getElementById('daemora-splash')) return;

  var splash = document.createElement('div');
  splash.id = 'daemora-splash';
  splash.innerHTML = '<div id="daemora-splash-inner" style="display:flex;flex-direction:column;align-items:center;gap:16px">'
    + '<svg width="64" height="64" viewBox="0 0 64 64" fill="none">'
    + '<circle cx="32" cy="32" r="28" stroke="#00d9ff" stroke-width="2" opacity="0.6"/>'
    + '<circle cx="32" cy="32" r="18" stroke="#4ECDC4" stroke-width="1.5" opacity="0.3"/>'
    + '<circle cx="32" cy="32" r="6" fill="#00d9ff" opacity="0.8">'
    + '<animate attributeName="r" values="6;8;6" dur="2s" repeatCount="indefinite"/>'
    + '<animate attributeName="opacity" values="0.8;0.4;0.8" dur="2s" repeatCount="indefinite"/>'
    + '</circle></svg>'
    + '<div style="font-size:24px;font-weight:700;letter-spacing:2px;background:linear-gradient(135deg,#00d9ff,#4ECDC4);-webkit-background-clip:text;-webkit-text-fill-color:transparent">DAEMORA</div>'
    + '<div id="daemora-splash-spinner" style="display:flex;gap:6px;margin-top:8px">'
    + '<span style="width:6px;height:6px;border-radius:50%;background:#00d9ff;animation:pulse 1.4s ease-in-out infinite"></span>'
    + '<span style="width:6px;height:6px;border-radius:50%;background:#00d9ff;animation:pulse 1.4s ease-in-out 0.2s infinite"></span>'
    + '<span style="width:6px;height:6px;border-radius:50%;background:#00d9ff;animation:pulse 1.4s ease-in-out 0.4s infinite"></span>'
    + '</div>'
    + '<div id="daemora-splash-status" style="font-size:12px;color:#4a5568;letter-spacing:1px;font-family:monospace">Starting services...</div>'
    + '<div id="daemora-vault-form" style="display:none;margin-top:12px;text-align:center">'
    + '<div style="font-size:13px;color:#8899aa;margin-bottom:12px">Vault detected. Enter passphrase to unlock.</div>'
    + '<form id="daemora-vault-submit" style="display:flex;gap:8px;align-items:center">'
    + '<input id="daemora-vault-input" type="password" placeholder="Vault passphrase" autocomplete="off" '
    + 'style="padding:10px 16px;background:#131b2e;border:1px solid #1e2d45;border-radius:8px;color:#e2e8f0;font-size:14px;width:260px;outline:none;font-family:monospace;transition:border-color 0.2s" />'
    + '<button type="submit" id="daemora-vault-btn" style="padding:10px 24px;background:linear-gradient(135deg,#00d9ff,#4ECDC4);color:#0a0f1a;border:none;border-radius:8px;cursor:pointer;font-weight:700;font-size:14px;letter-spacing:0.5px;white-space:nowrap">Unlock</button>'
    + '</form>'
    + '<div id="daemora-vault-error" style="font-size:11px;color:#ff4444;margin-top:8px;display:none"></div>'
    + '<button id="daemora-skip-vault" style="margin-top:12px;background:none;border:none;color:#4a5568;font-size:11px;cursor:pointer;text-decoration:underline">Skip (start without vault secrets)</button>'
    + '</div>'
    + '</div>';
  splash.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#0a0f1a;font-family:-apple-system,BlinkMacSystemFont,sans-serif';

  var style = document.createElement('style');
  style.textContent = '@keyframes pulse{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}} #daemora-vault-input:focus{border-color:#00d9ff;box-shadow:0 0 0 2px rgba(0,217,255,0.15)}';
  document.head.appendChild(style);
  document.body.appendChild(splash);

  // Show passphrase form (called from Rust when vault is detected)
  window.__daemora_show_passphrase = function() {
    var spinner = document.getElementById('daemora-splash-spinner');
    var status = document.getElementById('daemora-splash-status');
    var form = document.getElementById('daemora-vault-form');
    if (spinner) spinner.style.display = 'none';
    if (status) status.style.display = 'none';
    if (form) form.style.display = 'block';
    var input = document.getElementById('daemora-vault-input');
    if (input) setTimeout(function() { input.focus(); }, 100);
  };

  // Handle vault form submission
  setTimeout(function() {
    var form = document.getElementById('daemora-vault-submit');
    if (form) {
      form.addEventListener('submit', function(e) {
        e.preventDefault();
        var input = document.getElementById('daemora-vault-input');
        var btn = document.getElementById('daemora-vault-btn');
        var errEl = document.getElementById('daemora-vault-error');
        var passphrase = input ? input.value : '';
        if (!passphrase) return;

        if (btn) { btn.textContent = 'Unlocking...'; btn.disabled = true; }
        if (errEl) errEl.style.display = 'none';

        // Call Tauri IPC
        if (window.__TAURI_INTERNALS__) {
          window.__TAURI_INTERNALS__.invoke('submit_passphrase', { passphrase: passphrase })
            .then(function() { /* reload happens from Rust */ })
            .catch(function(err) {
              if (btn) { btn.textContent = 'Unlock'; btn.disabled = false; }
              if (errEl) { errEl.textContent = String(err); errEl.style.display = 'block'; }
            });
        }
      });
    }

    var skipBtn = document.getElementById('daemora-skip-vault');
    if (skipBtn) {
      skipBtn.addEventListener('click', function() {
        var status = document.getElementById('daemora-splash-status');
        var form = document.getElementById('daemora-vault-form');
        var spinner = document.getElementById('daemora-splash-spinner');
        if (form) form.style.display = 'none';
        if (status) { status.style.display = 'block'; status.textContent = 'Starting without vault...'; }
        if (!spinner) {
          var s = document.createElement('div');
          s.id = 'daemora-splash-spinner';
          s.style.cssText = 'display:flex;gap:6px;margin-top:8px';
          s.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:#00d9ff;animation:pulse 1.4s ease-in-out infinite"></span>'
            + '<span style="width:6px;height:6px;border-radius:50%;background:#00d9ff;animation:pulse 1.4s ease-in-out 0.2s infinite"></span>'
            + '<span style="width:6px;height:6px;border-radius:50%;background:#00d9ff;animation:pulse 1.4s ease-in-out 0.4s infinite"></span>';
          document.getElementById('daemora-splash-inner').insertBefore(s, status);
        }

        if (window.__TAURI_INTERNALS__) {
          window.__TAURI_INTERNALS__.invoke('start_without_vault')
            .catch(function(err) {
              if (status) { status.textContent = 'Failed: ' + err; status.style.color = '#ff4444'; }
            });
        }
      });
    }
  }, 50);
})();
